/** Settings: organisation, tax rates, currencies & rates, users, sequences, locks, audit log. */
import { getDb, integrityCheck, databaseInfo } from '../db';
import { assertUniqueName } from './uniqueness';
import * as session from '../session';
import { audit, PostingError, assertValidDate } from '../engine';

// ── Organisation ───────────────────────────────────────────────────────────

export function getOrganisation() {
  return getDb().prepare('SELECT * FROM organisations WHERE id = 1').get();
}

export function updateOrganisation(fields: Record<string, any>, userId = 1) {
  const db = getDb();
  const allowed = [
    'legal_name', 'trading_name', 'registration_number', 'tax_number', 'base_currency',
    'financial_year_end_month', 'financial_year_end_day', 'tax_basis', 'timezone', 'logo_path',
    'logo_data', 'address_line1', 'address_line2', 'address_city', 'address_region',
    'address_postcode', 'address_country', 'contact_email', 'contact_phone', 'website', 'invoice_footer',
  ];
  const before = getOrganisation();
  const sets: string[] = [];
  const args: any[] = [];
  for (const k of allowed) {
    if (k in fields) {
      sets.push(`${k} = ?`);
      args.push(fields[k]);
    }
  }
  if (!sets.length) return before;
  // Changing base currency after posting would corrupt history.
  if ('base_currency' in fields && fields.base_currency !== before.base_currency) {
    const posted = db.prepare(`SELECT COUNT(*) AS n FROM journals WHERE status = 'POSTED'`).get();
    if (posted.n > 0) throw new PostingError('Base currency cannot change once journals exist');
  }
  db.prepare(`UPDATE organisations SET ${sets.join(', ')} WHERE id = 1`).run(...args);
  audit('organisation', 1, 'UPDATED', before, fields, userId);
  return getOrganisation();
}

export function setLockDate(lock_date: string | null, adviser_lock_date: string | null, userId = 1) {
  const db = getDb();
  if (lock_date) assertValidDate(lock_date, 'Lock date');
  if (adviser_lock_date) assertValidDate(adviser_lock_date, 'Adviser lock date');
  const before = getOrganisation();
  db.prepare('UPDATE organisations SET lock_date = ?, adviser_lock_date = ? WHERE id = 1').run(lock_date, adviser_lock_date);
  audit('organisation', 1, 'LOCK_DATE', { lock_date: before.lock_date }, { lock_date, adviser_lock_date }, userId);
  return getOrganisation();
}

// ── Tax rates ──────────────────────────────────────────────────────────────

export function listTaxRates(includeArchived = false) {
  const db = getDb();
  const rates = db
    .prepare(`SELECT * FROM tax_rates ${includeArchived ? '' : "WHERE status = 'ACTIVE'"} ORDER BY name`)
    .all();
  const comps = db.prepare('SELECT * FROM tax_components WHERE tax_rate_id = ?');
  for (const r of rates) r.components = comps.all(r.id);
  return rates;
}

export function saveTaxRate(
  input: { id?: number; name: string; tax_type: string; can_apply_to_sales?: boolean; can_apply_to_purchases?: boolean; components: { name: string; percent: number; is_compound?: boolean }[] },
  userId = 1
) {
  const db = getDb();
  if (!input.components?.length) throw new PostingError('A tax rate needs at least one component');
  if (!input.name?.trim()) throw new PostingError('Tax rate name is required');
  return db.transaction(() => {
    // Unique among active rates (the one being edited is excluded; archived
    // historical versions don't count).
    assertUniqueName({ table: 'tax_rates', column: 'name', value: input.name, excludeId: input.id, statuses: ['ACTIVE'], label: 'A tax rate named' });
    // display rate: simple sum + compound applied on top
    let simple = 0;
    let rate = 0;
    for (const c of input.components) if (!c.is_compound) simple += c.percent;
    rate = simple;
    for (const c of input.components) if (c.is_compound) rate += ((100 + simple) * c.percent) / 100;

    let id = input.id ?? 0;
    if (id) {
      // editing a used rate: archive old, create new (rates on posted lines must not mutate)
      const used = db.prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE tax_rate_id = ?').get(id);
      if (used.n > 0) {
        db.prepare("UPDATE tax_rates SET status = 'ARCHIVED' WHERE id = ?").run(id);
        id = 0;
      } else {
        db.prepare('UPDATE tax_rates SET name = ?, tax_type = ?, display_rate = ?, can_apply_to_sales = ?, can_apply_to_purchases = ? WHERE id = ?')
          .run(input.name, input.tax_type, rate, input.can_apply_to_sales === false ? 0 : 1, input.can_apply_to_purchases === false ? 0 : 1, id);
        db.prepare('DELETE FROM tax_components WHERE tax_rate_id = ?').run(id);
      }
    }
    if (!id) {
      id = Number(
        db.prepare('INSERT INTO tax_rates (name, tax_type, display_rate, can_apply_to_sales, can_apply_to_purchases) VALUES (?, ?, ?, ?, ?)')
          .run(input.name, input.tax_type, rate, input.can_apply_to_sales === false ? 0 : 1, input.can_apply_to_purchases === false ? 0 : 1).lastInsertRowid
      );
    }
    const ins = db.prepare('INSERT INTO tax_components (tax_rate_id, name, percent, is_compound) VALUES (?, ?, ?, ?)');
    for (const c of input.components) ins.run(id, c.name, c.percent, c.is_compound ? 1 : 0);
    audit('tax_rate', id, input.id ? 'UPDATED' : 'CREATED', null, input, userId);
    return id;
  });
}

