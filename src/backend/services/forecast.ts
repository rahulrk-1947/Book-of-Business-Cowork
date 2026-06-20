/**
 * Cash-flow forecast. Looks forward, not back: starting from the cash you have
 * now, it projects where your balance is heading by laying out the money you
 * expect to come in and go out — outstanding invoices and bills on their due
 * dates, plus the documents your recurring schedules will raise within the
 * horizon. It's an estimate (it assumes things get paid on their due date),
 * but it's the picture an owner needs to spot a squeeze before it happens.
 */
import { getDb } from '../db';
import { today, baseCurrency } from '../engine';
import { advance } from './recurring';

type Movement = {
  date: string;
  label: string;
  kind: 'invoice' | 'bill' | 'recurring_in' | 'recurring_out';
  in: number;   // cents
  out: number;  // cents
  estimated: boolean; // recurring/projected vs a real outstanding document
  source?: { type: string; id: number };
};

function addDays(dateIso: string, n: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function isoMonday(dateIso: string): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = (dt.getUTCDay() + 6) % 7; // 0 = Monday
  dt.setUTCDate(dt.getUTCDate() - dow);
  return dt.toISOString().slice(0, 10);
}

export function cashFlow(params: { horizon_days?: number; as_of?: string } = {}) {
  const db = getDb();
  const asOf = params.as_of ?? today();
  const horizon = Math.max(7, Math.min(params.horizon_days ?? 90, 730));
  const end = addDays(asOf, horizon);

  // Opening cash = current balance across active bank accounts.
  const opening = Number(db.prepare(
    `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS bal
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id AND a.is_bank_account = 1 AND a.status = 'ACTIVE'
       JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'`
  ).get().bal);

  const movements: Movement[] = [];

  // Outstanding invoices & bills — expected to settle on their due date.
  // Anything already overdue is treated as due now (asOf) — you're owed it.
  const docs = db.prepare(
    `SELECT i.id, i.type, i.invoice_number, i.due_date, i.date, i.amount_due, c.name AS contact
       FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
      WHERE i.status = 'AUTHORISED' AND i.amount_due > 0`
  ).all() as any[];
  for (const d of docs) {
    const expected = (d.due_date && d.due_date > asOf) ? d.due_date : asOf;
    if (expected > end) continue; // settles beyond the horizon
    const isIn = d.type === 'ACCREC';            // money in
    const isOut = d.type === 'ACCPAY';           // money out
    const isCreditIn = d.type === 'ACCPAYCREDIT'; // supplier credit reduces what we pay → inflow-ish
    const isCreditOut = d.type === 'ACCRECCREDIT'; // our credit note reduces what we collect → outflow-ish
    const amt = d.amount_due;
    movements.push({
      date: expected,
      label: `${d.invoice_number}${d.contact ? ' · ' + d.contact : ''}`,
      kind: isIn || isCreditIn ? 'invoice' : 'bill',
      in: (isIn || isCreditIn) ? amt : 0,
      out: (isOut || isCreditOut) ? amt : 0,
      estimated: false,
      source: { type: 'INVOICE', id: d.id },
    });
  }

  // Upcoming recurring documents — each projected issue settles on issue + due_days.
  const templates = db.prepare("SELECT * FROM recurring_templates WHERE status = 'ACTIVE'").all() as any[];
  for (const t of templates) {
    // Roughly value the template from its lines (tax-exclusive estimate is fine for a forecast).
    const rough = Number(db.prepare(
      'SELECT COALESCE(SUM(quantity * unit_amount), 0) AS v FROM recurring_template_lines WHERE template_id = ?'
    ).get(t.id).v);
    if (rough <= 0) continue;
    let issue = t.next_date;
    let guard = 0;
    while (guard < 60) {
      const settle = addDays(issue, t.due_days ?? 14);
      if (issue > end) break;                    // issued beyond the horizon
      if (t.end_date && issue > t.end_date) break;
      if (t.end_after && guard >= 0) { /* end_after is tracked by issued_count at runtime; for the forecast we just project within horizon */ }
      if (settle >= asOf && settle <= end) {
        const isIn = t.type === 'ACCREC';
        movements.push({
          date: settle,
          label: `${t.name} (scheduled)`,
          kind: isIn ? 'recurring_in' : 'recurring_out',
          in: isIn ? rough : 0,
          out: isIn ? 0 : rough,
          estimated: true,
        });
      }
      issue = advance(issue, t.frequency, t.every_n ?? 1, t.anchor_day ?? undefined);
      guard += 1;
    }
  }

  movements.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // Running balance across the sorted movements.
  let running = opening;
  let lowest = opening;
  let lowestDate = asOf;
  let firstNegativeDate: string | null = null;
  for (const m of movements) {
    running += m.in - m.out;
    (m as any).balance = running;
    if (running < lowest) { lowest = running; lowestDate = m.date; }
    if (running < 0 && !firstNegativeDate) firstNegativeDate = m.date;
  }

  // Weekly buckets for the chart: closing projected balance at each week.
  const weeks: Array<{ week_start: string; in: number; out: number; balance: number }> = [];
  const byWeek = new Map<string, { in: number; out: number }>();
  for (const m of movements) {
    const wk = isoMonday(m.date);
    const cur = byWeek.get(wk) ?? { in: 0, out: 0 };
    cur.in += m.in; cur.out += m.out;
    byWeek.set(wk, cur);
  }
  let wkRunning = opening;
  // Walk week starts from asOf's week through the horizon so the line is continuous.
  let cursor = isoMonday(asOf);
  while (cursor <= end) {
    const b = byWeek.get(cursor) ?? { in: 0, out: 0 };
    wkRunning += b.in - b.out;
    weeks.push({ week_start: cursor, in: b.in, out: b.out, balance: wkRunning });
    cursor = addDays(cursor, 7);
  }

  const totalIn = movements.reduce((s, m) => s + m.in, 0);
  const totalOut = movements.reduce((s, m) => s + m.out, 0);

  return {
    as_of: asOf,
    horizon_days: horizon,
    end,
    currency: baseCurrency(),
    opening,
    total_in: totalIn,
    total_out: totalOut,
    projected_closing: opening + totalIn - totalOut,
    lowest_balance: lowest,
    lowest_date: lowestDate,
    first_negative_date: firstNegativeDate,
    movements,
    weeks,
  };
}
