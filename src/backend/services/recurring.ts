/**
 * Recurring invoices & bills. A template holds the lines and a schedule; the
 * generator turns due templates into real documents using the exact same path
 * a person would (invoices.saveDraft / approve), so nothing about posting,
 * tax, or numbering behaves differently. Because this app has no server cron,
 * generation runs opportunistically when the app is open — defaulting to
 * drafts so nothing posts behind your back unless a template opts in.
 */
import { getDb } from '../db';
import { assertValidDate, today } from '../engine';
import * as invoices from './invoices';

export type Frequency = 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface RecurringInput {
  id?: number;
  name: string;
  type: 'ACCREC' | 'ACCPAY';
  contact_id: number;
  line_amount_type?: string;
  reference?: string;
  frequency: Frequency;
  every_n?: number;
  due_days?: number;
  start_date: string;
  end_date?: string | null;
  end_after?: number | null;
  auto_approve?: boolean;
  lines: Array<{
    item_id?: number | null;
    description: string;
    quantity: number;
    unit_amount: number;
    discount_percent?: number;
    account_id: number;
    tax_rate_id?: number | null;
    tracking_option_1?: number | null;
    tracking_option_2?: number | null;
  }>;
}

function daysInMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

/**
 * Advance an ISO date by one schedule step. Monthly/yearly steps anchor to a
 * day-of-month and clamp into short months (e.g. the 31st becomes the 28th in
 * February) so the schedule never drifts or lands on an invalid date.
 */
