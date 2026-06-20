import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as payments from '../src/backend/services/payments';
import * as reminders from '../src/backend/services/reminders';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
let acme: number, beta: number;
beforeEach(() => { initDatabase(':memory:'); acme = contacts.save({ name: 'Acme Co', is_customer: true, email: 'ap@acme.test' }).id; beta = contacts.save({ name: 'Beta Co', is_customer: true }).id; });
const inv = (cents: number, date: string, due: string, who: number) => { const i = invoices.saveDraft({ type: 'ACCREC', contact_id: who, date, due_date: due, lines: [{ description: 'Job', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: 2 }] }); invoices.approve(i.id); return i.id; };

describe('payment reminders', () => {
  it('lists customers with overdue invoices and the total overdue', () => {
    inv(100000, '2026-03-01', '2026-03-15', acme); // overdue
    inv(50000, '2026-06-20', '2026-07-20', acme);   // not yet due
    inv(30000, '2026-06-05', '2026-06-20', beta);   // overdue
    const l = reminders.list({ as_at: '2026-06-30' });
    expect(l.customers).toHaveLength(2);
    expect(l.totals.total_overdue).toBe(130000); // excludes the not-due 50,000
    const a = l.customers.find((c: any) => c.contact_id === acme);
    expect(a.total_overdue).toBe(100000);
    expect(a.total_outstanding).toBe(150000); // includes the not-due one
  });

  it('excludes fully paid and not-yet-due invoices', () => {
    const paid = inv(40000, '2026-03-01', '2026-03-15', acme);
    payments.create({ type: 'RECEIVE', date: '2026-03-20', bank_account_id: bankId(), contact_id: acme, amount: 40000, allocations: [{ invoice_id: paid, amount: 40000 }] });
    inv(20000, '2026-06-25', '2026-07-25', beta); // future
    const l = reminders.list({ as_at: '2026-06-30' });
    expect(l.customers).toHaveLength(0);
  });

  it('assigns a level by how overdue the oldest invoice is', () => {
    inv(1000, '2026-06-10', '2026-06-25', acme);   // ~5 days → Reminder
    inv(1000, '2026-05-20', '2026-06-01', beta);   // ~29 days → Second notice
    const gamma = contacts.save({ name: 'Gamma', is_customer: true }).id;
    inv(1000, '2026-04-01', '2026-04-15', gamma);  // ~76 days → Final notice
    const l = reminders.list({ as_at: '2026-06-30' });
    expect(l.customers.find((c: any) => c.contact_id === acme).level).toBe('Reminder');
    expect(l.customers.find((c: any) => c.contact_id === beta).level).toBe('Second notice');
    expect(l.customers.find((c: any) => c.contact_id === gamma).level).toBe('Final notice');
  });

  it('honours a minimum-days-overdue filter', () => {
    inv(1000, '2026-06-25', '2026-06-28', acme); // 2 days overdue
    expect(reminders.list({ as_at: '2026-06-30', min_days_overdue: 1 }).customers).toHaveLength(1);
    expect(reminders.list({ as_at: '2026-06-30', min_days_overdue: 7 }).customers).toHaveLength(0);
  });

  it('flags whether a customer has an email on file', () => {
    inv(1000, '2026-03-01', '2026-03-15', acme); // has email
    inv(1000, '2026-03-01', '2026-03-15', beta); // no email
    const l = reminders.list({ as_at: '2026-06-30' });
    expect(l.customers.find((c: any) => c.contact_id === acme).has_email).toBe(true);
    expect(l.customers.find((c: any) => c.contact_id === beta).has_email).toBe(false);
  });

  it('composes a reminder email with the overdue invoices and total', () => {
    inv(100000, '2026-03-01', '2026-03-15', acme);
    inv(25000, '2026-04-01', '2026-04-15', acme);
    const p = reminders.preview({ contact_id: acme, as_at: '2026-06-30' });
    expect(p.to).toBe('ap@acme.test');
    expect(p.has_email).toBe(true);
    expect(p.count).toBe(2);
    expect(p.total).toBe(125000);
    expect(p.subject).toMatch(/payment reminder/i);
    expect(p.body).toContain('Acme Co');
    expect(p.body).toContain('1,000.00'); // an invoice amount appears
    expect(p.body).not.toContain('{'); // all placeholders filled
  });

  it('preview rejects a customer with nothing overdue and unknown contacts', () => {
    inv(1000, '2026-06-25', '2026-07-25', acme); // not due
    expect(() => reminders.preview({ contact_id: acme, as_at: '2026-06-30' })).toThrow(/overdue/i);
    expect(() => reminders.preview({ contact_id: 9999, as_at: '2026-06-30' })).toThrow(/not found/i);
  });

  it('records a sent reminder and surfaces it as last-reminded + history', () => {
    inv(100000, '2026-03-01', '2026-03-15', acme);
    reminders.recordSent({ contact_id: acme, level: 'Final notice', amount: 100000, note: 'emailed' });
    const l = reminders.list({ as_at: '2026-06-30' });
    expect(l.customers.find((c: any) => c.contact_id === acme).last_reminded_at).toBeTruthy();
    const h = reminders.history(acme);
    expect(h).toHaveLength(1);
    expect((h[0] as any).level).toBe('Final notice');
  });
});
