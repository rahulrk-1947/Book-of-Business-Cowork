/**
 * Managed projects (jobs): track time and costs against a project, see its
 * profitability, and bill unbilled time/costs to the customer ("on-billing").
 *
 * The projects/* tables already existed in the schema but were unused — this
 * service lights them up. Time is valued via its task's hourly rate; project
 * costs carry an optional markup. On-billing creates a DRAFT sales invoice for
 * the project's customer (one line per task + one per billable cost), tags the
 * invoice lines with the project, and marks those items invoiced so they can't
 * be billed twice.
 */
import { getDb } from '../db';
import { today } from '../engine';
import { saveDraft } from './invoices';

const round = (n: number) => Math.round(n);

function incomeAccountId(db: any): number {
  const byCode = db.prepare("SELECT id FROM accounts WHERE code = '200'").get() as any;
  if (byCode) return byCode.id;
  const rev = db.prepare("SELECT id FROM accounts WHERE type = 'REVENUE' ORDER BY code LIMIT 1").get() as any;
  if (!rev) throw new Error('No revenue account is set up to invoice against.');
  return rev.id;
}

function timeValue(e: { minutes?: number; task_rate?: number | null }): number {
  if (!e.task_rate || !e.minutes) return 0;
  return round((e.minutes / 60) * e.task_rate);
}

// ── Projects ────────────────────────────────────────────────────────────────
export function listProjects(status?: string) {
  const db = getDb();
  const filtered = status && status !== 'ALL';
  const projects = db.prepare(
    `SELECT p.*, c.name AS contact_name
       FROM projects p LEFT JOIN contacts c ON c.id = p.contact_id
       ${filtered ? 'WHERE p.status = ?' : ''}
      ORDER BY p.created_at DESC`,
  ).all(...(filtered ? [status] : [])) as any[];
  for (const p of projects) {
    p.logged_minutes = Number((db.prepare('SELECT COALESCE(SUM(minutes),0) AS m FROM project_time WHERE project_id = ?').get(p.id) as any).m);
    p.billed_total = billedTotal(db, p.id);
    p.unbilled_total = unbilledTotal(db, p.id);
  }
  return projects;
}

export function getProject(id: number) {
  const db = getDb();
  const project = db.prepare('SELECT p.*, c.name AS contact_name FROM projects p LEFT JOIN contacts c ON c.id = p.contact_id WHERE p.id = ?').get(id) as any;
  if (!project) throw new Error('Project not found');
  const tasks = db.prepare('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY id').all(id) as any[];
  const time = listTime(id);
  const costs = db.prepare('SELECT * FROM project_expenses WHERE project_id = ? ORDER BY date DESC, id DESC').all(id) as any[];
  return { project, tasks, time, costs, summary: summarise(db, project, time, costs) };
}

function summarise(db: any, project: any, time: any[], costs: any[]) {
  const logged_minutes = time.reduce((s, e) => s + (e.minutes || 0), 0);
  const unbilled_time_value = time.filter((e) => e.billable && !e.invoiced && e.task_id).reduce((s, e) => s + timeValue(e), 0);
  const time_invoiced_value = time.filter((e) => e.invoiced).reduce((s, e) => s + timeValue(e), 0);
  const cost_total = costs.reduce((s, c) => s + (c.cost_amount || 0), 0);
  const cost_unbilled = costs.filter((c) => c.billable && !c.invoiced).reduce((s, c) => s + (c.charge_amount || 0), 0);
  const billed_total = billedTotal(db, project.id);
  return {
    logged_minutes,
    unbilled_time_value,
    time_invoiced_value,
    cost_total,
    cost_unbilled,
    unbilled_total: unbilled_time_value + cost_unbilled,
    billed_total,
    estimate: project.estimate_amount ?? null,
    net: billed_total - cost_total,
  };
}

