/**
 * Payments & allocation (spec §5.7, §12.2).
 * One payment can be split across many invoices. If a foreign-currency
 * invoice settles at a different rate than it was raised, the base-currency
 * difference posts to the Realised Currency Gains account.
 */
import { getDb } from '../db';
import { postJournal, voidJournalsForSource, audit, systemAccount, PostingError, baseCurrency, assertValidDate, assertDateUnlocked } from '../engine';
import { toBase } from '../money';
import * as invoices from './invoices';

export interface PaymentInput {
  type: 'RECEIVE' | 'SPEND';
  date: string;
  bank_account_id: number;
  contact_id?: number;
  amount: number; // cents, payment currency
  currency_code?: string;
  exchange_rate?: number;
  reference?: string;
  payment_method?: string;
  cheque_number?: string;
  // Cross-currency settlement: when the bank account's currency differs from the
  // document currency, `bank_amount` is what actually moved through the bank, in
  // the bank's own currency (cents), and `bank_rate` converts it to base. The
  // allocations below stay in each document's own currency.
  bank_amount?: number;
  bank_rate?: number;
  allocations: Array<{ invoice_id: number; amount: number }>; // cents, payment currency
}

export function create(input: PaymentInput, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    assertValidDate(input.date, 'Payment date');
    assertDateUnlocked(input.date);
    const cross = input.bank_amount != null;
    if (cross && !(input.bank_amount! > 0)) throw new PostingError('Enter the amount that moved through the bank');
    if (!cross && !(input.amount > 0)) throw new PostingError('A payment amount must be greater than zero');
    const allocations = input.allocations ?? [];
    const allocated = allocations.reduce((s, a) => s + a.amount, 0);
    let onAccount = 0;
    if (cross) {
      // The bank moves in its own currency; allocations settle the documents.
      // Money-on-account isn't supported for cross-currency payments.
      if (!allocations.length) throw new PostingError('A cross-currency payment must be allocated to at least one document');
    } else {
      if (allocated > input.amount) throw new PostingError('Allocations cannot exceed the payment amount');
      onAccount = input.amount - allocated; // remainder banked to the contact's prepayment
      if (onAccount > 0 && !input.contact_id) throw new PostingError('Money on account needs a contact, so it can be applied to an invoice later');
      if (allocated === 0 && onAccount === 0) throw new PostingError('A payment needs an allocation or an on-account amount');
    }

    const rate = input.exchange_rate ?? 1;
    const isReceive = input.type === 'RECEIVE';
    const control = systemAccount(isReceive ? 'AR' : 'AP');

    // Validate targets + compute realised FX per allocation
    let fxGain = 0; // base cents; positive = gain
    let controlBase = 0;
    for (const a of allocations) {
      const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(a.invoice_id);
      if (!inv) throw new PostingError(`Invoice ${a.invoice_id} not found`);
      const expectType = isReceive ? 'ACCREC' : 'ACCPAY';
      if (inv.type !== expectType) throw new PostingError(`Payment type does not match document ${inv.invoice_number}`);
      if (inv.status !== 'AUTHORISED') throw new PostingError(`${inv.invoice_number} is not awaiting payment`);
      // In single-currency mode the payment and the document must share a
      // currency, otherwise the control relief (at the invoice rate) and the
      // bank movement (at the payment rate) describe different currencies and
      // the realised-FX plug is meaningless. Cross-currency settlement (with a
      // bank_amount) is the supported path for differing currencies.
      if (!cross && (inv.currency_code ?? baseCurrency()) !== (input.currency_code ?? baseCurrency())) {
        throw new PostingError(`${inv.invoice_number} is in ${inv.currency_code ?? baseCurrency()} but the payment is in ${input.currency_code ?? baseCurrency()}; use a cross-currency payment (enter the bank amount that moved).`);
      }
      if (a.amount <= 0 || a.amount > inv.amount_due) throw new PostingError(`Allocation exceeds amount due on ${inv.invoice_number}`);
      // Control account is relieved at the invoice's original rate
      const baseAtInvoiceRate = toBase(a.amount, inv.exchange_rate ?? 1);
      controlBase += baseAtInvoiceRate;
      const baseAtPaymentRate = toBase(a.amount, rate);
      // Receivable: paid worth more than booked = gain. Payable: opposite.
      // In cross-currency mode the FX is derived from the bank side instead.
      if (!cross) fxGain += isReceive ? baseAtPaymentRate - baseAtInvoiceRate : baseAtInvoiceRate - baseAtPaymentRate;
    }

    const bankRate = input.bank_rate ?? rate; // bank currency → base
    const bankBase = cross ? toBase(input.bank_amount!, bankRate) : toBase(input.amount, rate);
    const onAccountBase = cross ? 0 : toBase(onAccount, rate);
    // Cross-currency: the bank moved its own amount; the residual vs the relieved
    // control balance is the realised FX gain/loss.
    if (cross) fxGain = isReceive ? bankBase - controlBase : controlBase - bankBase;
    const prepayAcct = onAccountBase > 0 ? systemAccount(isReceive ? 'CUSTOMER_PREPAYMENT' : 'SUPPLIER_PREPAYMENT') : 0;
    const fxAccount = systemAccount('REALISED_FX');
    const lines: any[] = [];
    if (isReceive) {
      lines.push({ account_id: input.bank_account_id, debit: bankBase, description: input.reference, contact_id: input.contact_id });
      if (controlBase > 0) lines.push({ account_id: control, credit: controlBase, description: 'Payment received', contact_id: input.contact_id });
      if (onAccountBase > 0) lines.push({ account_id: prepayAcct, credit: onAccountBase, description: 'Received on account', contact_id: input.contact_id });
    } else {
      if (controlBase > 0) lines.push({ account_id: control, debit: controlBase, description: 'Payment made', contact_id: input.contact_id });
      if (onAccountBase > 0) lines.push({ account_id: prepayAcct, debit: onAccountBase, description: 'Paid on account', contact_id: input.contact_id });
      lines.push({ account_id: input.bank_account_id, credit: bankBase, description: input.reference, contact_id: input.contact_id });
    }
    if (fxGain !== 0) {
      // gain → credit FX account; loss → debit
      lines.push(fxGain > 0 ? { account_id: fxAccount, credit: fxGain, description: 'Realised currency gain' } : { account_id: fxAccount, debit: -fxGain, description: 'Realised currency loss' });
    }

    // FX rounding residual: the bank amount is converted once while each
    // allocation's control relief is converted separately, so the two sides can
    // differ by a cent or two on a multi-allocation foreign payment. Absorb it
    // into the Rounding account so the journal balances (no-op in base currency).
    const imbalance = lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
    if (imbalance !== 0) {
      const rounding = systemAccount('ROUNDING');
      lines.push(imbalance > 0
        ? { account_id: rounding, credit: imbalance, description: 'Foreign exchange rounding' }
        : { account_id: rounding, debit: -imbalance, description: 'Foreign exchange rounding' });
    }

    const bankCurrency = cross
      ? ((db.prepare('SELECT bank_currency FROM accounts WHERE id = ?').get(input.bank_account_id) as any)?.bank_currency ?? baseCurrency())
      : (input.currency_code ?? baseCurrency());
    const recordAmount = cross ? input.bank_amount! : input.amount;
    const recordRate = cross ? bankRate : rate;
    const pid = Number(
      db.prepare(`INSERT INTO payments (type, date, bank_account_id, contact_id, amount, currency_code, exchange_rate, reference, payment_method, cheque_number, status)
        VALUES (?,?,?,?,?,?,?,?,?,?, 'POSTED')`)
        .run(input.type, input.date, input.bank_account_id, input.contact_id ?? null, recordAmount,
          bankCurrency, recordRate, input.reference ?? null, input.payment_method ?? null, input.cheque_number ?? null).lastInsertRowid
    );
    const jid = postJournal({
      date: input.date,
      narration: `${isReceive ? 'Payment received' : 'Payment made'}${input.reference ? ' — ' + input.reference : ''}`,
      source_type: 'PAYMENT', source_id: pid,
      currency_code: input.currency_code, exchange_rate: rate,
      lines, user_id,
    });
    db.prepare('UPDATE payments SET journal_id = ? WHERE id = ?').run(jid, pid);

    const ins = db.prepare('INSERT INTO payment_allocations (payment_id, invoice_id, amount) VALUES (?,?,?)');
    for (const a of allocations) {
      ins.run(pid, a.invoice_id, a.amount);
      invoices.refreshPaidStatus(a.invoice_id);
    }
    audit('payment', pid, 'CREATE', null, { amount: input.amount, allocations: allocations.length, on_account: onAccount }, user_id);
    return get(pid);
  });
}

