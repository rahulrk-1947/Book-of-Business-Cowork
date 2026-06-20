/**
 * Fixed assets & depreciation (spec §9).
 * Straight line: (cost − residual) / effective life per year, prorated monthly.
 * Diminishing value: book value × rate per year, prorated monthly.
 * A run posts Dr Depreciation Expense / Cr Accumulated Depreciation per asset.
 */
import { getDb } from '../db';
import { postJournal, audit, systemAccount, today } from '../engine';
import { roundCents } from '../money';

export function listTypes() {
  return getDb().prepare('SELECT * FROM asset_types ORDER BY name').all();
}

export function saveType(input: any, user_id = 1) {
  const db = getDb();
  const vals = [input.name, input.asset_account_id ?? null, input.accumulated_dep_account_id ?? null,
    input.expense_account_id ?? null, input.default_method ?? 'STRAIGHT_LINE', input.default_rate ?? null, input.default_effective_life ?? null];
  if (input.id) db.prepare('UPDATE asset_types SET name=?, asset_account_id=?, accumulated_dep_account_id=?, expense_account_id=?, default_method=?, default_rate=?, default_effective_life=? WHERE id=?').run(...vals, input.id);
  else input.id = Number(db.prepare('INSERT INTO asset_types (name, asset_account_id, accumulated_dep_account_id, expense_account_id, default_method, default_rate, default_effective_life) VALUES (?,?,?,?,?,?,?)').run(...vals).lastInsertRowid);
  audit('asset_type', input.id, 'SAVE', null, input, user_id);
  return input.id;
}

export function list() {
  return getDb().prepare(`SELECT f.*, t.name AS type_name FROM fixed_assets f LEFT JOIN asset_types t ON t.id=f.asset_type_id ORDER BY f.status, f.purchase_date DESC`).all();
}

export function get(id: number) {
  const db = getDb();
  const a = db.prepare('SELECT f.*, t.name AS type_name FROM fixed_assets f LEFT JOIN asset_types t ON t.id=f.asset_type_id WHERE f.id = ?').get(id);
  if (a) a.depreciation = db.prepare(`SELECT e.*, r.period_end FROM depreciation_entries e JOIN depreciation_runs r ON r.id=e.run_id WHERE e.asset_id = ? ORDER BY r.period_end`).all(id);
  return a;
}

export function save(input: any, user_id = 1) {
  const db = getDb();
  const vals = [input.name, input.asset_number ?? null, input.asset_type_id ?? null, input.purchase_date,
    input.purchase_price, input.serial_number ?? null, input.description ?? null,
    input.depreciation_method ?? 'STRAIGHT_LINE', input.rate ?? null, input.effective_life ?? null,
    input.depreciation_start_date ?? input.purchase_date, input.residual_value ?? 0];
  let id = input.id;
  if (id) {
    const existing = db.prepare('SELECT status FROM fixed_assets WHERE id = ?').get(id);
    if (existing?.status === 'DISPOSED') throw new Error('Disposed assets cannot be edited');
    db.prepare(`UPDATE fixed_assets SET name=?, asset_number=?, asset_type_id=?, purchase_date=?, purchase_price=?, serial_number=?, description=?, depreciation_method=?, rate=?, effective_life=?, depreciation_start_date=?, residual_value=? WHERE id=?`).run(...vals, id);
  } else {
    id = Number(db.prepare(`INSERT INTO fixed_assets (name, asset_number, asset_type_id, purchase_date, purchase_price, serial_number, description, depreciation_method, rate, effective_life, depreciation_start_date, residual_value, book_value, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?, ?, 'DRAFT')`).run(...vals, input.purchase_price).lastInsertRowid);
  }
  audit('fixed_asset', id, input.id ? 'UPDATE' : 'CREATE', null, input, user_id);
  return get(id);
}

export function register(id: number, user_id = 1) {
  const db = getDb();
  const a = get(id);
  if (!a) throw new Error('Asset not found');
  if (a.status !== 'DRAFT') throw new Error('Only draft assets can be registered');
  if (a.depreciation_method !== 'NONE' && !a.rate && !a.effective_life) {
    throw new Error('Set a depreciation rate or effective life before registering');
  }
  db.prepare("UPDATE fixed_assets SET status='REGISTERED', book_value=purchase_price WHERE id = ?").run(id);
  audit('fixed_asset', id, 'REGISTER', null, null, user_id);
  return get(id);
}

