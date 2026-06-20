/**
 * Accruals & deferrals — recognise an amount held in a balance-sheet account
 * (Deferred income, a liability; or Prepaid expenses, an asset) into income or
 * expense evenly over a number of months.
 *
 * Income deferral (kind = INCOME): each period   Dr deferral · Cr recognition
 *   (draws down the unearned-income liability, books revenue)
 * Expense deferral (kind = EXPENSE): each period  Dr recognition · Cr deferral
 *   (books the expense, draws down the prepaid asset)
 *
 * One journal is posted per period, dated to that month, so each slice lands in
 * the right period and the holding account unwinds over time. The rounding
 * remainder goes into the final period so the slices sum to the total exactly.
 * The amount must already sit in the holding account (code the originating
 * invoice/bill to it); this schedule posts the recognition entries.
 */
import { getDb } from '../db';
import { postJournal, systemAccount, today, assertValidDate, assertDateUnlocked, voidJournalsForSource } from '../engine';

const SOURCE = 'DEFERRAL';

function addMonths(iso: string, n: number): string {
  const base = new Date(iso.slice(0, 7) + '-01T00:00:00');
  base.setMonth(base.getMonth() + n);
  const y = base.getFullYear();
  const m = String(base.getMonth() + 1).padStart(2, '0');
  // Keep the original day-of-month where possible, clamped to the month length.
  const day = Math.min(Number(iso.slice(8, 10)) || 1, new Date(y, base.getMonth() + 1, 0).getDate());
  return `${y}-${m}-${String(day).padStart(2, '0')}`;
}

/** Even split of `total` over `periods` cents; the last slice absorbs the remainder. */
function slices(total: number, periods: number): number[] {
  const per = Math.floor(total / periods);
  const out = Array(periods).fill(per);
  out[periods - 1] = total - per * (periods - 1);
  return out;
}

export interface DeferralInput {
  name?: string;
  kind: 'INCOME' | 'EXPENSE';
  deferral_account_id: number;
  recognition_account_id: number;
  contact_id?: number | null;
  total: number;          // cents (positive)
  periods: number;        // months
  start_date: string;
}

