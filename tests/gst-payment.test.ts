import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as taxreturns from '../src/backend/services/taxreturns';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
const gstBalance = () => { const r: any = getDb().prepare("SELECT COALESCE(SUM(jl.credit-jl.debit),0) bal FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id JOIN journals j ON j.id=jl.journal_id WHERE a.system_account='GST' AND j.status='POSTED'").get(); return r.bal as number; };
let cust: number, supp: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'C', is_customer: true }).id; supp = contacts.save({ name: 'S', is_supplier: true }).id; });

const sale = (date: string, net: number) => { const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 's', quantity: 1, unit_amount: net, account_id: acc('200'), tax_rate_id: 3 }] }); invoices.approve(i.id); return i.id; };
const purchase = (date: string, net: number) => { const i = invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date, lines: [{ description: 'b', quantity: 1, unit_amount: net, account_id: acc('400'), tax_rate_id: 4 }] }); invoices.approve(i.id); return i.id; };

describe('GST/VAT payment helper', () => {
  it('paying the net GST clears the liability and reduces the bank', () => {
    sale('2026-04-10', 100000); // 10,000 output tax owed
    expect(gstBalance()).toBe(10000); // credit balance = liability
    const bankBefore = reports.balanceSheet({ as_at: '2026-07-31' }).assets.find((a: any) => a.code === '090')?.amount ?? 0;
    taxreturns.recordPayment({ date: '2026-07-15', bank_account_id: bankId(), amount: 10000, direction: 'PAYMENT' });
    expect(gstBalance()).toBe(0);
    const bankAfter = reports.balanceSheet({ as_at: '2026-07-31' }).assets.find((a: any) => a.code === '090')?.amount ?? 0;
    expect(bankAfter - bankBefore).toBe(-10000); // bank went down by the payment
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('receiving a GST refund increases the bank and clears the asset', () => {
    purchase('2026-04-12', 100000); // 10,000 input tax → GST is a debit (refund due)
    expect(gstBalance()).toBe(-10000); // debit balance = refund due
    taxreturns.recordPayment({ date: '2026-07-15', bank_account_id: bankId(), amount: 10000, direction: 'REFUND' });
    expect(gstBalance()).toBe(0);
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('lists recorded GST payments with direction, amount and bank', () => {
    sale('2026-04-10', 100000);
    taxreturns.recordPayment({ date: '2026-07-15', bank_account_id: bankId(), amount: 10000, direction: 'PAYMENT', reference: 'Q1' });
    const list: any[] = taxreturns.gstPayments();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ direction: 'PAYMENT', amount: 10000 });
    expect(list[0].bank_name).toBeTruthy();
  });

  it('a payment can be linked to a filed return', () => {
    sale('2026-04-10', 100000);
    const r: any = taxreturns.file({ from: '2026-04-01', to: '2026-06-30' });
    taxreturns.recordPayment({ date: '2026-07-15', bank_account_id: bankId(), amount: 10000, direction: 'PAYMENT', return_id: r.id });
    expect(taxreturns.gstPayments()[0]).toMatchObject({ return_id: r.id });
  });

  it('supports a partial GST payment', () => {
    sale('2026-04-10', 100000);
    taxreturns.recordPayment({ date: '2026-07-15', bank_account_id: bankId(), amount: 6000, direction: 'PAYMENT' });
    expect(gstBalance()).toBe(4000); // 10,000 owed − 6,000 paid
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('rejects a zero amount', () => {
    expect(() => taxreturns.recordPayment({ date: '2026-07-15', bank_account_id: bankId(), amount: 0, direction: 'PAYMENT' })).toThrow(/amount/i);
  });

  it('refuses to post into a locked (already-filed) period', () => {
    sale('2026-04-10', 100000);
    taxreturns.file({ from: '2026-04-01', to: '2026-06-30' }); // locks to 2026-06-30
    expect(() => taxreturns.recordPayment({ date: '2026-05-20', bank_account_id: bankId(), amount: 10000, direction: 'PAYMENT' })).toThrow(/lock/i);
  });
});