/**
 * Available money on account for a contact, in base cents. Customer prepayments
 * are a liability (credit balance available to apply); supplier prepayments are
 * an asset (debit balance available).
 */
export function prepaymentBalance(contact_id: number, side: 'CUSTOMER' | 'SUPPLIER') {
  const db = getDb();
  const acct = systemAccount(side === 'CUSTOMER' ? 'CUSTOMER_PREPAYMENT' : 'SUPPLIER_PREPAYMENT');
  const r: any = db.prepare(
    `SELECT COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
      WHERE j.status='POSTED' AND jl.account_id = ? AND jl.contact_id = ?`
  ).get(acct, contact_id);
  return side === 'CUSTOMER' ? r.cr - r.dr : r.dr - r.cr;
}

/** Prepayment balances for every contact that currently has money on account. */
export function prepaymentBalances(side: 'CUSTOMER' | 'SUPPLIER') {
  const db = getDb();
  const acct = systemAccount(side === 'CUSTOMER' ? 'CUSTOMER_PREPAYMENT' : 'SUPPLIER_PREPAYMENT');
  const rows = db.prepare(
    `SELECT jl.contact_id, c.name AS contact_name,
            COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
       JOIN contacts c ON c.id = jl.contact_id
      WHERE j.status='POSTED' AND jl.account_id = ? AND jl.contact_id IS NOT NULL
      GROUP BY jl.contact_id`
  ).all(acct) as any[];
  return rows
    .map((r) => ({ contact_id: r.contact_id, contact_name: r.contact_name, balance: side === 'CUSTOMER' ? r.cr - r.dr : r.dr - r.cr }))
    .filter((r) => r.balance > 0)
    .sort((a, b) => b.balance - a.balance);
}

