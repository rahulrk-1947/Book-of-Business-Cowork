import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
const AR = (bs: any) => bs.assets.find((a: any) => a.code === '610')?.amount;
const AP = (bs: any) => bs.liabilities.find((l: any) => l.code === '800')?.amount;
const GST = (bs: any) => bs.liabilities.find((l: any) => l.code === '820')?.amount ?? 0;
const totals = (bs: any) => ({ a: bs.assets.reduce((s: number, r: any) => s + r.amount, 0), le: bs.liabilities.reduce((s: number, r: any) => s + r.amount, 0) + bs.equity.reduce((s: number, r: any) => s + r.amount, 0) });
let cust: number, supp: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'C', is_customer: true }).id; supp = contacts.save({ name: 'S', is_supplier: true }).id; });

const sale = (cents: number, date = '2026-06-01', taxed = true) => { const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 'x', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: taxed ? 3 : 2 }] }); invoices.approve(i.id); return i.id; };
const bill = (cents: number, date = '2026-06-02', taxed = true) => { const b = invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date, lines: [{ description: 'y', quantity: 1, unit_amount: cents, account_id: acc('400'), tax_rate_id: taxed ? 4 : 2 }] }); invoices.approve(b.id); return b.id; };
const pay = (invId: number, amount: number, type: 'RECEIVE' | 'SPEND', who: number) => payments.create({ type, date: '2026-06-10', bank_account_id: bankId(), contact_id: who, amount, allocations: [{ invoice_id: invId, amount }] });

describe('cash-basis Balance Sheet', () => {
  it('removes Accounts Receivable and Accounts Payable', () => {
    sale(100000); bill(40000);
    const cash = reports.balanceSheet({ as_at: '2026-06-30', basis: 'CASH' });
    expect(AR(cash)).toBeUndefined();
    expect(AP(cash)).toBeUndefined();
    expect(cash.cash_basis).toBe(true);
    expect(cash.balances).toBe(true);
  });

  it('restates GST to only what has actually been collected/paid in cash', () => {
    sale(100000);                 // 10,000 output GST, unpaid
    const paid = sale(50000);     // 5,000 output GST
    pay(paid, 55000, 'RECEIVE', cust);
    bill(40000);                  // 4,000 input GST, unpaid
    const accrual = reports.balanceSheet({ as_at: '2026-06-30' });
    expect(GST(accrual)).toBe(11000); // 15,000 output − 4,000 input
    const cash = reports.balanceSheet({ as_at: '2026-06-30', basis: 'CASH' });
    expect(GST(cash)).toBe(5000);     // only the paid sale's GST
    expect(cash.balances).toBe(true);
  });

  it('always balances — taxed and untaxed, sales and bills, paid and unpaid', () => {
    sale(100000); sale(33333); bill(40000); bill(12345, '2026-06-02', false);
    const paidSale = sale(50000); pay(paidSale, 55000, 'RECEIVE', cust);
    const paidBill = bill(20000); pay(paidBill, 22000, 'SPEND', supp);
    const cash = reports.balanceSheet({ as_at: '2026-06-30', basis: 'CASH' });
    const t = totals(cash);
    expect(t.a).toBe(t.le); // assets == liabilities + equity, to the cent
    expect(cash.balances).toBe(true);
  });

  it('a partial payment: cash basis recognises only the paid share', () => {
    const id = sale(100000); // 110,000 total (incl 10,000 GST)
    pay(id, 55000, 'RECEIVE', cust); // half paid
    const accrual = reports.balanceSheet({ as_at: '2026-06-30' });
    expect(AR(accrual)).toBe(55000); // half still receivable
    const cash = reports.balanceSheet({ as_at: '2026-06-30', basis: 'CASH' });
    expect(AR(cash)).toBeUndefined();
    expect(GST(cash)).toBe(5000); // only half the GST collected
    expect(cash.balances).toBe(true);
  });

  it('with everything paid, cash basis equals accrual', () => {
    const s = sale(100000); pay(s, 110000, 'RECEIVE', cust);
    const b = bill(40000); pay(b, 44000, 'SPEND', supp);
    const accrual = reports.balanceSheet({ as_at: '2026-06-30' });
    const cash = reports.balanceSheet({ as_at: '2026-06-30', basis: 'CASH' });
    expect(GST(cash)).toBe(GST(accrual));
    expect(totals(cash).a).toBe(totals(accrual).a);
    expect(cash.balances).toBe(true);
  });

  it('foreign-currency open documents are handled and still balance', () => {
    getDb().prepare("INSERT OR IGNORE INTO exchange_rates(date,currency_code,rate) VALUES('2026-06-01','EUR',1.10)").run();
    const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-06-01', currency_code: 'EUR', exchange_rate: 1.10, lines: [{ description: 'x', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 3 }] });
    invoices.approve(i.id);
    const cash = reports.balanceSheet({ as_at: '2026-06-30', basis: 'CASH' });
    expect(AR(cash)).toBeUndefined();
    expect(cash.balances).toBe(true);
  });

  it('the toggle off (accrual) keeps AR/AP and is unchanged', () => {
    sale(100000); bill(40000);
    const accrual = reports.balanceSheet({ as_at: '2026-06-30' });
    expect(AR(accrual)).toBe(110000);
    expect(AP(accrual)).toBe(44000);
    expect(accrual.cash_basis).toBeFalsy();
  });

  it('cash basis reduces equity by unrecognised net income', () => {
    sale(100000, '2026-06-01', false); // untaxed 100,000 sale, unpaid → 100,000 unrecognised income
    const accrual = reports.balanceSheet({ as_at: '2026-06-30' });
    const cash = reports.balanceSheet({ as_at: '2026-06-30', basis: 'CASH' });
    const eq = (bs: any) => bs.equity.reduce((s: number, r: any) => s + r.amount, 0);
    expect(eq(accrual) - eq(cash)).toBe(100000); // the unpaid sale's income removed on cash basis
    expect(cash.balances).toBe(true);
  });
});
