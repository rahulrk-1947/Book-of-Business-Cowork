/**
 * Regression tests for the audit fixes. Each test pins a bug that previously
 * shipped green (or was unguarded), so a future change can't silently reintroduce it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import { roundCents } from '../src/backend/money';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';
import * as reports from '../src/backend/services/reports';
import * as assets from '../src/backend/services/assets';
import * as settings from '../src/backend/services/settings';
import * as taxreturns from '../src/backend/services/taxreturns';
import * as banking from '../src/backend/services/banking';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
const bal = (code: string) => Number(getDb().prepare('SELECT COALESCE(SUM(debit-credit),0) AS b FROM journal_lines WHERE account_id = ?').get(acc(code)).b);
const lastPaymentId = () => getDb().prepare('SELECT MAX(id) AS id FROM payments').get().id as number;

let cust: number;
beforeEach(() => {
  initDatabase(':memory:');
  cust = contacts.save({ name: 'Acme Co', is_customer: true }).id;
});

const sale = (cents: number, date: string, due = date, taxRate = 2) => {
  const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, due_date: due, lines: [{ description: 'Job', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: taxRate }] });
  invoices.approve(i.id);
  return i.id;
};
const pay = (invId: number, amount: number, date: string) =>
  payments.create({ type: 'RECEIVE', date, bank_account_id: bankId(), contact_id: cust, amount, allocations: [{ invoice_id: invId, amount }] });

describe('money rounding', () => {
  it('rounds half away from zero despite binary floating point', () => {
    expect(roundCents(1.005 * 100)).toBe(101);
    expect(roundCents(2.675 * 100)).toBe(268);
    expect(roundCents(-1.005 * 100)).toBe(-101);
  });
});

describe('period locks', () => {
  it('enforces the adviser lock date (previously read but ignored)', () => {
    settings.setLockDate(null, '2026-03-31');
    expect(() => sale(10000, '2026-03-15')).toThrow(/locked/i);
    expect(() => sale(10000, '2026-04-15')).not.toThrow();
  });
});

describe('exchange rate & discounts', () => {
  it('rejects a non-positive exchange rate', () => {
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-04-01', currency_code: 'EUR', exchange_rate: 0,
      lines: [{ description: 'x', quantity: 1, unit_amount: 10000, account_id: acc('200'), tax_rate_id: 2 }] })).toThrow(/exchange rate/i);
  });
  it('auto-populates a foreign rate from the rate table when none is supplied', () => {
    settings.setExchangeRate('EUR', '2026-04-01', 1.5);
    const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-04-05', currency_code: 'EUR',
      lines: [{ description: 'x', quantity: 1, unit_amount: 10000, account_id: acc('200'), tax_rate_id: 2 }] });
    expect(getDb().prepare('SELECT exchange_rate FROM invoices WHERE id=?').get(i.id).exchange_rate).toBe(1.5);
  });
  it('rejects a discount outside 0..100%', () => {
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-04-01',
      lines: [{ description: 'x', quantity: 1, unit_amount: 10000, discount_percent: 150, account_id: acc('200'), tax_rate_id: 2 }] })).toThrow(/discount/i);
  });
});

describe('document integrity', () => {
  it('rejects a duplicate invoice number', () => {
    invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-04-01', invoice_number: 'DUP-1',
      lines: [{ description: 'x', quantity: 1, unit_amount: 10000, account_id: acc('200'), tax_rate_id: 2 }] });
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-04-02', invoice_number: 'DUP-1',
      lines: [{ description: 'x', quantity: 1, unit_amount: 10000, account_id: acc('200'), tax_rate_id: 2 }] })).toThrow();
  });
  it('refuses to allocate a credit note across currencies', () => {
    settings.setExchangeRate('EUR', '2026-04-01', 1.2);
    const inv = sale(10000, '2026-04-01');
    const cn = invoices.saveDraft({ type: 'ACCRECCREDIT', contact_id: cust, date: '2026-04-02', currency_code: 'EUR', exchange_rate: 1.2,
      lines: [{ description: 'x', quantity: 1, unit_amount: 5000, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(cn.id);
    expect(() => invoices.allocateCredit(cn.id, inv, 5000)).toThrow(/currency/i);
  });
});

describe('reports as-of-date', () => {
  it('aged receivables reflect the balance AS OF the report date', () => {
    const id = sale(100000, '2026-01-15', '2026-02-15');
    pay(id, 100000, '2026-05-01');
    expect(reports.agedReceivables({ as_at: '2026-03-31' }).totals.total).toBe(100000);
    expect(reports.agedReceivables({ as_at: '2026-06-30' }).totals.total).toBe(0);
  });
});

describe('tax summary', () => {
  it('a GST settlement payment does not corrupt output/input tax', () => {
    sale(100000, '2026-04-10', '2026-04-10', 3);
    taxreturns.recordPayment({ date: '2026-05-20', bank_account_id: bankId(), amount: 6000, direction: 'PAYMENT' });
    const p = taxreturns.prepare({ from: '2026-04-01', to: '2026-06-30' });
    expect(p.collected).toBe(10000);
    expect(p.paid).toBe(0);
  });
});

describe('cash-basis recognition', () => {
  it('a deleted payment no longer produces cash-basis revenue', () => {
    const id = sale(100000, '2026-04-01');
    pay(id, 100000, '2026-04-10');
    const rev = () => { const r = reports.profitAndLoss({ from: '2026-04-01', to: '2026-04-30', basis: 'CASH' }).income.find((x: any) => x.code === '200'); return r ? r.amount : 0; };
    expect(rev()).toBe(100000);
    payments.remove(lastPaymentId());
    expect(rev()).toBe(0);
  });
});

describe('fixed assets', () => {
  it('sequential monthly depreciation does not double-count the boundary month', () => {
    const a = assets.save({ name: 'Laptop', purchase_date: '2026-01-01', purchase_price: 120000, depreciation_method: 'STRAIGHT_LINE', effective_life: 1, residual_value: 0, depreciation_start_date: '2026-01-01' });
    assets.register(a.id);
    assets.runDepreciation('2026-01-31');
    assets.runDepreciation('2026-02-28');
    assets.runDepreciation('2026-03-31');
    const got = assets.get(a.id);
    expect(got.accumulated_depreciation).toBe(30000);
    expect(got.book_value).toBe(90000);
  });
  it('disposal depreciates to the disposal date and books gain to its own account', () => {
    const a = assets.save({ name: 'Van', purchase_date: '2026-01-01', purchase_price: 120000, depreciation_method: 'STRAIGHT_LINE', effective_life: 1, residual_value: 0, depreciation_start_date: '2026-01-01' });
    assets.register(a.id);
    assets.runDepreciation('2026-03-31');
    assets.dispose(a.id, { date: '2026-06-30', proceeds: 100000 });
    expect(bal('421')).toBe(-40000);
    expect(bal('420')).toBe(60000);
  });
});

describe('bank reconciliation', () => {
  it('rejects an amount mismatch and accepts a true match', () => {
    const i1 = sale(50000, '2026-04-01'); pay(i1, 50000, '2026-04-05'); const p1 = lastPaymentId();
    const i2 = sale(70000, '2026-04-01'); pay(i2, 70000, '2026-04-06'); const p2 = lastPaymentId();
    banking.ingestStatementLines(bankId(), [{ date: '2026-04-05', amount: 50000, payee: 'Acme' }]);
    const lineId = getDb().prepare('SELECT id FROM bank_statement_lines ORDER BY id LIMIT 1').get().id as number;
    expect(() => banking.reconcileMatch(lineId, 'PAYMENT', p2)).toThrow(/mismatch/i);
    banking.reconcileMatch(lineId, 'PAYMENT', p1);
    expect(getDb().prepare('SELECT status FROM bank_statement_lines WHERE id=?').get(lineId).status).toBe('RECONCILED');
  });
});