export function create(input: DeferralInput, user_id = 1): { id: number; periods: number } {
  const db = getDb();
  if (!input.total || input.total <= 0) throw new Error('Enter an amount greater than zero to recognise');
  if (!input.periods || input.periods < 1) throw new Error('Enter at least one period');
  if (input.periods > 600) throw new Error('That is an unreasonable number of periods');
  assertValidDate(input.start_date, 'Start date');
  if (input.deferral_account_id === input.recognition_account_id) throw new Error('The holding and recognition accounts must be different');

  const deferral: any = db.prepare('SELECT id, type, name FROM accounts WHERE id = ?').get(input.deferral_account_id);
  const recognition: any = db.prepare('SELECT id, type, name FROM accounts WHERE id = ?').get(input.recognition_account_id);
  if (!deferral) throw new Error('Holding account not found');
  if (!recognition) throw new Error('Recognition account not found');
  if (input.kind === 'INCOME' && recognition.type !== 'REVENUE') throw new Error('For an income deferral the recognition account should be a revenue account');
  if (input.kind === 'EXPENSE' && recognition.type !== 'EXPENSE') throw new Error('For an expense deferral the recognition account should be an expense account');
  if (!['ASSET', 'LIABILITY', 'EQUITY'].includes(deferral.type)) throw new Error('The holding account should be a balance-sheet account (e.g. Deferred income or Prepaid expenses)');

  const amounts = slices(input.total, input.periods);

  return db.transaction(() => {
    const id = Number(
      db.prepare(
        `INSERT INTO deferral_schedules (name, kind, deferral_account_id, recognition_account_id, contact_id, total, periods, start_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(input.name ?? null, input.kind, input.deferral_account_id, input.recognition_account_id, input.contact_id ?? null, input.total, input.periods, input.start_date).lastInsertRowid
    );

    amounts.forEach((amt, i) => {
      const date = addMonths(input.start_date, i);
      assertDateUnlocked(date);
      const desc = `${input.name ? input.name + ' — ' : ''}recognition ${i + 1} of ${input.periods}`;
      const lines = input.kind === 'INCOME'
        ? [
            { account_id: input.deferral_account_id, debit: amt, description: desc, contact_id: input.contact_id ?? null },
            { account_id: input.recognition_account_id, credit: amt, description: desc, contact_id: input.contact_id ?? null },
          ]
        : [
            { account_id: input.recognition_account_id, debit: amt, description: desc, contact_id: input.contact_id ?? null },
            { account_id: input.deferral_account_id, credit: amt, description: desc, contact_id: input.contact_id ?? null },
          ];
      postJournal({ date, narration: input.name || (input.kind === 'INCOME' ? 'Revenue recognition' : 'Expense recognition'), source_type: SOURCE, source_id: id, lines, user_id });
    });

    return { id, periods: input.periods };
  });
}

export function list(): any[] {
  const db = getDb();
  return db.prepare(
    `SELECT s.id, s.name, s.kind, s.total, s.periods, s.start_date, s.status,
            da.code AS deferral_code, da.name AS deferral_name,
            ra.code AS recognition_code, ra.name AS recognition_name,
            c.name AS contact_name,
            (SELECT COALESCE(SUM(jl.debit), 0) FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
              WHERE j.source_type = '${SOURCE}' AND j.source_id = s.id AND j.status = 'POSTED' AND j.date <= date('now')) AS recognised_to_date
       FROM deferral_schedules s
       JOIN accounts da ON da.id = s.deferral_account_id
       JOIN accounts ra ON ra.id = s.recognition_account_id
       LEFT JOIN contacts c ON c.id = s.contact_id
      WHERE s.status <> 'VOIDED'
      ORDER BY s.start_date DESC, s.id DESC`
  ).all();
}

/** A schedule with its month-by-month postings and how much is recognised to date. */
export function get(id: number, as_at?: string): any {
  const db = getDb();
  const s: any = db.prepare('SELECT * FROM deferral_schedules WHERE id = ?').get(id);
  if (!s) throw new Error('Schedule not found');
  const asAt = as_at ?? today();
  const journals = db.prepare(
    `SELECT j.id, j.date, j.status,
            (SELECT COALESCE(SUM(jl.debit), 0) FROM journal_lines jl WHERE jl.journal_id = j.id AND jl.account_id = ?) AS amount
       FROM journals j
      WHERE j.source_type = ? AND j.source_id = ? AND j.status = 'POSTED'
      ORDER BY j.date, j.id`
  ).all(s.kind === 'INCOME' ? s.deferral_account_id : s.recognition_account_id, SOURCE, id) as any[];
  const periods = journals.map((j) => ({ date: j.date, amount: j.amount as number, recognised: j.date <= asAt }));
  const recognised = periods.filter((p) => p.recognised).reduce((t, p) => t + p.amount, 0);
  return { ...s, periods, recognised_to_date: recognised, remaining: (s.total as number) - recognised };
}

export function progress(id: number, as_at?: string) {
  const g = get(id, as_at);
  return { id, total: g.total, recognised_to_date: g.recognised_to_date, remaining: g.remaining, periods: g.periods.length };
}

/** Void a schedule: reverse every recognition journal and mark it voided. */
export function voidSchedule(id: number, user_id = 1): { id: number; status: string } {
  const db = getDb();
  const s: any = db.prepare('SELECT status FROM deferral_schedules WHERE id = ?').get(id);
  if (!s) throw new Error('Schedule not found');
  if (s.status === 'VOIDED') throw new Error('This schedule is already voided');
  return db.transaction(() => {
    voidJournalsForSource(SOURCE, id, user_id);
    db.prepare("UPDATE deferral_schedules SET status = 'VOIDED' WHERE id = ?").run(id);
    return { id, status: 'VOIDED' };
  });
}