export function advance(dateIso: string, frequency: Frequency, everyN = 1, anchorDay?: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  if (frequency === 'WEEKLY') {
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + 7 * everyN);
    return dt.toISOString().slice(0, 10);
  }
  const anchor = anchorDay ?? d;
  if (frequency === 'MONTHLY') {
    let mi = (m - 1) + everyN;
    let yr = y + Math.floor(mi / 12);
    mi = ((mi % 12) + 12) % 12;
    const day = Math.min(anchor, daysInMonth(yr, mi));
    return `${yr}-${String(mi + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  // YEARLY
  const yr = y + everyN;
  const day = Math.min(anchor, daysInMonth(yr, m - 1));
  return `${yr}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addDays(dateIso: string, n: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/** The next few issue dates from a template, for the editor's preview. */
export function previewDates(input: { frequency: Frequency; every_n?: number; start_date: string; end_date?: string | null; end_after?: number | null }, count = 4): string[] {
  const out: string[] = [];
  const anchor = Number(input.start_date.split('-')[2]);
  let d = input.start_date;
  for (let i = 0; i < count; i++) {
    if (input.end_date && d > input.end_date) break;
    if (input.end_after && i >= input.end_after) break;
    out.push(d);
    d = advance(d, input.frequency, input.every_n ?? 1, anchor);
  }
  return out;
}

function validate(input: RecurringInput) {
  if (!input.name?.trim()) throw new Error('Give the schedule a name');
  if (input.type !== 'ACCREC' && input.type !== 'ACCPAY') throw new Error('A recurring document must be an invoice or a bill');
  if (!input.contact_id) throw new Error('Choose a contact');
  if (!['WEEKLY', 'MONTHLY', 'YEARLY'].includes(input.frequency)) throw new Error('Pick a valid frequency');
  if ((input.every_n ?? 1) < 1) throw new Error('The interval must be at least 1');
  assertValidDate(input.start_date, 'Start date');
  if (input.end_date) assertValidDate(input.end_date, 'End date');
  if (input.end_date && input.end_date < input.start_date) throw new Error('The end date is before the start date');
  if (!input.lines?.length) throw new Error('Add at least one line');
  input.lines.forEach((l, i) => {
    if (!l.description?.trim() || !l.account_id) throw new Error(`Line ${i + 1}: needs a description and an account`);
    if (!(l.quantity > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
  });
}

export function save(input: RecurringInput): number {
  const db = getDb();
  validate(input);
  const anchorDay = Number(input.start_date.split('-')[2]);
  return db.transaction(() => {
    let id = input.id ?? 0;
    if (id) {
      const ex: any = db.prepare('SELECT next_date, issued_count FROM recurring_templates WHERE id = ?').get(id);
      if (!ex) throw new Error('Schedule not found');
      db.prepare(
        `UPDATE recurring_templates SET name=?, type=?, contact_id=?, line_amount_type=?, reference=?,
           frequency=?, every_n=?, anchor_day=?, due_days=?, start_date=?, end_date=?, end_after=?, auto_approve=?
         WHERE id=?`
      ).run(input.name, input.type, input.contact_id, input.line_amount_type ?? 'EXCLUSIVE', input.reference ?? null,
        input.frequency, input.every_n ?? 1, anchorDay, input.due_days ?? 14, input.start_date,
        input.end_date ?? null, input.end_after ?? null, input.auto_approve ? 1 : 0, id);
      // If it hasn't issued yet, keep next_date aligned to the (possibly new) start.
      if (!ex.issued_count) db.prepare('UPDATE recurring_templates SET next_date = ? WHERE id = ?').run(input.start_date, id);
      db.prepare('DELETE FROM recurring_template_lines WHERE template_id = ?').run(id);
    } else {
      id = Number(db.prepare(
        `INSERT INTO recurring_templates (name, type, contact_id, line_amount_type, reference, frequency, every_n, anchor_day, due_days, start_date, next_date, end_date, end_after, auto_approve, status)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'ACTIVE')`
      ).run(input.name, input.type, input.contact_id, input.line_amount_type ?? 'EXCLUSIVE', input.reference ?? null,
        input.frequency, input.every_n ?? 1, anchorDay, input.due_days ?? 14, input.start_date, input.start_date,
        input.end_date ?? null, input.end_after ?? null, input.auto_approve ? 1 : 0).lastInsertRowid);
    }
    const ins = db.prepare(
      `INSERT INTO recurring_template_lines (template_id, line_order, item_id, description, quantity, unit_amount, discount_percent, account_id, tax_rate_id, tracking_option_1, tracking_option_2)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    input.lines.forEach((l, i) => ins.run(id, i, l.item_id ?? null, l.description, l.quantity, l.unit_amount, l.discount_percent ?? 0, l.account_id, l.tax_rate_id ?? null, l.tracking_option_1 ?? null, l.tracking_option_2 ?? null));
    return id;
  });
}

export function list() {
  const db = getDb();
  return db.prepare(
    `SELECT t.*, c.name AS contact_name,
            (SELECT COALESCE(SUM(quantity * unit_amount),0) FROM recurring_template_lines WHERE template_id = t.id) AS rough_total
       FROM recurring_templates t LEFT JOIN contacts c ON c.id = t.contact_id
      ORDER BY CASE t.status WHEN 'ACTIVE' THEN 0 WHEN 'PAUSED' THEN 1 ELSE 2 END, t.next_date`
  ).all();
}

export function get(id: number) {
  const db = getDb();
  const t: any = db.prepare('SELECT t.*, c.name AS contact_name FROM recurring_templates t LEFT JOIN contacts c ON c.id = t.contact_id WHERE t.id = ?').get(id);
  if (!t) throw new Error('Schedule not found');
  t.lines = db.prepare(
    `SELECT l.*, a.code AS account_code, a.name AS account_name, tr.name AS tax_rate_name
       FROM recurring_template_lines l JOIN accounts a ON a.id = l.account_id
       LEFT JOIN tax_rates tr ON tr.id = l.tax_rate_id WHERE l.template_id = ? ORDER BY l.line_order`
  ).all(id);
  return t;
}

export function setStatus(id: number, status: 'ACTIVE' | 'PAUSED' | 'ENDED') {
  getDb().prepare('UPDATE recurring_templates SET status = ? WHERE id = ?').run(status, id);
}

export function remove(id: number) {
  const db = getDb();
  db.transaction(() => {
    // Generated documents are real and stay; we just detach them.
    db.prepare('UPDATE invoices SET recurring_template_id = NULL WHERE recurring_template_id = ?').run(id);
    db.prepare('DELETE FROM recurring_template_lines WHERE template_id = ?').run(id);
    db.prepare('DELETE FROM recurring_templates WHERE id = ?').run(id);
  });
}

function templateLinesAsDoc(id: number) {
  const db = getDb();
  return db.prepare(
    `SELECT item_id, description, quantity, unit_amount, discount_percent, account_id, tax_rate_id, tracking_option_1, tracking_option_2
       FROM recurring_template_lines WHERE template_id = ? ORDER BY line_order`
  ).all(id) as any[];
}

/** Create ONE document from a template for a given issue date, advancing the schedule. */
function issueOne(t: any, issueDate: string, user_id: number): number {
  const db = getDb();
  const doc = invoices.saveDraft({
    type: t.type,
    contact_id: t.contact_id,
    date: issueDate,
    due_date: addDays(issueDate, t.due_days ?? 14),
    reference: t.reference ?? undefined,
    line_amount_type: t.line_amount_type,
    lines: templateLinesAsDoc(t.id),
  }, user_id);
  db.prepare('UPDATE invoices SET recurring_template_id = ? WHERE id = ?').run(t.id, doc.id);
  if (t.auto_approve) invoices.approve(doc.id, user_id);
  // Advance the schedule.
  const nextDate = advance(issueDate, t.frequency, t.every_n ?? 1, t.anchor_day ?? undefined);
  const issued = (t.issued_count ?? 0) + 1;
  const ended = (t.end_after && issued >= t.end_after) || (t.end_date && nextDate > t.end_date);
  db.prepare('UPDATE recurring_templates SET next_date = ?, issued_count = ?, status = ? WHERE id = ?')
    .run(nextDate, issued, ended ? 'ENDED' : t.status, t.id);
  t.next_date = nextDate; t.issued_count = issued; if (ended) t.status = 'ENDED';
  return doc.id;
}

/**
 * Generate every document due on or before `asOf` (default today), catching up
 * if several periods have passed. Returns what it created so the UI can report.
 */
export function generateDue(asOf?: string, user_id = 1): { count: number; created: Array<{ template_id: number; name: string; invoice_id: number; date: string }> } {
  const db = getDb();
  const when = asOf ?? today();
  const created: Array<{ template_id: number; name: string; invoice_id: number; date: string }> = [];
  const dueTemplates = db.prepare("SELECT * FROM recurring_templates WHERE status = 'ACTIVE' AND next_date <= ?").all(when) as any[];
  for (const t of dueTemplates) {
    // Catch up period-by-period, but guard against runaway loops.
    let guard = 0;
    while (t.status === 'ACTIVE' && t.next_date <= when && guard < 240) {
      const issueDate = t.next_date;
      const invoice_id = issueOne(t, issueDate, user_id);
      created.push({ template_id: t.id, name: t.name, invoice_id, date: issueDate });
      guard += 1;
    }
  }
  return { count: created.length, created };
}

/** Manually issue the next document now (used by the "Generate now" button). */
export function runNow(id: number, user_id = 1): number {
  const db = getDb();
  const t: any = db.prepare('SELECT * FROM recurring_templates WHERE id = ?').get(id);
  if (!t) throw new Error('Schedule not found');
  if (t.status === 'ENDED') throw new Error('This schedule has ended');
  return issueOne(t, t.next_date, user_id);
}

/** Count due now, for a badge. */
export function dueCount(asOf?: string): number {
  const when = asOf ?? today();
  return Number(getDb().prepare("SELECT COUNT(*) AS n FROM recurring_templates WHERE status = 'ACTIVE' AND next_date <= ?").get(when).n);
}
