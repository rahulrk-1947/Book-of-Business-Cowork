import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
let cust: number, supp: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'Acme', is_customer: true }).id; supp = contacts.save({ name: 'Supplier', is_supplier: true }).id; });

const invoice = (cents: number, date = '2026-06-02') => {
  const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 'x', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: 2 }] });
  invoices.approve(i.id); return i.id;
};
const bill = (cents: number, date = '2026-06-02') => {
  const b = invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date, lines: [{ description: 'y', quantity: 1, unit_amount: cents, account_id: acc('400'), tax_rate_id: 2 }] });
  invoices.approve(b.id); return b.id;
};

describe('prepayments & overpayments (money on account)', () => {
  it('banks a pure customer prepayment (no invoice) to Customer prepayments', () => {
    payments.create({ type: 'RECEIVE', date: '2026-06-01', bank_account_id: bankId(), contact_id: cust, amount: 50000, allocations: [] });
    expect(payments.prepaymentBalance(cust, 'CUSTOMER')).toBe(50000);
    // it's a liability on the balance sheet
    const bs = reports.balanceSheet({ as_at: '2026-06-30' });
    expect(bs.liabilities.find((l: any) => l.code === '805')!.amount).toBe(50000);
    expect(bs.balances).toBe(true);
  });

  it('an overpayment splits between the invoice and money on account', () => {
    const id = invoice(100000);
    payments.create({ type: 'RECEIVE', date: '2026-06-03', bank_account_id: bankId(), contact_id: cust, amount: 120000, allocations: [{ invoice_id: id, amount: 100000 }] });
    expect(invoices.get(id).status).toBe('PAID');
    expect(payments.prepaymentBalance(cust, 'CUSTOMER')).toBe(20000);
  });

  it('applies money on account to a later invoice and marks it paid', () => {
    payments.create({ type: 'RECEIVE', date: '2026-06-01', bank_account_id: bankId(), contact_id: cust, amount: 70000, allocations: [] });
    const id = invoice(70000, '2026-06-04');
    payments.applyPrepayment({ contact_id: cust, invoice_id: id, amount: 70000, date: '2026-06-05' });
    expect(invoices.get(id).status).toBe('PAID');
    expect(payments.prepaymentBalance(cust, 'CUSTOMER')).toBe(0);
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('partial application leaves a remaining balance and a partially-paid invoice', () => {
    payments.create({ type: 'RECEIVE', date: '2026-06-01', bank_account_id: bankId(), contact_id: cust, amount: 100000, allocations: [] });
    const id = invoice(80000, '2026-06-04');
    payments.applyPrepayment({ contact_id: cust, invoice_id: id, amount: 30000, date: '2026-06-05' });
    expect(invoices.get(id).amount_due).toBe(50000);
    expect(payments.prepaymentBalance(cust, 'CUSTOMER')).toBe(70000);
  });

  it('supplier prepayment is an asset and can be applied to a bill', () => {
    payments.create({ type: 'SPEND', date: '2026-06-01', bank_account_id: bankId(), contact_id: supp, amount: 40000, allocations: [] });
    expect(payments.prepaymentBalance(supp, 'SUPPLIER')).toBe(40000);
    const bs = reports.balanceSheet({ as_at: '2026-06-30' });
    expect(bs.assets.find((a: any) => a.code === '625')!.amount).toBe(40000);
    const b = bill(40000, '2026-06-04');
    payments.applyPrepayment({ contact_id: supp, invoice_id: b, amount: 40000, date: '2026-06-05' });
    expect(invoices.get(b).status).toBe('PAID');
    expect(payments.prepaymentBalance(supp, 'SUPPLIER')).toBe(0);
  });

  it('refuses to apply more than is available', () => {
    payments.create({ type: 'RECEIVE', date: '2026-06-01', bank_account_id: bankId(), contact_id: cust, amount: 20000, allocations: [] });
    const id = invoice(50000, '2026-06-04');
    expect(() => payments.applyPrepayment({ contact_id: cust, invoice_id: id, amount: 30000, date: '2026-06-05' })).toThrow(/available/i);
  });

  it('refuses an on-account payment with no contact', () => {
    expect(() => payments.create({ type: 'RECEIVE', date: '2026-06-01', bank_account_id: bankId(), amount: 50000, allocations: [] })).toThrow(/contact/i);
  });

  it('refuses to apply a prepayment to another contact’s document', () => {
    payments.create({ type: 'RECEIVE', date: '2026-06-01', bank_account_id: bankId(), contact_id: cust, amount: 50000, allocations: [] });
    const other = contacts.save({ name: 'Other', is_customer: true }).id;
    const oi = invoices.saveDraft({ type: 'ACCREC', contact_id: other, date: '2026-06-04', lines: [{ description: 'z', quantity: 1, unit_amount: 50000, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(oi.id);
    expect(() => payments.applyPrepayment({ contact_id: cust, invoice_id: oi.id, amount: 50000, date: '2026-06-05' })).toThrow(/different contact/i);
  });

  it('lists contacts with money on account', () => {
    payments.create({ type: 'RECEIVE', date: '2026-06-01', bank_account_id: bankId(), contact_id: cust, amount: 50000, allocations: [] });
    const list = payments.prepaymentBalances('CUSTOMER');
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ contact_id: cust, balance: 50000 });
  });

  it('normal full payment still works unchanged', () => {
    const id = invoice(100000);
    payments.create({ type: 'RECEIVE', date: '2026-06-03', bank_account_id: bankId(), contact_id: cust, amount: 100000, allocations: [{ invoice_id: id, amount: 100000 }] });
    expect(invoices.get(id).status).toBe('PAID');
    expect(payments.prepaymentBalance(cust, 'CUSTOMER')).toBe(0);
  });
});
