import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const usdBank = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
const rate = (ccy: string, r: number, d = '2026-06-01') => getDb().prepare('INSERT OR IGNORE INTO exchange_rates(date,currency_code,rate) VALUES(?,?,?)').run(d, ccy, r);
let cust: number, supp: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'EuroCo', is_customer: true }).id; supp = contacts.save({ name: 'EuroSupplier', is_supplier: true }).id; rate('EUR', 1.10); rate('GBP', 1.27); });

function gbpBank() {
  return getDb().prepare("INSERT INTO accounts (code,name,type,subtype,is_bank_account,bank_currency,enable_payments,system_account,status) VALUES ('095','GBP Account','ASSET','BANK',1,'GBP',1,NULL,'ACTIVE')").run().lastInsertRowid as number;
}
const eurInvoice = (cents: number, r = 1.10) => { const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-06-01', currency_code: 'EUR', exchange_rate: r, lines: [{ description: 'x', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: 2 }] }); invoices.approve(i.id); return i.id; };
const eurBill = (cents: number, r = 1.10) => { const b = invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date: '2026-06-01', currency_code: 'EUR', exchange_rate: r, lines: [{ description: 'y', quantity: 1, unit_amount: cents, account_id: acc('400'), tax_rate_id: 2 }] }); invoices.approve(b.id); return b.id; };
const journal = (pid: number) => { const j: any = getDb().prepare("SELECT id FROM journals WHERE source_type='PAYMENT' AND source_id=?").get(pid); return getDb().prepare('SELECT a.code, a.system_account, jl.debit, jl.credit FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id WHERE jl.journal_id=?').all(j.id) as any[]; };
const acctBase = (code: string, asAt = '2026-06-30') => { const r: any = getDb().prepare("SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS bal FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id JOIN accounts a ON a.id=jl.account_id WHERE a.code=? AND j.status='POSTED' AND j.date<=?").get(code, asAt); return r.bal as number; };

describe('cross-currency settlement', () => {
  it('settles a EUR invoice from a USD (base) bank with a realised FX loss', () => {
    const id = eurInvoice(100000); // AR = 110,000 base
    const p = payments.create({ type: 'RECEIVE', date: '2026-06-05', bank_account_id: usdBank(), contact_id: cust, amount: 0, bank_amount: 108000, bank_rate: 1.0, allocations: [{ invoice_id: id, amount: 100000 }] });
    expect(invoices.get(id).status).toBe('PAID');
    const ls = journal(p.id);
    expect(ls.find((l) => l.code === '090')!.debit).toBe(108000);       // bank received 108,000 base
    expect(ls.find((l) => l.system_account === 'AR')!.credit).toBe(110000); // AR cleared at booked rate
    expect(ls.find((l) => l.system_account === 'REALISED_FX')!.debit).toBe(2000); // 2,000 loss
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('settles a EUR invoice from a USD bank with a realised FX gain', () => {
    const id = eurInvoice(100000); // AR = 110,000
    const p = payments.create({ type: 'RECEIVE', date: '2026-06-05', bank_account_id: usdBank(), contact_id: cust, amount: 0, bank_amount: 112000, bank_rate: 1.0, allocations: [{ invoice_id: id, amount: 100000 }] });
    const ls = journal(p.id);
    expect(ls.find((l) => l.system_account === 'REALISED_FX')!.credit).toBe(2000); // 2,000 gain
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('pays a EUR bill from a USD bank (SPEND direction)', () => {
    const id = eurBill(100000); // AP = 110,000
    const p = payments.create({ type: 'SPEND', date: '2026-06-05', bank_account_id: usdBank(), contact_id: supp, amount: 0, bank_amount: 108000, bank_rate: 1.0, allocations: [{ invoice_id: id, amount: 100000 }] });
    expect(invoices.get(id).status).toBe('PAID');
    const ls = journal(p.id);
    expect(ls.find((l) => l.code === '090')!.credit).toBe(108000); // bank paid out 108,000
    expect(ls.find((l) => l.system_account === 'AP')!.debit).toBe(110000); // AP cleared at booked rate
    expect(ls.find((l) => l.system_account === 'REALISED_FX')!.credit).toBe(2000); // paid less than booked = gain
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('settles a EUR invoice from a GBP bank (two foreign currencies, base USD)', () => {
    const id = eurInvoice(100000); // AR = 110,000
    const gbp = gbpBank();
    // £850 left, GBP→USD 1.27 → 107,950 base; FX loss 2,050
    const p = payments.create({ type: 'RECEIVE', date: '2026-06-05', bank_account_id: gbp, contact_id: cust, amount: 0, bank_amount: 85000, bank_rate: 1.27, allocations: [{ invoice_id: id, amount: 100000 }] });
    expect(invoices.get(id).status).toBe('PAID');
    expect(acctBase('095')).toBe(107950); // GBP bank base value increased by 107,950
    const ls = journal(p.id);
    expect(ls.find((l) => l.system_account === 'REALISED_FX')!.debit).toBe(2050);
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('supports a partial cross-currency settlement', () => {
    const id = eurInvoice(100000); // €1000 due
    const p = payments.create({ type: 'RECEIVE', date: '2026-06-05', bank_account_id: usdBank(), contact_id: cust, amount: 0, bank_amount: 54000, bank_rate: 1.0, allocations: [{ invoice_id: id, amount: 50000 }] });
    expect(invoices.get(id).amount_due).toBe(50000); // €500 still due (invoice currency)
    expect(invoices.get(id).status).not.toBe('PAID');
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('records the bank movement on the payment in the bank currency', () => {
    const id = eurInvoice(100000);
    const gbp = gbpBank();
    const p = payments.create({ type: 'RECEIVE', date: '2026-06-05', bank_account_id: gbp, contact_id: cust, amount: 0, bank_amount: 85000, bank_rate: 1.27, allocations: [{ invoice_id: id, amount: 100000 }] });
    const rec: any = getDb().prepare('SELECT amount, currency_code, exchange_rate FROM payments WHERE id=?').get(p.id);
    expect(rec.amount).toBe(85000);
    expect(rec.currency_code).toBe('GBP');
    expect(rec.exchange_rate).toBe(1.27);
  });

  it('requires an allocation (no money-on-account for cross-currency)', () => {
    expect(() => payments.create({ type: 'RECEIVE', date: '2026-06-05', bank_account_id: usdBank(), contact_id: cust, amount: 0, bank_amount: 50000, bank_rate: 1.0, allocations: [] })).toThrow(/allocated to at least one/i);
  });

  it('leaves the ordinary single-currency payment path unchanged', () => {
    // a plain base-currency invoice + payment (no bank_amount) still works
    const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-06-01', lines: [{ description: 'z', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(i.id);
    const p = payments.create({ type: 'RECEIVE', date: '2026-06-05', bank_account_id: usdBank(), contact_id: cust, amount: 100000, allocations: [{ invoice_id: i.id, amount: 100000 }] });
    expect(invoices.get(i.id).status).toBe('PAID');
    const ls = journal(p.id);
    expect(ls.find((l) => l.code === '090')!.debit).toBe(100000);
    expect(ls.find((l) => l.system_account === 'REALISED_FX')).toBeUndefined(); // no FX on a base payment
  });
});