function billedTotal(db: any, id: number): number {
  return Number((db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN i.type = 'ACCRECCREDIT' THEN -l.line_amount ELSE l.line_amount END), 0) AS net
       FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.project_id = ? AND i.type IN ('ACCREC', 'ACCRECCREDIT') AND i.status IN ('AUTHORISED','PAID')`,
  ).get(id) as any).net);
}

function unbilledTotal(db: any, id: number): number {
  const time = db.prepare(
    'SELECT pt.minutes, t.rate AS task_rate FROM project_time pt LEFT JOIN project_tasks t ON t.id = pt.task_id WHERE pt.project_id = ? AND pt.billable = 1 AND pt.invoiced = 0 AND pt.task_id IS NOT NULL',
  ).all(id) as any[];
  const tv = time.reduce((s, e) => s + timeValue(e), 0);
  const cv = Number((db.prepare('SELECT COALESCE(SUM(charge_amount),0) AS c FROM project_expenses WHERE project_id = ? AND billable = 1 AND invoiced = 0').get(id) as any).c);
  return tv + cv;
}

export function createProject(input: any) {
  const db = getDb();
  if (!input.name?.trim()) throw new Error('Give the project a name.');
  const id = Number(db.prepare(
    'INSERT INTO projects (contact_id, name, code, status, estimate_amount, deadline) VALUES (?,?,?,?,?,?)',
  ).run(input.contact_id ?? null, input.name.trim(), input.code ?? null, input.status ?? 'IN_PROGRESS', input.estimate_amount ?? null, input.deadline ?? null).lastInsertRowid);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(id);
}

export function updateProject(input: any) {
  const db = getDb();
  if (!input.id) throw new Error('Missing project id');
  if (!input.name?.trim()) throw new Error('Give the project a name.');
  db.prepare('UPDATE projects SET contact_id=?, name=?, code=?, status=?, estimate_amount=?, deadline=? WHERE id=?')
    .run(input.contact_id ?? null, input.name.trim(), input.code ?? null, input.status ?? 'IN_PROGRESS', input.estimate_amount ?? null, input.deadline ?? null, input.id);
  return db.prepare('SELECT * FROM projects WHERE id = ?').get(input.id);
}

export function setProjectStatus(id: number, status: string) {
  getDb().prepare('UPDATE projects SET status = ? WHERE id = ?').run(status, id);
}

export function deleteProject(id: number) {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM invoice_lines WHERE project_id = ? LIMIT 1').get(id)) {
    throw new Error('This project has invoiced items and can’t be deleted — mark it completed instead.');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM project_time WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM project_expenses WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM project_tasks WHERE project_id = ?').run(id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  });
}

// ── Tasks (carry the hourly rate used to value & bill time) ──────────────────
export function listTasks(project_id: number) {
  return getDb().prepare('SELECT * FROM project_tasks WHERE project_id = ? ORDER BY id').all(project_id);
}

export function saveTask(input: any) {
  const db = getDb();
  if (!input.name?.trim()) throw new Error('Give the task a name.');
  const rate = input.rate == null || input.rate === '' ? null : Math.max(0, Math.round(Number(input.rate)));
  if (input.id) {
    db.prepare('UPDATE project_tasks SET name=?, rate=?, charge_type=?, estimated_minutes=?, status=? WHERE id=?')
      .run(input.name.trim(), rate, input.charge_type ?? 'TIME', input.estimated_minutes ?? null, input.status ?? 'ACTIVE', input.id);
    return db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(input.id);
  }
  const id = Number(db.prepare('INSERT INTO project_tasks (project_id, name, rate, charge_type, estimated_minutes, status) VALUES (?,?,?,?,?,?)')
    .run(input.project_id, input.name.trim(), rate, input.charge_type ?? 'TIME', input.estimated_minutes ?? null, 'ACTIVE').lastInsertRowid);
  return db.prepare('SELECT * FROM project_tasks WHERE id = ?').get(id);
}

export function removeTask(id: number) {
  const db = getDb();
  if (db.prepare('SELECT 1 FROM project_time WHERE task_id = ? LIMIT 1').get(id)) {
    throw new Error('This task has time logged against it.');
  }
  db.prepare('DELETE FROM project_tasks WHERE id = ?').run(id);
}

// ── Time entries ─────────────────────────────────────────────────────────────
export function listTime(project_id: number) {
  const rows = getDb().prepare(
    `SELECT pt.*, t.name AS task_name, t.rate AS task_rate
       FROM project_time pt LEFT JOIN project_tasks t ON t.id = pt.task_id
      WHERE pt.project_id = ? ORDER BY pt.date DESC, pt.id DESC`,
  ).all(project_id) as any[];
  for (const e of rows) e.value = timeValue(e);
  return rows;
}

export function logTime(input: any) {
  const db = getDb();
  const minutes = Math.round(Number(input.minutes));
  if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Enter the time in minutes (greater than zero).');
  if (!input.date) throw new Error('Pick a date for the time entry.');
  if (input.id) {
    db.prepare('UPDATE project_time SET task_id=?, date=?, minutes=?, description=?, billable=? WHERE id=? AND invoiced=0')
      .run(input.task_id ?? null, input.date, minutes, input.description ?? null, input.billable === false ? 0 : 1, input.id);
    return db.prepare('SELECT * FROM project_time WHERE id = ?').get(input.id);
  }
  const id = Number(db.prepare('INSERT INTO project_time (project_id, task_id, user_id, date, minutes, description, billable, invoiced) VALUES (?,?,?,?,?,?,?,0)')
    .run(input.project_id, input.task_id ?? null, input.user_id ?? null, input.date, minutes, input.description ?? null, input.billable === false ? 0 : 1).lastInsertRowid);
  return db.prepare('SELECT * FROM project_time WHERE id = ?').get(id);
}

export function removeTime(id: number) {
  const db = getDb();
  if ((db.prepare('SELECT invoiced FROM project_time WHERE id = ?').get(id) as any)?.invoiced) {
    throw new Error('This time entry has already been invoiced.');
  }
  db.prepare('DELETE FROM project_time WHERE id = ?').run(id);
}

// ── Project costs (with optional markup) ─────────────────────────────────────
export function listCosts(project_id: number) {
  return getDb().prepare('SELECT * FROM project_expenses WHERE project_id = ? ORDER BY date DESC, id DESC').all(project_id);
}

export function addCost(input: any) {
  const db = getDb();
  const cost = Math.round(Number(input.cost_amount));
  if (!Number.isFinite(cost) || cost < 0) throw new Error('Enter the cost amount.');
  const markup = input.markup_percent == null || input.markup_percent === '' ? 0 : Number(input.markup_percent);
  const charge = Math.round(cost * (1 + markup / 100));
  if (input.id) {
    db.prepare('UPDATE project_expenses SET date=?, description=?, cost_amount=?, markup_percent=?, charge_amount=?, billable=? WHERE id=? AND invoiced=0')
      .run(input.date ?? today(), input.description ?? null, cost, markup, charge, input.billable === false ? 0 : 1, input.id);
    return db.prepare('SELECT * FROM project_expenses WHERE id = ?').get(input.id);
  }
  const id = Number(db.prepare('INSERT INTO project_expenses (project_id, source_type, date, description, cost_amount, markup_percent, charge_amount, billable, invoiced) VALUES (?,?,?,?,?,?,?,?,0)')
    .run(input.project_id, 'MANUAL', input.date ?? today(), input.description ?? null, cost, markup, charge, input.billable === false ? 0 : 1).lastInsertRowid);
  return db.prepare('SELECT * FROM project_expenses WHERE id = ?').get(id);
}

export function removeCost(id: number) {
  const db = getDb();
  if ((db.prepare('SELECT invoiced FROM project_expenses WHERE id = ?').get(id) as any)?.invoiced) {
    throw new Error('This cost has already been invoiced.');
  }
  db.prepare('DELETE FROM project_expenses WHERE id = ?').run(id);
}

/**
 * Adjust only the markup and billable flag of a cost, leaving its amount and
 * date alone. Used for costs imported from a bill, supplier credit or expense
 * claim — their amount follows the source document, and the amount can be
 * negative (a credit), which the plain cost editor disallows.
 */
export function updateCostBilling(input: { id: number; markup_percent?: number; billable?: boolean }) {
  const db = getDb();
  const row = db.prepare('SELECT cost_amount, markup_percent, billable, invoiced FROM project_expenses WHERE id = ?').get(input.id) as any;
  if (!row) throw new Error('Cost not found.');
  if (row.invoiced) throw new Error('This cost has already been invoiced.');
  const markup = input.markup_percent == null || (input.markup_percent as any) === '' ? (row.markup_percent ?? 0) : Number(input.markup_percent);
  const billable = input.billable == null ? row.billable : (input.billable ? 1 : 0);
  const charge = Math.round((row.cost_amount || 0) * (1 + markup / 100));
  db.prepare('UPDATE project_expenses SET markup_percent = ?, charge_amount = ?, billable = ? WHERE id = ? AND invoiced = 0')
    .run(markup, charge, billable, input.id);
  return db.prepare('SELECT * FROM project_expenses WHERE id = ?').get(input.id);
}

// ── On-billing ───────────────────────────────────────────────────────────────
/** Billable, not-yet-invoiced time (with a task rate) and costs for a project. */
export function unbilled(project_id: number) {
  const db = getDb();
  const time = db.prepare(
    `SELECT pt.*, t.name AS task_name, t.rate AS task_rate
       FROM project_time pt LEFT JOIN project_tasks t ON t.id = pt.task_id
      WHERE pt.project_id = ? AND pt.billable = 1 AND pt.invoiced = 0 AND pt.task_id IS NOT NULL`,
  ).all(project_id) as any[];
  for (const e of time) e.value = timeValue(e);
  const costs = db.prepare('SELECT * FROM project_expenses WHERE project_id = ? AND billable = 1 AND invoiced = 0').all(project_id) as any[];
  const total = time.reduce((s, e) => s + e.value, 0) + costs.reduce((s, c) => s + (c.charge_amount || 0), 0);
  return { time, costs, total };
}

/** Create a draft sales invoice from a project's unbilled time and costs. */
export function invoiceUnbilled(project_id: number, opts: { date?: string; due_date?: string } = {}, user_id = 1) {
  const db = getDb();
  const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(project_id) as any;
  if (!project) throw new Error('Project not found');
  if (!project.contact_id) throw new Error('Add a customer to this project before invoicing.');
  const incomeAcc = incomeAccountId(db);
  const { time, costs } = unbilled(project_id);

  // One line per task (sum its hours), then one line per billable cost.
  const byTask = new Map<number, { name: string; minutes: number; rate: number }>();
  for (const e of time) {
    const g = byTask.get(e.task_id) ?? { name: e.task_name, minutes: 0, rate: e.task_rate };
    g.minutes += e.minutes;
    byTask.set(e.task_id, g);
  }
  const lines: any[] = [];
  for (const g of byTask.values()) {
    const hours = Math.round((g.minutes / 60) * 100) / 100;
    lines.push({ description: `${g.name} — ${hours} hrs`, quantity: hours, unit_amount: g.rate, account_id: incomeAcc });
  }
  for (const c of costs) {
    lines.push({ description: c.description ?? 'Project expense', quantity: 1, unit_amount: c.charge_amount ?? 0, account_id: incomeAcc });
  }
  if (lines.length === 0) throw new Error('There’s nothing unbilled to invoice on this project.');

  const inv: any = saveDraft({ type: 'ACCREC', contact_id: project.contact_id, date: opts.date ?? today(), due_date: opts.due_date, lines }, user_id);
  db.transaction(() => {
    db.prepare('UPDATE invoice_lines SET project_id = ? WHERE invoice_id = ?').run(project_id, inv.id);
    db.prepare('UPDATE project_time SET invoiced = 1, invoice_id = ? WHERE project_id = ? AND billable = 1 AND invoiced = 0 AND task_id IS NOT NULL').run(inv.id, project_id);
    db.prepare('UPDATE project_expenses SET invoiced = 1, invoice_id = ? WHERE project_id = ? AND billable = 1 AND invoiced = 0').run(inv.id, project_id);
  });
  inv.project_id = project_id;
  return inv;
}
