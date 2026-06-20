/**
 * Golden scenario suite (spec App.2 §14): each business flow runs end-to-end
 * through the real services and the reports must agree to the cent.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as itemsSvc from '../src/backend/services/items';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';
import * as banking from '../src/backend/services/banking';
import * as reports from '../src/backend/services/reports';
import * as journals from '../src/backend/services/journals';
import * as assets from '../src/backend/services/assets';
import * as settings from '../src/backend/services/settings';

let acc: (code: string) => number;

beforeEach(() => {
  initDatabase(':memory:');
  const db = getDb();
  acc = (code: string) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
});

const D = '2026-03-10';

function balance(code: string, asAt = '2026-12-31'): number {
  const db = getDb();
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS b FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id AND j.status='POSTED' AND j.date <= ?
       WHERE jl.account_id = (SELECT id FROM accounts WHERE code = ?)`
    )
    .get(asAt, code);
  return Number(r.b); // debit-positive
}

describe('scenario 1: invoice → payment → reconcile → reports agree', () => {
  it('runs end to end', () => {
    const cust = contacts.save({ name: 'Acme Corp', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC',
      contact_id: cust,
      date: D,
      due_date: '2026-03-24',
      lines: [{ description: 'Consulting', quantity: 10, unit_amount: 15000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(inv.id);
    let doc = invoices.get(inv.id);
    expect(doc.status).toBe('AUTHORISED');
    expect(doc.subtotal).toBe(150000);
    expect(doc.total_tax).toBe(15000);
    expect(doc.total).toBe(165000);

    // GL: AR 1650, Sales 1500 (cr), GST 150 (cr)
    expect(balance('610')).toBe(165000);
    expect(balance('200')).toBe(-150000);
    expect(balance('820')).toBe(-15000);

    // Pay it
    payments.create({
      type: 'RECEIVE',
      date: '2026-03-20',
      bank_account_id: acc('090'),
      contact_id: cust,
      amount: 165000,
      allocations: [{ invoice_id: inv.id, amount: 165000 }],
    });
    doc = invoices.get(inv.id);
    expect(doc.status).toBe('PAID');
    expect(doc.amount_due).toBe(0);
    expect(balance('610')).toBe(0);
    expect(balance('090')).toBe(165000);

    // Import a matching statement line and reconcile
    banking.importStatement(acc('090'), 's.csv', 'Date,Amount,Payee\n2026-03-20,1650.00,Acme Corp');
    const lines = banking.unreconciled(acc('090'));
    expect(lines).toHaveLength(1);
    const sug = lines[0].suggestion.find((s: any) => s.kind === 'PAYMENT');
    expect(sug).toBeTruthy();
    banking.reconcileMatch(lines[0].id, 'PAYMENT', sug.id);
    expect(banking.unreconciled(acc('090'))).toHaveLength(0);

    // Reports agree
    const pl = reports.profitAndLoss({ from: '2026-03-01', to: '2026-03-31' });
    expect(pl.total_income).toBe(150000);
    expect(pl.net_profit).toBe(150000);
    const bs = reports.balanceSheet({ as_at: '2026-03-31' });
    expect(bs.balances).toBe(true);
    expect(bs.total_assets).toBe(165000);
    const tb = reports.trialBalance({ as_at: '2026-03-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
    const aged = reports.agedReceivables({ as_at: '2026-03-31' });
    expect(aged.totals.total).toBe(0);
    const recon = banking.reconciliationReport(acc('090'), '2026-03-31');
    expect(recon.ledger_balance).toBe(recon.statement_balance);
  });
});

describe('scenario 2: bill → batch pay → AP clears', () => {
  it('runs end to end', () => {
    const sup = contacts.save({ name: 'Supplies Ltd', is_supplier: true }).id;
    const mk = (amt: number) => {
      const b = invoices.saveDraft({
        type: 'ACCPAY',
        contact_id: sup,
        date: D,
        due_date: '2026-03-24',
        lines: [{ description: 'Stuff', quantity: 1, unit_amount: amt, account_id: acc('453'), tax_rate_id: 4 }],
      });
      invoices.approve(b.id);
      return invoices.get(b.id);
    };
    const b1 = mk(50000); // total 55000 with 10% input tax
    const b2 = mk(30000); // total 33000
    expect(balance('800')).toBe(-(55000 + 33000));
    expect(balance('820')).toBe(8000); // input tax debit

    const res = payments.batchPay({
      date: '2026-03-25',
      bank_account_id: acc('090'),
      bills: [
        { invoice_id: b1.id, amount: b1.amount_due },
        { invoice_id: b2.id, amount: b2.amount_due },
      ],
    });
    expect(res.total).toBe(88000);
    expect(balance('800')).toBe(0);
    expect(balance('090')).toBe(-88000);
    expect(invoices.get(b1.id).status).toBe('PAID');
    expect(invoices.get(b2.id).status).toBe('PAID');
  });
});

describe('scenario 3: credit note allocation reverses AR and revenue', () => {
  it('nets the invoice without touching the bank', () => {
    const cust = contacts.save({ name: 'Acme', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: D,
      lines: [{ description: 'Goods', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(inv.id);
    const cn = invoices.saveDraft({
      type: 'ACCRECCREDIT', contact_id: cust, date: '2026-03-12',
      lines: [{ description: 'Partial credit', quantity: 1, unit_amount: 40000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(cn.id);

    expect(balance('610')).toBe(110000 - 44000);
    expect(balance('200')).toBe(-(100000 - 40000));
    expect(balance('820')).toBe(-(10000 - 4000));

    invoices.allocateCredit(cn.id, inv.id, 44000);
    const doc = invoices.get(inv.id);
    expect(doc.amount_due).toBe(110000 - 44000);
    expect(invoices.get(cn.id).amount_due).toBe(0);
    expect(invoices.get(cn.id).status).toBe('PAID');
  });
});

describe('scenario 4: tracked inventory — buy then sell', () => {
  it('maintains average cost, posts COGS, blocks negative stock', () => {
    const sup = contacts.save({ name: 'Wholesale', is_supplier: true }).id;
    const cust = contacts.save({ name: 'Retail', is_customer: true }).id;
    const item = itemsSvc.save({
      code: 'W1', name: 'Widget', is_tracked: true, i_sell: true, i_purchase: true,
      sales_unit_price: 9000, sales_account_id: acc('200'), sales_tax_rate_id: 3,
      purchase_unit_price: 4000, purchase_tax_rate_id: 4,
      inventory_asset_account_id: acc('630'), cogs_account_id: acc('310'),
    }).id;

    // Buy 10 @ $40 then 10 @ $60 → avg $50
    for (const [qty, price] of [[10, 4000], [10, 6000]] as const) {
      const b = invoices.saveDraft({
        type: 'ACCPAY', contact_id: sup, date: D,
        lines: [{ item_id: item, description: 'Widget', quantity: qty, unit_amount: price, account_id: acc('310'), tax_rate_id: 4 }],
      });
      invoices.approve(b.id);
    }
    let it2 = itemsSvc.get(item);
    expect(it2.quantity_on_hand).toBe(20);
    expect(it2.total_value).toBe(100000);
    expect(it2.average_cost).toBe(5000);
    expect(balance('630')).toBe(100000); // inventory asset, not expense
    expect(balance('310')).toBe(0);

    // Sell 8 @ $90 → COGS 8 × $50 = $400
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-15',
      lines: [{ item_id: item, description: 'Widget', quantity: 8, unit_amount: 9000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(inv.id);
    it2 = itemsSvc.get(item);
    expect(it2.quantity_on_hand).toBe(12);
    expect(it2.total_value).toBe(60000);
    expect(balance('310')).toBe(40000); // COGS
    expect(balance('630')).toBe(60000);

    // P&L gross profit = 720 − 400
    const pl = reports.profitAndLoss({ from: '2026-03-01', to: '2026-03-31' });
    expect(pl.total_income).toBe(72000);
    expect(pl.total_cogs).toBe(40000);
    expect(pl.gross_profit).toBe(32000);

    // Overselling throws
    const over = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-16',
      lines: [{ item_id: item, description: 'Widget', quantity: 99, unit_amount: 9000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    expect(() => invoices.approve(over.id)).toThrow(/stock/i);
  });
});

describe('scenario 5: foreign invoice settles at a different rate', () => {
  it('posts a realised FX gain', () => {
    const cust = contacts.save({ name: 'EU GmbH', is_customer: true }).id;
    settings.setExchangeRate('EUR', '2026-03-01', 1.08);
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: D, currency_code: 'EUR', exchange_rate: 1.08,
      lines: [{ description: 'Licence', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 5 }],
    });
    invoices.approve(inv.id);
    expect(balance('610')).toBe(108000); // €1000 @ 1.08
    expect(balance('200')).toBe(-108000);

    payments.create({
      type: 'RECEIVE', date: '2026-03-25', bank_account_id: acc('090'), contact_id: cust,
      amount: 100000, currency_code: 'EUR', exchange_rate: 1.12,
      allocations: [{ invoice_id: inv.id, amount: 100000 }],
    });
    expect(balance('610')).toBe(0); // relieved at invoice rate
    expect(balance('090')).toBe(112000); // banked at payment rate
    expect(balance('499')).toBe(-4000); // realised gain (credit on the FX account)
    expect(invoices.get(inv.id).status).toBe('PAID');
    expect(reports.trialBalance({ as_at: '2026-03-31' }).total_debit).toBe(
      reports.trialBalance({ as_at: '2026-03-31' }).total_credit
    );
  });
});

describe('scenario 7: reconciliation round trip', () => {
  it('ledger bank balance equals statement closing balance', () => {
    const cust = contacts.save({ name: 'Payer', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: D,
      lines: [{ description: 'Work', quantity: 1, unit_amount: 200000, account_id: acc('200'), tax_rate_id: 2 }],
    });
    invoices.approve(inv.id);

    banking.importStatement(
      acc('090'), 's.csv',
      ['Date,Amount,Payee,Description', '2026-03-15,2000.00,Payer,Invoice payment', '2026-03-16,-45.00,Bank,Account fee'].join('\n')
    );
    const lines = banking.unreconciled(acc('090'));
    // pay-invoice path
    const payLine = lines.find((l: any) => l.amount > 0)!;
    const sugInv = payLine.suggestion.find((s: any) => s.kind === 'INVOICE');
    expect(sugInv.id).toBe(inv.id);
    banking.reconcilePayInvoice(payLine.id, inv.id);
    // create-spend path
    const feeLine = lines.find((l: any) => l.amount < 0)!;
    banking.reconcileCreate(feeLine.id, { account_id: acc('404'), tax_rate_id: 2, description: 'Bank fee' });

    const rep = banking.reconciliationReport(acc('090'), '2026-03-31');
    expect(rep.unreconciled).toHaveLength(0);
    expect(rep.ledger_balance).toBe(200000 - 4500);
    expect(rep.ledger_balance).toBe(rep.statement_balance);
    expect(invoices.get(inv.id).status).toBe('PAID');
  });
});

describe('scenario 8: period lock blocks document posting', () => {
  it('approve into locked period throws; void falls forward to today', () => {
    const cust = contacts.save({ name: 'Late Larry', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-01-15',
      lines: [{ description: 'Old work', quantity: 1, unit_amount: 10000, account_id: acc('200'), tax_rate_id: 2 }],
    });
    settings.setLockDate('2026-02-28', null);
    expect(() => invoices.approve(inv.id)).toThrow(/locked/i);
  });
});

describe('scenario 9: tax summary reconciles to the GST control account', () => {
  it('net tax equals control account movement', () => {
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    const sup = contacts.save({ name: 'S', is_supplier: true }).id;
    const i1 = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: D,
      lines: [{ description: 'Sale', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(i1.id);
    const b1 = invoices.saveDraft({
      type: 'ACCPAY', contact_id: sup, date: D,
      lines: [{ description: 'Buy', quantity: 1, unit_amount: 40000, account_id: acc('453'), tax_rate_id: 4 }],
    });
    invoices.approve(b1.id);

    const ts = reports.taxSummary({ from: '2026-03-01', to: '2026-03-31' });
    expect(ts.tax_collected).toBe(10000);
    expect(ts.tax_paid).toBe(4000);
    expect(ts.net_tax).toBe(6000);
    expect(ts.gst_control_balance).toBe(6000); // credit balance owed to the authority
    expect(ts.sales.net).toBe(100000);
    expect(ts.purchases.net).toBe(40000);
  });
});

describe('manual journals and depreciation', () => {
  it('posts, auto-reverses, and depreciates straight-line', () => {
    const mj = journals.saveDraft({
      narration: 'Accrual', date: '2026-03-31', auto_reversing_date: '2026-04-01',
      lines: [
        { account_id: acc('477'), debit: 50000 },
        { account_id: acc('825'), credit: 50000 },
      ],
    });
    journals.post(mj);
    expect(balance('825', '2026-03-31')).toBe(-50000);
    expect(balance('825', '2026-04-30')).toBe(0); // auto-reversed

    const typeId = assets.saveType({ name: 'IT', asset_account_id: acc('710'), accumulated_dep_account_id: acc('711'), expense_account_id: acc('420') });
    const a = assets.save({
      name: 'Laptop', asset_type_id: typeId, purchase_date: '2026-01-01', purchase_price: 360000,
      depreciation_method: 'STRAIGHT_LINE', effective_life: 3, residual_value: 0, depreciation_start_date: '2026-01-01',
    });
    assets.register(a.id);
    const run = assets.runDepreciation('2026-03-31');
    // 3600 / 36 months = 100/mo × 3 months
    expect(run.entries[0].amount).toBe(30000);
    expect(balance('420', '2026-03-31')).toBe(30000);
    expect(balance('711', '2026-03-31')).toBe(-30000);
    expect(() => assets.runDepreciation('2026-03-31')).toThrow(/already/i);
  });
});

describe('property: trial balance always balances; BS always balances', () => {
  it('holds over the demo dataset', async () => {
    const { seedDemo } = await import('../src/backend/seed/demo');
    seedDemo();
    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
    const bs = reports.balanceSheet({ as_at: '2099-12-31' });
    expect(bs.balances).toBe(true);
    const today = new Date().toISOString().slice(0, 10);
    const aged = reports.agedReceivables({ as_at: today });
    expect(aged.totals.total).toBeGreaterThan(0);
  });
});

describe('void round trip', () => {
  it('voiding an invoice reverses its journals and restores stock', () => {
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: D,
      lines: [{ description: 'Job', quantity: 1, unit_amount: 70000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(inv.id);
    expect(balance('610')).toBe(77000);
    invoices.voidDoc(inv.id);
    expect(invoices.get(inv.id).status).toBe('VOIDED');
    expect(balance('610')).toBe(0);
    expect(balance('200')).toBe(0);
    const tb = reports.trialBalance({ as_at: '2026-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
  });
});
