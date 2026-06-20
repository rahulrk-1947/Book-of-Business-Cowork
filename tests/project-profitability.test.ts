import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
let cust: number, catId: number, pA: number, pB: number;
beforeEach(() => {
  initDatabase(':memory:');
  cust = contacts.save({ name: 'C', is_customer: true }).id;
  catId = Number(getDb().prepare("INSERT INTO tracking_categories(name) VALUES('Projects')").run().lastInsertRowid);
  pA = Number(getDb().prepare("INSERT INTO tracking_options(category_id,name) VALUES(?,'Website')").run(catId).lastInsertRowid);
  pB = Number(getDb().prepare("INSERT INTO tracking_options(category_id,name) VALUES(?,'Mobile App')").run(catId).lastInsertRowid);
});

const income = (cents: number, opt: number, date = '2026-06-01') => { const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 'inc', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: 2, tracking_option_1: opt }] }); invoices.approve(i.id); return i.id; };
const cost = (cents: number, opt: number, date = '2026-06-02', account = '400') => { const b = invoices.saveDraft({ type: 'ACCPAY', contact_id: cust, date, lines: [{ description: 'cost', quantity: 1, unit_amount: cents, account_id: acc(account), tax_rate_id: 2, tracking_option_1: opt }] }); invoices.approve(b.id); return b.id; };
const row = (r: any, name: string) => r.rows.find((x: any) => x.name === name);

describe('project / job profitability (by tracking category)', () => {
  it('computes income, expenses and net per project', () => {
    income(100000, pA); cost(30000, pA);
    income(50000, pB); cost(20000, pB);
    const r = reports.trackingProfitability({ category_id: catId, from: '2026-06-01', to: '2026-06-30' });
    expect(row(r, 'Website')).toMatchObject({ income: 100000, expenses: 30000, net: 70000 });
    expect(row(r, 'Mobile App')).toMatchObject({ income: 50000, expenses: 20000, net: 30000 });
    expect(r.totals.net).toBe(100000);
  });

  it('separates cost of sales from other expenses (gross vs net)', () => {
    income(100000, pA);
    cost(40000, pA, '2026-06-02', '310'); // 310 is a COGS account in the seed
    cost(10000, pA, '2026-06-03', '400'); // operating expense
    const r = reports.trackingProfitability({ category_id: catId, from: '2026-06-01', to: '2026-06-30' });
    const w = row(r, 'Website');
    expect(w.income).toBe(100000);
    expect(w.cogs).toBe(40000);
    expect(w.gross_profit).toBe(60000);
    expect(w.expenses).toBe(10000);
    expect(w.net).toBe(50000);
  });

  it('lists every active option, including ones with no activity (zero)', () => {
    income(100000, pA);
    const r = reports.trackingProfitability({ category_id: catId, from: '2026-06-01', to: '2026-06-30' });
    expect(r.rows).toHaveLength(2);
    expect(row(r, 'Mobile App')).toMatchObject({ income: 0, net: 0 });
  });

  it('respects the date range', () => {
    income(100000, pA, '2026-05-15'); // before range
    income(40000, pA, '2026-06-15');  // inside
    const r = reports.trackingProfitability({ category_id: catId, from: '2026-06-01', to: '2026-06-30' });
    expect(row(r, 'Website')!.income).toBe(40000);
  });

  it('supports the cash basis (only paid amounts count)', () => {
    const inv = income(100000, pA); // unpaid
    const paid = income(60000, pB);
    payments.create({ type: 'RECEIVE', date: '2026-06-10', bank_account_id: bankId(), contact_id: cust, amount: 60000, allocations: [{ invoice_id: paid, amount: 60000 }] });
    const r = reports.trackingProfitability({ category_id: catId, from: '2026-06-01', to: '2026-06-30', basis: 'CASH' });
    expect(row(r, 'Website')!.income).toBe(0);    // unpaid → no cash income
    expect(row(r, 'Mobile App')!.income).toBe(60000); // paid
  });

  it('totals across projects equal the sum of the rows', () => {
    income(100000, pA); cost(30000, pA);
    income(50000, pB); cost(20000, pB);
    const r = reports.trackingProfitability({ category_id: catId, from: '2026-06-01', to: '2026-06-30' });
    expect(r.totals.income).toBe(150000);
    expect(r.totals.expenses).toBe(50000);
    expect(r.totals.net).toBe(row(r, 'Website')!.net + row(r, 'Mobile App')!.net);
  });

  it('rejects an unknown tracking category', () => {
    expect(() => reports.trackingProfitability({ category_id: 9999, from: '2026-06-01', to: '2026-06-30' })).toThrow(/not found/i);
  });
});