/** Monthly depreciation for one asset up to periodEnd, in cents. */
export function monthlyDepreciation(asset: any, monthsSinceLastRun: number): number {
  if (asset.depreciation_method === 'NONE' || asset.status !== 'REGISTERED') return 0;
  const cost = Math.min(asset.purchase_price, asset.cost_limit ?? asset.purchase_price);
  const depreciable = cost - (asset.residual_value ?? 0);
  let annual: number;
  if (asset.depreciation_method === 'DIMINISHING') {
    const rate = (asset.rate ?? (asset.effective_life ? 200 / asset.effective_life : 0)) / 100;
    annual = asset.book_value * rate;
  } else {
    const life = asset.effective_life ?? (asset.rate ? 100 / asset.rate : 0);
    annual = life > 0 ? depreciable / life : 0;
  }
  const amount = roundCents((annual / 12) * monthsSinceLastRun);
  // Never depreciate below residual value
  const floor = asset.residual_value ?? 0;
  return Math.max(0, Math.min(amount, asset.book_value - floor));
}

/** Run depreciation for all registered assets through periodEnd (YYYY-MM-DD, usually a month end). */
export function runDepreciation(periodEnd: string, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const last = db.prepare(`SELECT MAX(period_end) AS pe FROM depreciation_runs WHERE status='POSTED'`).get()?.pe;
    if (last && periodEnd <= last) throw new Error(`Depreciation already run through ${last}`);
    const runId = Number(db.prepare(`INSERT INTO depreciation_runs (period_end, status, created_at) VALUES (?, 'POSTED', datetime('now'))`).run(periodEnd).lastInsertRowid);
    const assets = db.prepare(`SELECT * FROM fixed_assets WHERE status='REGISTERED'`).all();
    const entries: any[] = [];
    for (const a of assets) {
      // Whole calendar months to depreciate this run. On an asset's first run
      // (or one whose start date is after the last run) count its start month
      // through periodEnd inclusive; thereafter count only the months AFTER the
      // last run's month. Previously this used the prior run's month-end as the
      // start with an inclusive month count, which double-counted the boundary
      // month — so monthly runs over-charged depreciation by ~50%.
      const startDate = a.depreciation_start_date ?? a.purchase_date;
      const months = (!last || startDate > last)
        ? monthIndex(periodEnd) - monthIndex(startDate) + 1
        : monthIndex(periodEnd) - monthIndex(last);
      if (months <= 0) continue;
      const amount = monthlyDepreciation(a, months);
      if (amount <= 0) continue;
      const type = db.prepare('SELECT * FROM asset_types WHERE id = ?').get(a.asset_type_id) ?? {};
      const expense = type.expense_account_id ?? systemAccount('DEPRECIATION');
      const accum = type.accumulated_dep_account_id ?? assetAccumFallback();
      const jid = postJournal({
        date: periodEnd,
        narration: `Depreciation — ${a.name} to ${periodEnd}`,
        source_type: 'DEPRN', source_id: a.id,
        lines: [
          { account_id: expense, debit: amount, description: a.name },
          { account_id: accum, credit: amount, description: a.name },
        ],
        user_id,
      });
      db.prepare('INSERT INTO depreciation_entries (run_id, asset_id, amount, journal_id) VALUES (?,?,?,?)').run(runId, a.id, amount, jid);
      db.prepare('UPDATE fixed_assets SET accumulated_depreciation = accumulated_depreciation + ?, book_value = book_value - ? WHERE id = ?').run(amount, amount, a.id);
      entries.push({ asset: a.name, amount });
    }
    audit('depreciation_run', runId, 'POSTED', null, { periodEnd, entries: entries.length }, user_id);
    return { runId, periodEnd, entries };
  });
}

function assetAccumFallback(): number {
  const a = getDb().prepare(`SELECT id FROM accounts WHERE name LIKE '%Accumulated Depreciation%' LIMIT 1`).get();
  if (!a) throw new Error('No accumulated depreciation account configured');
  return a.id;
}

