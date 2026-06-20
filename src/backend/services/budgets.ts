/**
 * Budgets and budget-vs-actual.
 *
 * A budget holds a monthly target amount per income/expense account across a
 * 12-month window. Amounts are stored in the account's natural P&L sign
 * (income positive when you expect to earn it, expenses positive when you
 * expect to spend it), so they line up directly with the actuals pulled from
 * the ledger the same way the Profit & Loss does.
 */
import { getDb } from '../db';
import { assertValidDate } from '../engine';

const DEBIT_NATURAL = new Set(['ASSET', 'EXPENSE']);
function natural(type: string, dr: number, cr: number): number {
  return DEBIT_NATURAL.has(type) ? dr - cr : cr - dr;
}

/** The 12 month-start dates of a budget, from its start month. */
export function months(startMonth: string): string[] {
  const [y, m] = startMonth.split('-').map(Number);
  const out: string[] = [];
  for (let i = 0; i < 12; i++) {
    const mi = (m - 1) + i;
    const yr = y + Math.floor(mi / 12);
    const mo = (mi % 12) + 1;
    out.push(`${yr}-${String(mo).padStart(2, '0')}-01`);
  }
  return out;
}

function firstOfMonth(dateIso: string): string {
  return dateIso.slice(0, 7) + '-01';
}

export function list() {
  return getDb().prepare(
    `SELECT b.*, b.period_start AS start_month,
            (SELECT COUNT(*) FROM budget_lines WHERE budget_id = b.id AND amount <> 0) AS filled_cells
       FROM budgets b ORDER BY b.period_start DESC, b.name`
  ).all();
}

export function get(id: number) {
  const db = getDb();
  const b: any = db.prepare('SELECT * FROM budgets WHERE id = ?').get(id);
  if (!b) throw new Error('Budget not found');
  b.start_month = b.period_start;
  b.months = months(b.period_start);
  b.lines = db.prepare('SELECT account_id, period_date AS period, amount FROM budget_lines WHERE budget_id = ?').all(id);
  return b;
}

export function create(input: { name: string; start_month: string }): number {
  const name = (input.name ?? '').trim();
  if (!name) throw new Error('Give the budget a name');
  const start = firstOfMonth(input.start_month || '');
  assertValidDate(start, 'Start month');
  const end = months(start)[11];
  return Number(getDb().prepare('INSERT INTO budgets (name, period_start, period_end) VALUES (?, ?, ?)').run(name, start, end).lastInsertRowid);
}

export function rename(id: number, name: string) {
  if (!(name ?? '').trim()) throw new Error('Give the budget a name');
  getDb().prepare('UPDATE budgets SET name = ? WHERE id = ?').run(name.trim(), id);
  return get(id);
}

export function remove(id: number) {
  const db = getDb();
  db.transaction(() => {
    db.prepare('DELETE FROM budget_lines WHERE budget_id = ?').run(id);
    db.prepare('DELETE FROM budgets WHERE id = ?').run(id);
  });
  return { ok: true };
}

/** Replace all amounts for a budget. Lines with amount 0 are removed to stay tidy. */
export function setLines(budget_id: number, lines: Array<{ account_id: number; period: string; amount: number }>) {
  const db = getDb();
  const b = db.prepare('SELECT id FROM budgets WHERE id = ?').get(budget_id);
  if (!b) throw new Error('Budget not found');
  return db.transaction(() => {
    const ins = db.prepare(
      `INSERT INTO budget_lines (budget_id, account_id, period_date, amount) VALUES (?, ?, ?, ?)
       ON CONFLICT(budget_id, account_id, period_date) DO UPDATE SET amount = excluded.amount`
    );
    const del = db.prepare('DELETE FROM budget_lines WHERE budget_id = ? AND account_id = ? AND period_date = ?');
    for (const l of lines ?? []) {
      const period = firstOfMonth(l.period);
      const amount = Math.round(Number(l.amount) || 0);
      if (amount === 0) del.run(budget_id, l.account_id, period);
      else ins.run(budget_id, l.account_id, period, amount);
    }
    return { ok: true };
  });
}

/**
 * Budget vs actual for a month range. Actuals come from posted journals on
 * income/expense accounts (same sign as the P&L); budget is the sum of the
 * monthly targets within the range. Variance is actual − budget; whether that's
 * favourable depends on the account type (more income good, more expense bad).
 */
export function vsActual(params: { budget_id: number; from: string; to: string }) {
  const db = getDb();
  const b: any = db.prepare('SELECT * FROM budgets WHERE id = ?').get(params.budget_id);
  if (!b) throw new Error('Budget not found');
  assertValidDate(params.from, 'From date');
  assertValidDate(params.to, 'To date');

  // Actuals per P&L account over the range.
  const actuals = db.prepare(
    `SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
            COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
       JOIN accounts a ON a.id = jl.account_id
      WHERE a.type IN ('REVENUE','EXPENSE') AND j.date >= ? AND j.date <= ?
      GROUP BY a.id`
  ).all(params.from, params.to) as any[];

  // Budget per account over the range (periods within [from,to]).
  const budgets = db.prepare(
    `SELECT bl.account_id, COALESCE(SUM(bl.amount),0) AS amount
       FROM budget_lines bl
      WHERE bl.budget_id = ? AND bl.period_date >= ? AND bl.period_date <= ?
      GROUP BY bl.account_id`
  ).all(params.budget_id, firstOfMonth(params.from), firstOfMonth(params.to)) as any[];
  const budgetByAcct = new Map<number, number>(budgets.map((r) => [r.account_id, r.amount]));

  // Union of accounts that have either an actual or a budget.
  const meta = new Map<number, any>();
  for (const r of actuals) meta.set(r.account_id, r);
  for (const r of budgets) if (!meta.has(r.account_id)) {
    const a: any = db.prepare('SELECT id AS account_id, code, name, type, subtype FROM accounts WHERE id = ?').get(r.account_id);
    if (a) meta.set(r.account_id, { ...a, dr: 0, cr: 0 });
  }

  const rows = [...meta.values()].map((r) => {
    const actual = natural(r.type, r.dr, r.cr);
    const budget = budgetByAcct.get(r.account_id) ?? 0;
    const variance = actual - budget;
    const favourable = r.type === 'REVENUE' ? variance >= 0 : variance <= 0;
    return { account_id: r.account_id, code: r.code, name: r.name, type: r.type, subtype: r.subtype, actual, budget, variance, favourable };
  }).filter((r) => r.actual !== 0 || r.budget !== 0)
    .sort((a, b) => a.code.localeCompare(b.code));

  const income = rows.filter((r) => r.type === 'REVENUE');
  const expense = rows.filter((r) => r.type === 'EXPENSE');
  const sum = (arr: any[], k: string) => arr.reduce((s, r) => s + r[k], 0);
  const totals = {
    income: { actual: sum(income, 'actual'), budget: sum(income, 'budget') },
    expense: { actual: sum(expense, 'actual'), budget: sum(expense, 'budget') },
  };
  const net = {
    actual: totals.income.actual - totals.expense.actual,
    budget: totals.income.budget - totals.expense.budget,
  };
  return { budget: { id: b.id, name: b.name, start_month: b.period_start }, from: params.from, to: params.to, income, expense, totals, net };
}