/**
 * Apply a contact's money on account to one of their outstanding documents.
 * Reuses the payment machinery, with the prepayment account as the funding
 * source: a customer prepayment relieves the receivable (Dr Customer
 * prepayments / Cr AR); a supplier prepayment relieves the payable. Base
 * currency only for now.
 */
export function applyPrepayment(input: { contact_id: number; invoice_id: number; amount: number; date: string; reference?: string }, user_id = 1) {
  const db = getDb();
  const inv: any = db.prepare('SELECT * FROM invoices WHERE id = ?').get(input.invoice_id);
  if (!inv) throw new PostingError('Document not found');
  if (inv.type !== 'ACCREC' && inv.type !== 'ACCPAY') throw new PostingError('Prepayments apply to invoices and bills');
  if ((inv.currency_code ?? baseCurrency()) !== baseCurrency()) throw new PostingError('Applying a prepayment to a foreign-currency document isn’t supported yet');
  if (inv.contact_id !== input.contact_id) throw new PostingError('That document belongs to a different contact');
  if (!(input.amount > 0)) throw new PostingError('Enter an amount to apply');

  const side = inv.type === 'ACCREC' ? 'CUSTOMER' : 'SUPPLIER';
  const available = prepaymentBalance(input.contact_id, side);
  if (input.amount > available) throw new PostingError(`Only ${available / 100} is available on account for this contact`);

  const prepayAcct = systemAccount(side === 'CUSTOMER' ? 'CUSTOMER_PREPAYMENT' : 'SUPPLIER_PREPAYMENT');
  // Reuse create(): a RECEIVE funded by the customer-prepayment account posts
  // Dr Customer prepayments / Cr AR; a SPEND from supplier-prepayments posts
  // Dr AP / Cr Supplier prepayments. Both relieve the document.
  return create({
    type: inv.type === 'ACCREC' ? 'RECEIVE' : 'SPEND',
    date: input.date,
    bank_account_id: prepayAcct,
    contact_id: input.contact_id,
    amount: input.amount,
    reference: input.reference ?? 'Prepayment applied',
    allocations: [{ invoice_id: input.invoice_id, amount: input.amount }],
  }, user_id);
}

