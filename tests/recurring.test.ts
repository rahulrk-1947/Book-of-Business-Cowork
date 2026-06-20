import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as recurring from '../src/backend/services/recurring';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('recurring schedule math', () => {
  it('advances weekly/fortnightly/monthly/yearly correctly', () => {
    expect(recurring.advance('2026-01-05', 'WEEKLY', 1)).toBe('2026-01-12');
    expect(recurring.advance('2026-01-05', 'WEEKLY', 2)).toBe('2026-01-19'); // fortnightly
    expect(recurring.advance('2026-01-15', 'MONTHLY', 1)).toBe('2026-02-15');
    expect(recurring.advance('2026-01-15', 'MONTHLY', 3)).toBe('2026-04-15'); // quarterly
    expect(recurring.advance('2026-03-10', 'YEARLY', 1)).toBe('2027-03-10');
  });

  it('clamps month-end anchors into short months', () => {
    // 31 Jan + 1 month → 28 Feb (2026 is not a leap year)
    expect(recurring.advance('2026-01-31', 'MONTHLY', 1, 31)).toBe('2026-02-28');
    // then keeps the 31 anchor for March
    expect(recurring.advance('2026-02-28', 'MONTHLY', 1, 31)).toBe('2026-03-31');
  });

  it('rolls over the year boundary', () => {
    expect(recurring.advance('2026-11-20', 'MONTHLY', 2, 20)).toBe('2027-01-20');
  });

  it('previews the next few issue dates and respects end-after', () => {
    const d = recurring.previewDates({ frequency: 'MONTHLY', every_n: 1, start_date: '2026-01-10', end_after: 3 }, 6);
    expect(d).toEqual(['2026-01-10', '2026-02-10', '2026-03-10']);
  });
});

describe('recurring generation', () => {
  let cust: number;
  const mkTemplate = (over: any = {}) => recurring.save({
    name: 'Monthly retainer', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', every_n: 1,
    start_date: '2026-01-01', due_days: 14,
    lines: [{ description: 'Retainer', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 2 }],
    ...over,
  });

  beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'Recur Co', is_customer: true }).id; });

  it('creates a draft invoice when due and advances the schedule', () => {
    const id = mkTemplate();
    const r = recurring.generateDue('2026-01-05');
    expect(r.count).toBe(1);
    const inv = invoices.get(r.created[0].invoice_id);
    expect(inv.status).toBe('DRAFT');           // safe default
    expect(inv.contact_id).toBe(cust);
    expect(inv.total).toBe(100000);             // matches the line total (seed tax rate 2 is 0%)
    expect(inv.recurring_template_id).toBe(id);
    const t = recurring.get(id);
    expect(t.next_date).toBe('2026-02-01');     // advanced
    expect(t.issued_count).toBe(1);
  });

  it('auto-approves when the template opts in', () => {
    const id = mkTemplate({ auto_approve: true });
    const r = recurring.generateDue('2026-01-02');
    expect(invoices.get(r.created[0].invoice_id).status).toBe('AUTHORISED');
    expect(id).toBeGreaterThan(0);
  });

  it('catches up multiple missed periods in one run', () => {
    mkTemplate();
    // Three months have passed since the Jan 1 start.
    const r = recurring.generateDue('2026-03-15');
    expect(r.count).toBe(3); // Jan, Feb, Mar
    expect(r.created.map((c) => c.date)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
  });

  it('stops at end_after and marks the schedule ENDED', () => {
    const id = mkTemplate({ end_after: 2 });
    const r = recurring.generateDue('2026-12-31');
    expect(r.count).toBe(2);
    expect(recurring.get(id).status).toBe('ENDED');
  });

  it('stops at end_date', () => {
    const id = mkTemplate({ end_date: '2026-02-15' });
    const r = recurring.generateDue('2026-12-31');
    expect(r.count).toBe(2); // Jan 1 and Feb 1; Mar 1 is past end_date
    expect(recurring.get(id).status).toBe('ENDED');
  });

  it('does not generate for paused schedules', () => {
    const id = mkTemplate();
    recurring.setStatus(id, 'PAUSED');
    expect(recurring.generateDue('2026-06-01').count).toBe(0);
    recurring.setStatus(id, 'ACTIVE');
    expect(recurring.generateDue('2026-06-01').count).toBeGreaterThan(0);
  });

  it('runNow issues the next document immediately', () => {
    const id = mkTemplate({ start_date: '2026-05-01' });
    const invId = recurring.runNow(id);
    expect(invoices.get(invId).status).toBe('DRAFT');
    expect(recurring.get(id).next_date).toBe('2026-06-01');
  });

  it('validates inputs', () => {
    expect(() => recurring.save({ name: '', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', start_date: '2026-01-01', lines: [] } as any)).toThrow(/name/i);
    expect(() => recurring.save({ name: 'x', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', start_date: '2026-02-30', lines: [{ description: 'a', quantity: 1, unit_amount: 100, account_id: acc('200') }] })).toThrow(/calendar date/i);
    expect(() => recurring.save({ name: 'x', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', start_date: '2026-01-01', lines: [{ description: 'a', quantity: 0, unit_amount: 100, account_id: acc('200') }] })).toThrow(/quantity/i);
  });

  it('detaches generated invoices but keeps them when a template is deleted', () => {
    const id = mkTemplate();
    const r = recurring.generateDue('2026-01-05');
    const invId = r.created[0].invoice_id;
    recurring.remove(id);
    expect(invoices.get(invId)).toBeTruthy(); // invoice still exists
    expect(invoices.get(invId).recurring_template_id).toBeNull();
  });
});
