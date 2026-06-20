import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const rate = (r: number) => getDb().prepare("INSERT OR IGNORE INTO exchange_rates(date,currency_code,rate) VALUES('2026-06-01','EUR',?)").run(r);
let cust: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'EuroCo', is_customer: true }).id; });

function euroInvoice(r: number, lines: Array<{ amt: number; tax?: number }>) {
  rate(r);
  const i = invoices.saveDraft({
    type: 'ACCREC', contact_id: cust, date: '2026-06-01', currency_code: 'EUR', exchange_rate: r,
    lines: lines.map((l) => ({ description: 'x', quantity: 1, unit_amount: l.amt, account_id: acc('200'), tax_rate_id: l.tax ?? 2 })),
  });
  return i.id;
}
const journalBalanced = (sourceType: string, sourceId: number) => {
  const j: any = getDb().prepare("SELECT j.id FROM journals j WHERE j.source_type=? AND j.source_id=? AND j.status='POSTED'").get(sourceType, sourceId);
  const sums: any = getDb().prepare('SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines WHERE journal_id=?').get(j.id);
  return sums.d === sums.c && sums.d > 0;
};

describe('multi-line foreign-currency documents (FX rounding residual)', () => {
  it('authorises a 2-line EUR invoice at rate 1.10 (previously threw)', () => {
    const id = euroInvoice(1.10, [{ amt: 3333 }, { amt: 3333 }]);
    expect(() => invoices.approve(id)).not.toThrow();
    expect(invoices.get(id).status).toBe('AUTHORISED');
    expect(journalBalanced('INVOICE', id)).toBe(true);
  });

  it('authorises across the rates from the bug report', () => {
    for (const r of [1.07, 0.83, 1.123, 1.137, 0.6667]) {
      const id = euroInvoice(r, [{ amt: 3333 }, { amt: 3333 }]);
      expect(() => invoices.approve(id), `rate ${r}`).not.toThrow();
      expect(journalBalanced('INVOICE', id)).toBe(true);
    }
  });

  it('authorises a 3-line taxed EUR invoice', () => {
    const id = euroInvoice(1.10, [{ amt: 3333, tax: 1 }, { amt: 3333, tax: 1 }, { amt: 1111, tax: 1 }]);
    expect(() => invoices.approve(id)).not.toThrow();
    expect(journalBalanced('INVOICE', id)).toBe(true);
  });

  it('the rounding residual is tiny (a few cents at most) and posts to Rounding', () => {
    const id = euroInvoice(1.10, [{ amt: 3333 }, { amt: 3333 }]);
    invoices.approve(id);
    const j: any = getDb().prepare("SELECT id FROM journals WHERE source_type='INVOICE' AND source_id=?").get(id);
    const roundingAcct = getDb().prepare("SELECT id FROM accounts WHERE system_account='ROUNDING'").get() as any;
    const rl: any = getDb().prepare('SELECT debit, credit FROM journal_lines WHERE journal_id=? AND account_id=?').get(j.id, roundingAcct.id);
    expect(rl).toBeTruthy();
    expect(Math.abs((rl.debit ?? 0) - (rl.credit ?? 0))).toBeLessThanOrEqual(5);
  });

  it('base-currency multi-line invoices get NO rounding line', () => {
    const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-06-01', lines: [
      { description: 'x', quantity: 1, unit_amount: 3333, account_id: acc('200'), tax_rate_id: 2 },
      { description: 'y', quantity: 1, unit_amount: 3333, account_id: acc('200'), tax_rate_id: 2 },
    ] });
    invoices.approve(i.id);
    const j: any = getDb().prepare("SELECT id FROM journals WHERE source_type='INVOICE' AND source_id=?").get(i.id);
    const roundingAcct = getDb().prepare("SELECT id FROM accounts WHERE system_account='ROUNDING'").get() as any;
    const rl = getDb().prepare('SELECT 1 FROM journal_lines WHERE journal_id=? AND account_id=?').get(j.id, roundingAcct.id);
    expect(rl).toBeFalsy();
  });

  it('works for foreign bills too', () => {
    rate(1.10);
    const supp = contacts.save({ name: 'EuroSupplier', is_supplier: true }).id;
    const b = invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date: '2026-06-01', currency_code: 'EUR', exchange_rate: 1.10, lines: [
      { description: 'x', quantity: 1, unit_amount: 3333, account_id: acc('400'), tax_rate_id: 2 },
      { description: 'y', quantity: 1, unit_amount: 3333, account_id: acc('400'), tax_rate_id: 2 },
    ] });
    expect(() => invoices.approve(b.id)).not.toThrow();
    expect(journalBalanced('INVOICE', b.id)).toBe(true);
  });
});

describe('multi-allocation foreign payments (same residual class)', () => {
  it('settles two EUR invoices in one payment at a different rate', () => {
    const mk = () => { const id = euroInvoice(1.08, [{ amt: 3333 }]); invoices.approve(id); return id; };
    const i1 = mk(), i2 = mk();
    const bank = getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get() as any;
    rate(1.10);
    const p = payments.create({ type: 'RECEIVE', date: '2026-06-02', bank_account_id: bank.id, contact_id: cust, amount: 6666, currency_code: 'EUR', exchange_rate: 1.10, allocations: [{ invoice_id: i1, amount: 3333 }, { invoice_id: i2, amount: 3333 }] });
    expect(p.id).toBeGreaterThan(0);
    expect(invoices.get(i1).status).toBe('PAID');
    expect(invoices.get(i2).status).toBe('PAID');
    expect(journalBalanced('PAYMENT', p.id)).toBe(true);
  });
});