export function get(id: number) {
  const db = getDb();
  const p = db.prepare(`SELECT p.*, c.name AS contact_name, a.name AS bank_name FROM payments p
    LEFT JOIN contacts c ON c.id = p.contact_id JOIN accounts a ON a.id = p.bank_account_id WHERE p.id = ?`).get(id);
  if (p) p.allocations = db.prepare(`SELECT pa.*, i.invoice_number FROM payment_allocations pa JOIN invoices i ON i.id = pa.invoice_id WHERE pa.payment_id = ?`).all(id);
  return p;
}

export function remove(id: number, user_id = 1) {
  const db = getDb();
  db.transaction(() => {
    const p = get(id);
    if (!p) throw new Error('Payment not found');
    if (p.status !== 'POSTED') throw new Error('Payment already removed');
    // Removing posts a reversing journal — respect the period lock.
    assertDateUnlocked(p.date);
    // If the bank statement line was reconciled to this payment, unreconcile it.
    db.prepare(`UPDATE bank_statement_lines SET status='UNRECONCILED', reconciled_source_type=NULL, reconciled_source_id=NULL WHERE reconciled_source_type='PAYMENT' AND reconciled_source_id=?`).run(id);
    voidJournalsForSource('PAYMENT', id, user_id);
    db.prepare("UPDATE payments SET status='DELETED' WHERE id = ?").run(id);
    for (const a of p.allocations) invoices.refreshPaidStatus(a.invoice_id);
    audit('payment', id, 'DELETE', p, null, user_id);
  });
}

/** Batch-pay several bills from one bank account in one bank movement (spec §6.4). */
export function batchPay(input: { date: string; bank_account_id: number; reference?: string; bills: Array<{ invoice_id: number; amount: number }> }, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const total = input.bills.reduce((s, b) => s + b.amount, 0);
    const batchId = Number(db.prepare(`INSERT INTO payment_batches (date, bank_account_id, reference, total, type) VALUES (?,?,?,?, 'BATCH_PAY')`)
      .run(input.date, input.bank_account_id, input.reference ?? null, total).lastInsertRowid);
    const created: number[] = [];
    for (const b of input.bills) {
      const inv = db.prepare('SELECT contact_id FROM invoices WHERE id = ?').get(b.invoice_id);
      const p = create({
        type: 'SPEND', date: input.date, bank_account_id: input.bank_account_id,
        contact_id: inv?.contact_id, amount: b.amount, reference: input.reference ?? 'Batch payment',
        allocations: [{ invoice_id: b.invoice_id, amount: b.amount }],
      }, user_id);
      db.prepare('UPDATE payments SET batch_id = ? WHERE id = ?').run(batchId, p.id);
      created.push(p.id);
    }
    return { batchId, payments: created, total };
  });
}