export function archiveTaxRate(id: number, userId = 1) {
  getDb().prepare("UPDATE tax_rates SET status = 'ARCHIVED' WHERE id = ?").run(id);
  audit('tax_rate', id, 'ARCHIVED', null, null, userId);
}

// ── Currencies & exchange rates ────────────────────────────────────────────

export function listCurrencies() {
  const db = getDb();
  const cur = db.prepare("SELECT * FROM currencies ORDER BY code").all();
  const latest = db.prepare('SELECT rate, date FROM exchange_rates WHERE currency_code = ? ORDER BY date DESC LIMIT 1');
  for (const c of cur) {
    const r = latest.get(c.code);
    c.latest_rate = r?.rate ?? null;
    c.latest_rate_date = r?.date ?? null;
  }
  return cur;
}

export function addCurrency(code: string, name: string, userId = 1) {
  getDb().prepare("INSERT OR REPLACE INTO currencies (code, name, status) VALUES (?, ?, 'ACTIVE')").run(code.toUpperCase(), name);
  audit('currency', 0, 'CREATED', null, { code, name }, userId);
}

export function setExchangeRate(currency_code: string, date: string, rate: number, userId = 1) {
  if (rate <= 0) throw new PostingError('Rate must be positive');
  getDb()
    .prepare('INSERT INTO exchange_rates (date, currency_code, rate) VALUES (?, ?, ?) ON CONFLICT(date, currency_code) DO UPDATE SET rate = excluded.rate')
    .run(date, currency_code.toUpperCase(), rate);
  audit('exchange_rate', 0, 'SET', null, { currency_code, date, rate }, userId);
}

export function listExchangeRates(currency_code: string) {
  return getDb().prepare('SELECT * FROM exchange_rates WHERE currency_code = ? ORDER BY date DESC LIMIT 100').all(currency_code.toUpperCase());
}

/** Rate effective on a date: latest rate ≤ date, else 1. */
export function rateOn(currency_code: string, date: string): number {
  const db = getDb();
  const base = db.prepare('SELECT base_currency FROM organisations WHERE id = 1').get()?.base_currency;
  if (currency_code === base) return 1;
  const r = db.prepare('SELECT rate FROM exchange_rates WHERE currency_code = ? AND date <= ? ORDER BY date DESC LIMIT 1').get(currency_code, date);
  return r?.rate ?? 1;
}

// ── Users & roles ──────────────────────────────────────────────────────────

export function listUsers() {
  const db = getDb();
  const users = db.prepare('SELECT id, name, email, status, last_login, created_at FROM users ORDER BY id').all();
  const roles = db.prepare(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`
  );
  for (const u of users) u.roles = roles.all(u.id).map((r: any) => r.name);
  return users;
}

export function listRoles() {
  const db = getDb();
  const roles = db.prepare('SELECT * FROM roles ORDER BY id').all();
  const perms = db.prepare(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = ?`
  );
  for (const r of roles) r.permissions = perms.all(r.id).map((p: any) => p.code);
  return roles;
}

export function saveUser(input: { id?: number; name: string; email: string; role_ids?: number[]; status?: string }, userId = 1) {
  const db = getDb();
  return db.transaction(() => {
    let id = input.id ?? 0;
    if (id) {
      db.prepare('UPDATE users SET name = ?, email = ?, status = ? WHERE id = ?').run(input.name, input.email, input.status ?? 'ACTIVE', id);
    } else {
      id = Number(
        db.prepare("INSERT INTO users (name, email, password_hash, status) VALUES (?, ?, '', 'INVITED')").run(input.name, input.email).lastInsertRowid
      );
    }
    if (input.role_ids) {
      db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
      const ins = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
      for (const r of input.role_ids) ins.run(id, r);
    }
    audit('user', id, input.id ? 'UPDATED' : 'CREATED', null, { name: input.name, email: input.email }, userId);
    return id;
  });
}

// ── Number sequences ───────────────────────────────────────────────────────

export function listSequences() {
  return getDb().prepare('SELECT * FROM number_sequences ORDER BY document_type').all();
}

export function saveSequence(input: { document_type: string; prefix: string; next_number: number; padding: number }, userId = 1) {
  getDb()
    .prepare(
      `INSERT INTO number_sequences (document_type, prefix, next_number, padding) VALUES (?, ?, ?, ?)
       ON CONFLICT(document_type) DO UPDATE SET prefix = excluded.prefix, next_number = excluded.next_number, padding = excluded.padding`
    )
    .run(input.document_type, input.prefix, input.next_number, input.padding);
  audit('number_sequence', 0, 'UPDATED', null, input, userId);
}

