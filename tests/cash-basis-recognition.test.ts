import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';
import * as reports from '../src/backend/services/reports';
import * as banking from '../src/backend/services/banking';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
let cust: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'C', is_customer: true }).id; });

// $1000 + 0% tax invoice (tax_rate_id 2 = 0%), revenue account 200
function invoice1000(date = '2026-06-01') {
  const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 'x', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 2 }] });
  invoices.approve(i.id);
  return i.id;
}
const pay = (invId: number, amount: number, date = '2026-06-10') =>
  payments.create({ type: 'RECEIVE', date, bank_account_id: bankId(), contact_id: cust, amount, allocations: [{ invoice_id: invId, amount }] });
const cashRevenue = (from: string, to: string) => {
  const pl = reports.profitAndLoss({ from, to, basis: 'CASH' });
  const row = pl.income.find((r: any) => r.code === '200');
  return row ? row.amount : 0;
};

describe('cash-basis recognition', () => {
  it('an unpaid invoice produces NO cash-basis revenue', () => {
    invoice1000();
    expect(cashRevenue('2026-06-01', '2026-06-30')).toBe(0);
  });

  it('a fully paid invoice recognises the full amount on the payment date', () => {
    const id = invoice1000('2026-06-01');
    pay(id, 100000, '2026-06-10');
    expect(cashRevenue('2026-06-01', '2026-06-09')).toBe(0);   // before payment
    expect(cashRevenue('2026-06-01', '2026-06-30')).toBe(100000); // after payment
  });

  it('a partial payment recognises proportionally', () => {
    const id = invoice1000('2026-06-01');
    pay(id, 40000, '2026-06-10'); // 40% paid
    expect(cashRevenue('2026-06-01', '2026-06-30')).toBe(40000);
  });

  it('multiple partial payments sum to the full amount (penny caveat: within 2c)', () => {
    const id = invoice1000('2026-06-01');
    pay(id, 33333, '2026-06-10');
    pay(id, 33333, '2026-06-20');
    pay(id, 33334, '2026-06-25'); // totals 100000
    const recognised = cashRevenue('2026-06-01', '2026-06-30');
    expect(Math.abs(recognised - 100000)).toBeLessThanOrEqual(2); // rounding may drift a cent or two
  });

  it('recognition lands in the period the cash arrived, not the invoice date', () => {
    const id = invoice1000('2026-06-01');
    pay(id, 100000, '2026-07-15');
    expect(cashRevenue('2026-06-01', '2026-06-30')).toBe(0); // June: invoiced, unpaid
    expect(cashRevenue('2026-07-01', '2026-07-31')).toBe(100000); // July: paid
  });

  it('spend/receive money is recognised immediately (it is cash)', () => {
    // receive money straight to revenue (it IS cash, recognised immediately)
    banking.createBankTransaction({ bank_account_id: bankId(), type: 'RECEIVE', date: '2026-06-05', contact_id: cust, lines: [{ account_id: acc('200'), quantity: 1, unit_amount: 50000, tax_rate_id: 2, description: 'cash sale' }] });
    expect(cashRevenue('2026-06-01', '2026-06-30')).toBe(50000);
  });

  it('accrual basis still recognises on the invoice date regardless of payment', () => {
    invoice1000('2026-06-01');
    const pl = reports.profitAndLoss({ from: '2026-06-01', to: '2026-06-30', basis: 'ACCRUAL' });
    expect(pl.income.find((r: any) => r.code === '200')!.amount).toBe(100000);
  });
});

describe('ledger integrity check', () => {
  it('reports a clean ledger as ok', () => {
    invoice1000();
    const r = reports.integrityCheck();
    expect(r.ok).toBe(true);
    expect(r.ledger_balanced).toBe(true);
    expect(r.unbalanced_journals).toHaveLength(0);
    expect(r.orphaned_lines).toBe(0);
  });

  it('detects a deliberately corrupted journal line', () => {
    const id = invoice1000();
    // Corrupt one posted line directly (simulating external tampering).
    const line: any = getDb().prepare("SELECT l.id FROM journal_lines l JOIN journals j ON j.id=l.journal_id WHERE j.source_type='INVOICE' LIMIT 1").get();
    getDb().prepare('UPDATE journal_lines SET debit = debit + 999 WHERE id = ?').run(line.id);
    const r = reports.integrityCheck();
    expect(r.ok).toBe(false);
    expect(r.unbalanced_journals.length).toBeGreaterThan(0);
  });
});
