/**
 * Payment reminders — find customers with overdue invoices and compose a
 * ready-to-send reminder from an editable template. Like the rest of emailing
 * in this app, sending is a hand-off (the message opens in the operator's mail
 * client), because one-click delivery needs a mail server. A reminder log
 * records when each customer was last chased.
 */
import { getDb } from '../db';
import { today } from '../engine';
import { formatCents } from '../money';
import { getTemplate } from './email';

const DAY = 86400000;
const days = (a: string, b: string) => Math.floor((Date.parse(a) - Date.parse(b)) / DAY);
const levelFor = (overdue: number) => (overdue >= 31 ? 'Final notice' : overdue >= 15 ? 'Second notice' : 'Reminder');

function fmtDate(iso: string) {
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** Customers with at least one overdue invoice as at a date. */
export function list(params: { as_at?: string; min_days_overdue?: number } = {}) {
  const db = getDb();
  const asAt = params.as_at ?? today();
  const minDays = params.min_days_overdue ?? 1;
  const rows = db.prepare(
    `SELECT c.id AS contact_id, c.name, c.email, i.invoice_number, i.date, i.due_date, i.amount_due
       FROM invoices i JOIN contacts c ON c.id = i.contact_id
      WHERE i.type = 'ACCREC' AND i.status = 'AUTHORISED' AND i.amount_due > 0 AND i.date <= ?
      ORDER BY c.name, COALESCE(i.due_date, i.date)`
  ).all(asAt) as any[];

  const lastByContact = new Map<number, string>();
  for (const r of db.prepare('SELECT contact_id, MAX(sent_at) AS last FROM reminder_log GROUP BY contact_id').all() as any[]) {
    lastByContact.set(r.contact_id, r.last);
  }

  const byContact = new Map<number, any>();
  for (const r of rows) {
    const due = r.due_date ?? r.date;
    const overdue = days(asAt, due);
    let c = byContact.get(r.contact_id);
    if (!c) {
      c = { contact_id: r.contact_id, name: r.name, email: r.email, invoice_count: 0, total_outstanding: 0, total_overdue: 0, oldest_days_overdue: 0 };
      byContact.set(r.contact_id, c);
    }
    c.total_outstanding += r.amount_due;
    c.invoice_count += 1;
    if (overdue >= 1) {
      c.total_overdue += r.amount_due;
      c.oldest_days_overdue = Math.max(c.oldest_days_overdue, overdue);
    }
  }

  const customers = [...byContact.values()]
    .filter((c) => c.oldest_days_overdue >= minDays)
    .map((c) => {
      const last = lastByContact.get(c.contact_id) || null;
      return {
        ...c,
        level: levelFor(c.oldest_days_overdue),
        has_email: !!c.email,
        last_reminded_at: last,
        last_reminded_days: last ? Math.max(0, days(asAt, last.slice(0, 10))) : null,
      };
    })
    .sort((a, b) => b.oldest_days_overdue - a.oldest_days_overdue);

  const totals = {
    customers: customers.length,
    total_overdue: customers.reduce((s, c) => s + c.total_overdue, 0),
  };
  return { as_at: asAt, customers, totals };
}

/** Compose the reminder email for one customer (recipient, subject, body). */
export function preview(params: { contact_id: number; as_at?: string }) {
  const db = getDb();
  const asAt = params.as_at ?? today();
  const contact: any = db.prepare('SELECT id, name, email FROM contacts WHERE id = ?').get(params.contact_id);
  if (!contact) throw new Error('Contact not found');
  const org: any = db.prepare('SELECT trading_name, legal_name, invoice_footer FROM organisations LIMIT 1').get() || {};
  const orgName = org.trading_name || org.legal_name || 'us';

  const invs = db.prepare(
    `SELECT invoice_number, date, due_date, amount_due
       FROM invoices
      WHERE contact_id = ? AND type = 'ACCREC' AND status = 'AUTHORISED' AND amount_due > 0 AND date <= ?
      ORDER BY COALESCE(due_date, date)`
  ).all(params.contact_id, asAt) as any[];
  const overdue = invs.filter((i) => days(asAt, i.due_date ?? i.date) >= 1);
  if (overdue.length === 0) throw new Error('This customer has no overdue invoices');

  const total = overdue.reduce((s, i) => s + i.amount_due, 0);
  const oldest = Math.max(...overdue.map((i) => days(asAt, i.due_date ?? i.date)));
  const lines = overdue.map((i) => {
    const due = i.due_date ?? i.date;
    const od = days(asAt, due);
    return `• ${i.invoice_number || 'Invoice'} — due ${fmtDate(due)} — ${formatCents(i.amount_due)} (${od} day${od === 1 ? '' : 's'} overdue)`;
  }).join('\n');

  const tpl = getTemplate('REMINDER');
  const fill = (s: string) => s
    .replace(/\{contact\}/g, contact.name)
    .replace(/\{org\}/g, orgName)
    .replace(/\{total\}/g, formatCents(total))
    .replace(/\{invoices\}/g, lines)
    .replace(/\{footer\}/g, org.invoice_footer || '')
    .replace(/\\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    contact_id: contact.id,
    to: contact.email || '',
    has_email: !!contact.email,
    subject: fill(tpl.subject),
    body: fill(tpl.body),
    count: overdue.length,
    total,
    level: levelFor(oldest),
  };
}

/** Record that a reminder was sent to a customer (for the "last reminded" column). */
export function recordSent(input: { contact_id: number; level?: string; amount?: number; note?: string }) {
  const db = getDb();
  const contact = db.prepare('SELECT id FROM contacts WHERE id = ?').get(input.contact_id);
  if (!contact) throw new Error('Contact not found');
  const id = Number(
    db.prepare('INSERT INTO reminder_log (contact_id, level, amount, note) VALUES (?, ?, ?, ?)')
      .run(input.contact_id, input.level ?? null, input.amount ?? null, input.note ?? null).lastInsertRowid
  );
  return { id };
}

/** Reminder history for one customer. */
export function history(contact_id: number) {
  return getDb().prepare('SELECT id, sent_at, level, amount, note FROM reminder_log WHERE contact_id = ? ORDER BY sent_at DESC').all(contact_id);
}