/** Disposal: remove cost & accumulated depreciation, recognise gain/loss vs proceeds. */
export function dispose(id: number, input: { date: string; proceeds: number; proceeds_bank_account_id?: number }, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const a = get(id);
    if (!a || a.status !== 'REGISTERED') throw new Error('Only registered assets can be disposed');
    const type = db.prepare('SELECT * FROM asset_types WHERE id = ?').get(a.asset_type_id) ?? {};
    const assetAcct = type.asset_account_id ?? getDb().prepare(`SELECT id FROM accounts WHERE subtype='FIXED_ASSET' AND name NOT LIKE '%Accumulated%' LIMIT 1`).get()?.id;
    const accumAcct = type.accumulated_dep_account_id ?? assetAccumFallback();
    // Gains/losses on disposal belong in their own P&L account, NOT the
    // depreciation expense account (which previously buried gains as negative
    // depreciation and misstated depreciation expense for the period).
    const gainLossAcct = disposalGainLossAccount();
    const bank = input.proceeds_bank_account_id ?? getDb().prepare(`SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1`).get()?.id;

    // Depreciate up to the disposal date first, so the book value (and hence the
    // gain/loss) reflects the asset's value at the moment it leaves the books.
    const lastEntry = db.prepare(`SELECT MAX(r.period_end) AS pe FROM depreciation_entries e JOIN depreciation_runs r ON r.id=e.run_id WHERE e.asset_id=?`).get(id)?.pe as string | undefined;
    const startDate = a.depreciation_start_date ?? a.purchase_date;
    const catchUpMonths = (!lastEntry || startDate > lastEntry)
      ? monthIndex(input.date) - monthIndex(startDate) + 1
      : monthIndex(input.date) - monthIndex(lastEntry);
    const catchUp = catchUpMonths > 0 ? monthlyDepreciation(a, catchUpMonths) : 0;
    if (catchUp > 0) {
      const expense = type.expense_account_id ?? systemAccount('DEPRECIATION');
      postJournal({
        date: input.date,
        narration: `Depreciation to disposal — ${a.name}`,
        source_type: 'DEPRN', source_id: id,
        lines: [
          { account_id: expense, debit: catchUp, description: a.name },
          { account_id: accumAcct, credit: catchUp, description: a.name },
        ],
        user_id,
      });
      db.prepare('UPDATE fixed_assets SET accumulated_depreciation = accumulated_depreciation + ?, book_value = book_value - ? WHERE id = ?').run(catchUp, catchUp, id);
      a.accumulated_depreciation += catchUp;
      a.book_value -= catchUp;
    }

    const gain = input.proceeds - a.book_value; // + gain, − loss

    const lines: any[] = [
      { account_id: accumAcct, debit: a.accumulated_depreciation, description: `Dispose ${a.name}` },
      { account_id: assetAcct, credit: a.purchase_price, description: `Dispose ${a.name}` },
    ];
    if (input.proceeds > 0) lines.unshift({ account_id: bank, debit: input.proceeds, description: `Proceeds — ${a.name}` });
    if (gain > 0) lines.push({ account_id: gainLossAcct, credit: gain, description: 'Gain on disposal' });
    if (gain < 0) lines.push({ account_id: gainLossAcct, debit: -gain, description: 'Loss on disposal' });

    postJournal({ date: input.date, narration: `Disposal — ${a.name}`, source_type: 'DISPOSAL', source_id: id, lines, user_id });
    db.prepare("UPDATE fixed_assets SET status='DISPOSED', disposal_date=?, disposal_proceeds=?, book_value=0 WHERE id = ?").run(input.date, input.proceeds, id);
    audit('fixed_asset', id, 'DISPOSE', null, input, user_id);
    return get(id);
  });
}

/** Absolute month number (year*12 + month) for whole-calendar-month arithmetic. */
function monthIndex(d: string): number {
  const [y, m] = d.split('-').map(Number);
  return y * 12 + (m - 1);
}

/** The dedicated gains/losses-on-disposal account, with safe fallbacks. */
function disposalGainLossAccount(): number {
  const db = getDb();
  const a = db.prepare(`SELECT id FROM accounts WHERE system_account='DISPOSAL_GAINLOSS' LIMIT 1`).get();
  if (a) return a.id;
  const byName = db.prepare(`SELECT id FROM accounts WHERE name LIKE '%Disposal%' LIMIT 1`).get();
  return byName?.id ?? systemAccount('DEPRECIATION');
}

export function runs() {
  return getDb().prepare(`SELECT r.*, COUNT(e.id) AS entries, COALESCE(SUM(e.amount),0) AS total FROM depreciation_runs r LEFT JOIN depreciation_entries e ON e.run_id = r.id GROUP BY r.id ORDER BY r.period_end DESC`).all();
}
