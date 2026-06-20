/**
 * Tax (GST/VAT/BAS) returns.
 *
 * `prepare` computes a period's return from the ledger (reusing the Tax Summary):
 * output tax collected, input tax paid, and the net payable/refundable.
 * `file` records that return permanently and LOCKS the period (advances the
 * lock date to the period end) so already-submitted figures can't be altered.
 * Unfiling the most recent return rolls the lock back.
 *
 * Net convention: collected − paid. Positive = payable to the tax authority;
 * negative = refundable to you. Computed on the accrual basis (authorised
 * documents by date), matching the Tax Summary report.
 */
import { getDb } from '../db';
import { assertValidDate, assertDateUnlocked, systemAccount, postJournal } from '../engine';
import { taxSummary } from './reports';
import { getOrganisation, setLockDate } from './settings';

export function prepare(params: { from: string; to: string }) {
  assertValidDate(params.from, 'From date');
  assertValidDate(params.to, 'To date');
  if (params.to < params.from) throw new Error('The period end can’t be before its start');
  const s: any = taxSummary({ from: params.from, to: params.to });
  const collected = s.tax_collected ?? 0;
  const paid = s.tax_paid ?? 0;
  const net = collected - paid;
  const filed = getDb().prepare(
    'SELECT * FROM tax_returns WHERE period_from = ? AND period_to = ? ORDER BY id DESC LIMIT 1'
  ).get(params.from, params.to);
  return {
    from: params.from, to: params.to, basis: 'ACCRUAL',
    collected, paid, net,
    payable: net > 0 ? net : 0,
    refundable: net < 0 ? -net : 0,
    by_rate: s.by_rate ?? [],
    already_filed: !!filed,
    filed: filed ?? null,
  };
}

export function list() {
  return getDb().prepare('SELECT * FROM tax_returns ORDER BY period_to DESC, id DESC').all();
}

export function get(id: number) {
  const r = getDb().prepare('SELECT * FROM tax_returns WHERE id = ?').get(id);
  if (!r) throw new Error('Tax return not found');
  return r;
}

/** File a return: store the figures and lock the period (advancing the lock date). */
export function file(input: { from: string; to: string; note?: string }, user_id = 1) {
  const db = getDb();
  const p = prepare({ from: input.from, to: input.to });
  return db.transaction(() => {
    const id = Number(db.prepare(
      `INSERT INTO tax_returns (period_from, period_to, basis, collected, paid, net, note)
       VALUES (?,?,?,?,?,?,?)`
    ).run(input.from, input.to, 'ACCRUAL', p.collected, p.paid, p.net, input.note ?? null).lastInsertRowid);

    // Lock the period: advance the lock date to the period end if it's later.
    const org: any = getOrganisation();
    const current = org.lock_date ?? null;
    if (!current || input.to > current) {
      setLockDate(input.to, org.adviser_lock_date ?? null, user_id);
    }
    return get(id);
  });
}

/**
 * Remove a filed return (for an amendment). Rolls the lock date back to the
 * latest remaining filed return's period end (or clears it if none remain),
 * so the period can be corrected and re-filed.
 */
export function unfile(id: number, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const r: any = db.prepare('SELECT * FROM tax_returns WHERE id = ?').get(id);
    if (!r) throw new Error('Tax return not found');
    db.prepare('DELETE FROM tax_returns WHERE id = ?').run(id);

    const latest: any = db.prepare('SELECT MAX(period_to) AS d FROM tax_returns').get();
    const org: any = getOrganisation();
    // Only lower the lock if it was sitting at/after this return's period end.
    if ((org.lock_date ?? '') >= r.period_to) {
      setLockDate(latest?.d ?? null, org.adviser_lock_date ?? null, user_id);
    }
    return { ok: true };
  });
}

/**
 * Record settling the net GST/VAT with the tax authority against a bank account.
 * A payment reduces the GST liability (Dr GST / Cr Bank); a refund increases the
 * bank (Dr Bank / Cr GST). Optionally linked to a filed return via return_id.
 * Date it on/after the period end (the lock won't allow posting inside a filed
 * period, which is correct — you pay after the period closes).
 */
export function recordPayment(input: { date: string; bank_account_id: number; amount: number; direction?: 'PAYMENT' | 'REFUND'; reference?: string; return_id?: number }, user_id = 1) {
  const db = getDb();
  assertValidDate(input.date, 'Payment date');
  assertDateUnlocked(input.date);
  if (!(input.amount > 0)) throw new Error('Enter the amount settled');
  const bank: any = db.prepare('SELECT id FROM accounts WHERE id = ?').get(input.bank_account_id);
  if (!bank) throw new Error('Bank account not found');
  const gst = systemAccount('GST');
  const direction = input.direction ?? 'PAYMENT';
  const lines = direction === 'REFUND'
    ? [{ account_id: input.bank_account_id, debit: input.amount, description: 'GST/VAT refund received' }, { account_id: gst, credit: input.amount, description: 'GST/VAT refund' }]
    : [{ account_id: gst, debit: input.amount, description: 'GST/VAT settled' }, { account_id: input.bank_account_id, credit: input.amount, description: 'GST/VAT payment' }];
  const jid = postJournal({
    date: input.date,
    narration: direction === 'REFUND' ? 'GST/VAT refund from tax authority' : 'GST/VAT payment to tax authority',
    source_type: 'GST_PAYMENT',
    source_id: input.return_id ?? 0,
    lines,
    user_id,
  });
  return { ok: true, journal_id: jid, direction, amount: input.amount };
}

/** Recorded GST/VAT payments and refunds (most recent first), for display. */
export function gstPayments() {
  return getDb().prepare(
    `SELECT j.id, j.date, j.narration, j.source_id AS return_id,
            (SELECT COALESCE(SUM(jl.debit + jl.credit),0) FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.journal_id=j.id AND a.is_bank_account=1) AS amount,
            (SELECT a.name FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.journal_id=j.id AND a.is_bank_account=1 LIMIT 1) AS bank_name,
            CASE WHEN EXISTS (SELECT 1 FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.journal_id=j.id AND a.is_bank_account=1 AND jl.debit > 0) THEN 'REFUND' ELSE 'PAYMENT' END AS direction
       FROM journals j
      WHERE j.source_type='GST_PAYMENT' AND j.status='POSTED' AND j.reverses_journal_id IS NULL
      ORDER BY j.date DESC, j.id DESC`
  ).all();
}