// ── Tracking categories ────────────────────────────────────────────────────

export function listTracking() {
  const db = getDb();
  const cats = db.prepare("SELECT * FROM tracking_categories WHERE status = 'ACTIVE'").all();
  const opts = db.prepare("SELECT * FROM tracking_options WHERE category_id = ? AND status = 'ACTIVE'");
  for (const c of cats) c.options = opts.all(c.id);
  return cats;
}

export function saveTrackingCategory(input: { id?: number; name: string; options: { id?: number; name: string }[] }, userId = 1) {
  const db = getDb();
  if (!input.name?.trim()) throw new Error('Tracking category name is required');
  return db.transaction(() => {
    let id = input.id ?? 0;
    assertUniqueName({ table: 'tracking_categories', column: 'name', value: input.name, excludeId: id || undefined, statuses: ['ACTIVE'], label: 'A tracking category named' });
    if (id) db.prepare('UPDATE tracking_categories SET name = ? WHERE id = ?').run(input.name, id);
    else id = Number(db.prepare('INSERT INTO tracking_categories (name) VALUES (?)').run(input.name).lastInsertRowid);
    // Options must be unique within this category, and not collide with each other in the same save.
    const seen = new Set<string>();
    for (const o of input.options ?? []) {
      const norm = (o.name ?? '').trim().toLowerCase();
      if (!norm) throw new Error('Tracking option names cannot be blank');
      if (seen.has(norm)) throw new Error(`You've listed the tracking option "${o.name.trim()}" twice — each option must be unique.`);
      seen.add(norm);
      assertUniqueName({ table: 'tracking_options', column: 'name', value: o.name, excludeId: o.id, scope: { category_id: id }, statuses: ['ACTIVE'], label: 'A tracking option named' });
      if (o.id) db.prepare('UPDATE tracking_options SET name = ? WHERE id = ?').run(o.name, o.id);
      else db.prepare('INSERT INTO tracking_options (category_id, name) VALUES (?, ?)').run(id, o.name);
    }
    audit('tracking_category', id, 'SAVED', null, input, userId);
    return id;
  });
}

// ── Audit log ──────────────────────────────────────────────────────────────

export function auditLog(params: { entity_type?: string; limit?: number; offset?: number } = {}) {
  const db = getDb();
  const cond = params.entity_type ? 'WHERE a.entity_type = ?' : '';
  const args: any[] = params.entity_type ? [params.entity_type] : [];
  args.push(params.limit ?? 100, params.offset ?? 0);
  return db
    .prepare(
      `SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
       ${cond} ORDER BY a.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args);
}

// ── Integrity / diagnostics ────────────────────────────────────────────────

export function checkIntegrity() {
  try {
    integrityCheck(getDb());
    return { ok: true, message: 'All posted journals balance; ledger is consistent.' };
  } catch (e: any) {
    return { ok: false, message: e.message };
  }
}

// ── Branding themes ────────────────────────────────────────────────────────

export function listBrandingThemes() {
  return getDb().prepare('SELECT * FROM branding_themes ORDER BY id').all();
}

export function archiveTrackingCategory(id: number, userId = 1) {
  getDb().prepare("UPDATE tracking_categories SET status = 'ARCHIVED' WHERE id = ?").run(id);
  audit('tracking_category', id, 'ARCHIVED', null, null, userId);
}

export function archiveTrackingOption(id: number, userId = 1) {
  getDb().prepare("UPDATE tracking_options SET status = 'ARCHIVED' WHERE id = ?").run(id);
  audit('tracking_option', id, 'ARCHIVED', null, null, userId);
}


// ── Active user (session) ───────────────────────────────────────────────────

function withRolesAndPerms(u: any) {
  if (!u) return u;
  const db = getDb();
  u.roles = db.prepare(
    `SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?`
  ).all(u.id).map((r: any) => r.name);
  u.permissions = [...session.currentPermissions()];
  const total = db.prepare('SELECT COUNT(*) AS n FROM permissions').get().n as number;
  u.is_admin = u.permissions.length >= total;
  return u;
}

export function setActiveUser(id: number) {
  const u = getDb().prepare("SELECT id, name, email, status FROM users WHERE id = ?").get(id);
  if (!u) throw new Error('User not found');
  if (u.status === 'DISABLED') throw new Error(`${u.name} is disabled — re-enable them in Settings → Users first`);
  session.setCurrentUser(id);
  getDb().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(id);
  return withRolesAndPerms(u);
}

export function getActiveUser() {
  const u = getDb().prepare('SELECT id, name, email, status FROM users WHERE id = ?').get(session.currentUser());
  return withRolesAndPerms(u);
}

/** Version / data-format details for the UI's "About" / upgrade display. */
export function about() {
  return databaseInfo();
}
