import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
let cust: number, other: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'Acme Co', is_customer: true, email: 'ap@acme.test' }).id; other = contacts.save({ name: 'Other Co', is_customer: true }).id; });

const inv = (cents: number, date: string, due: string, who = cust) => { const i = invoices.saveDraft({ type: 'ACCREC', contact_id: who, date, due_date: due, lines: [{ description: 'Job', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: 2 }] }); invoices.approve(i.id); return i.id; };

describe('customer statement', () => {
  it('OUTSTANDING lists unpaid invoices with the total owed', () => {
    inv(100000, '2026-05-01', '2026-05-15');
    const i2 = inv(50000, '2026-06-01', '2026-06-15');
    payments.create({ type: 'RECEIVE', date: '2026-06-10', bank_account_id: bankId(), contact_id: cust, amount: 30000, allocations: [{ invoice_id: i2, amount: 30000 }] });
    const s: any = reports.customerStatement({ contact_id: cust, type: 'OUTSTANDING', as_at: '2026-06-30' });
    expect(s.lines).toHaveLength(2);
    expect(s.total).toBe(120000); // 100,000 + 20,000 remaining
    expect(s.lines.find((l: any) => l.amount_due === 20000)).toBeTruthy();
  });

  it('OUTSTANDING excludes fully paid invoices', () => {
    const i = inv(40000, '2026-05-01', '2026-05-15');
    payments.create({ type: 'RECEIVE', date: '2026-05-20', bank_account_id: bankId(), contact_id: cust, amount: 40000, allocations: [{ invoice_id: i, amount: 40000 }] });
    const s: any = reports.customerStatement({ contact_id: cust, type: 'OUTSTANDING', as_at: '2026-06-30' });
    expect(s.lines).toHaveLength(0);
    expect(s.total).toBe(0);
  });

  it('OUTSTANDING ages by due date', () => {
    inv(100000, '2026-03-01', '2026-03-15'); // ~3 months overdue at as_at
    inv(50000, '2026-06-20', '2026-07-20');  // not yet due
    const s: any = reports.customerStatement({ contact_id: cust, type: 'OUTSTANDING', as_at: '2026-06-30' });
    expect(s.aging.current).toBe(50000);
    expect(s.aging.d90_plus).toBe(100000);
    expect(s.total).toBe(150000);
  });

  it('OUTSTANDING treats credit notes as negative', () => {
    inv(100000, '2026-06-01', '2026-06-15');
    const cn = invoices.saveDraft({ type: 'ACCRECCREDIT', contact_id: cust, date: '2026-06-05', lines: [{ description: 'Return', quantity: 1, unit_amount: 20000, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(cn.id);
    const s: any = reports.customerStatement({ contact_id: cust, type: 'OUTSTANDING', as_at: '2026-06-30' });
    const credit = s.lines.find((l: any) => l.type === 'Credit note');
    expect(credit).toBeTruthy();
    expect(credit.amount_due).toBe(-20000);
    expect(s.total).toBe(80000); // 100,000 − 20,000
  });

  it('ACTIVITY shows opening, transactions with a running balance, and closing', () => {
    inv(100000, '2026-05-01', '2026-05-15');
    const i2 = inv(50000, '2026-06-01', '2026-06-15');
    payments.create({ type: 'RECEIVE', date: '2026-06-10', bank_account_id: bankId(), contact_id: cust, amount: 30000, allocations: [{ invoice_id: i2, amount: 30000 }] });
    const s: any = reports.customerStatement({ contact_id: cust, type: 'ACTIVITY', from: '2026-05-01', to: '2026-06-30' });
    expect(s.opening_balance).toBe(0);
    expect(s.lines).toHaveLength(3); // 2 invoices + 1 payment
    expect(s.closing_balance).toBe(120000);
    expect(s.lines[s.lines.length - 1].balance).toBe(120000);
    expect(s.lines.find((l: any) => l.type === 'Payment')?.credit).toBe(30000);
  });

  it('ACTIVITY opening balance reflects activity before the period', () => {
    inv(100000, '2026-04-01', '2026-04-15'); // before the window
    inv(50000, '2026-06-01', '2026-06-15');  // inside
    const s: any = reports.customerStatement({ contact_id: cust, type: 'ACTIVITY', from: '2026-05-01', to: '2026-06-30' });
    expect(s.opening_balance).toBe(100000);
    expect(s.closing_balance).toBe(150000);
    expect(s.lines).toHaveLength(1); // only the in-period invoice
  });

  it('only includes the requested customer', () => {
    inv(100000, '2026-06-01', '2026-06-15', cust);
    inv(70000, '2026-06-01', '2026-06-15', other);
    const s: any = reports.customerStatement({ contact_id: cust, type: 'OUTSTANDING', as_at: '2026-06-30' });
    expect(s.total).toBe(100000);
    expect(s.contact.name).toBe('Acme Co');
  });

  it('rejects an unknown contact and a missing from date', () => {
    expect(() => reports.customerStatement({ contact_id: 9999, type: 'OUTSTANDING' })).toThrow(/not found/i);
    expect(() => reports.customerStatement({ contact_id: cust, type: 'ACTIVITY' })).toThrow(/from date/i);
  });
});
