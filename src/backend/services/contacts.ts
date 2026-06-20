import { getDb } from '../db';
import { audit } from '../engine';
import { assertUniqueName } from './uniqueness';

const FIELDS = [
  'name', 'account_number', 'is_customer', 'is_supplier', 'email', 'phone', 'website', 'tax_number',
  'currency_code_default', 'payment_terms_sales', 'payment_terms_bills', 'sales_account_default',
  'purchases_account_default', 'tax_rate_default', 'discount_percent_default', 'credit_limit', 'credit_limit_block',
] as const;

export function list(opts: { search?: string; filter?: 'ALL' | 'CUSTOMERS' | 'SUPPLIERS' | 'ARCHIVED' } = {}) {
  const db = getDb();
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.filter === 'ARCHIVED') where.push("c.status = 'ARCHIVED'");
  else {
    where.push("c.status = 'ACTIVE'");
    if (opts.filter === 'CUSTOMERS') where.push('c.is_customer = 1');
    if (opts.filter === 'SUPPLIERS') where.push('c.is_supplier = 1');
  }
  if (opts.search) {
    where.push('(c.name LIKE ? OR c.email LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`);
  }
  return db
    .prepare(
      `SELECT c.*,
        COALESCE((SELECT SUM(amount_due) FROM invoices i WHERE i.contact_id = c.id AND i.type = 'ACCREC' AND i.status IN ('AUTHORISED')), 0) AS owes_you,
        COALESCE((SELECT SUM(amount_due) FROM invoices i WHERE i.contact_id = c.id AND i.type = 'ACCPAY' AND i.status IN ('AUTHORISED')), 0) AS you_owe
       FROM contacts c WHERE ${where.join(' AND ')} ORDER BY c.name`
    )
    .all(...params);
}

export function get(id: number) {
  const db = getDb();
  const c = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id);
  if (!c) return null;
  c.addresses = db.prepare('SELECT * FROM contact_addresses WHERE contact_id = ?').all(id);
  c.persons = db.prepare('SELECT * FROM contact_persons WHERE contact_id = ?').all(id);
  return c;
}

/**
 * Everything that ever happened with one contact, regardless of kind:
 * invoices, bills, credit notes, quotes, purchase orders, payments, and
 * spend/receive money — one stream, newest first. Each row carries the
 * source_type/source_id pair the UI uses to open the underlying record.
 */
export function activity(id: number, opts: { from?: string; to?: string } = {}) {
  const db = getDb();
  for (const k of ['from', 'to'] as const) {
    if (opts[k] && !/^\d{4}-\d{2}-\d{2}$/.test(opts[k]!)) throw new Error('Invalid date filter');
  }
  const cond = (col: string) => {
    const parts = [`${col} = ?`];
    if (opts.from) parts.push(`date >= '${opts.from}'`);
    if (opts.to) parts.push(`date <= '${opts.to}'`);
    return parts.join(' AND ');
  };
  const rows: any[] = [];
  for (const i of db
    .prepare(`SELECT id, type, invoice_number, reference, date, due_date, status, total, amount_due, currency_code FROM invoices
              WHERE ${cond('contact_id')} AND status != 'DELETED' ORDER BY date DESC LIMIT 500`)
    .all(id)) {
    rows.push({
      kind: i.type, // ACCREC | ACCPAY | ACCRECCREDIT | ACCPAYCREDIT | QUOTE | PURCHASEORDER
      date: i.date,
      due_date: i.due_date,
      number: i.invoice_number,
      reference: i.reference,
      status: i.status,
      total: i.total,
      amount_due: i.amount_due,
      currency_code: i.currency_code,
      source_type: 'INVOICE',
      source_id: i.id,
    });
  }
  for (const p of db
    .prepare(`SELECT p.id, p.type, p.date, p.amount, p.reference, a.name AS bank_name FROM payments p
              JOIN accounts a ON a.id = p.bank_account_id WHERE ${cond('p.contact_id')} ORDER BY p.date DESC LIMIT 500`)
    .all(id)) {
    rows.push({
      kind: p.type === 'RECEIVE' ? 'PAYMENT_IN' : 'PAYMENT_OUT',
      date: p.date,
      number: null,
      reference: p.reference ?? p.bank_name,
      status: 'POSTED',
      total: p.amount,
      amount_due: null,
      source_type: 'PAYMENT',
      source_id: p.id,
    });
  }
  for (const t of db
    .prepare(`SELECT b.id, b.type, b.date, b.reference, b.total, b.status, a.name AS bank_name FROM bank_transactions b
              JOIN accounts a ON a.id = b.bank_account_id WHERE ${cond('b.contact_id')} AND b.status != 'DELETED' ORDER BY b.date DESC LIMIT 500`)
    .all(id)) {
    rows.push({
      kind: t.type === 'RECEIVE' ? 'RECEIVE_MONEY' : 'SPEND_MONEY',
      date: t.date,
      number: null,
      reference: t.reference ?? t.bank_name,
      status: t.status,
      total: t.total,
      amount_due: null,
      source_type: 'BANKTXN',
      source_id: t.id,
    });
  }
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.source_id - a.source_id));
  const sum = (pred: (r: any) => boolean) => rows.filter(pred).reduce((s, r) => s + (r.amount_due ?? 0), 0);
  return {
    rows,
    outstanding_receivable: sum((r) => r.kind === 'ACCREC' && ['AUTHORISED'].includes(r.status)),
    outstanding_payable: sum((r) => r.kind === 'ACCPAY' && ['AUTHORISED'].includes(r.status)),
  };
}

export function save(input: any, user_id = 1) {
  const db = getDb();
  // Validate the email format when one is provided (it's optional).
  if (input.email && input.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(input.email).trim())) {
    throw new Error('That email address doesn’t look valid (e.g. name@example.com).');
  }
  const vals = FIELDS.map((f) => {
    const v = (input as any)[f];
    if (f === 'is_customer' || f === 'is_supplier' || f === 'credit_limit_block') return v ? 1 : 0;
    return v ?? null;
  });
  let id = input.id as number | undefined;
  if (input.name) {
    assertUniqueName({ table: 'contacts', column: 'name', value: input.name, excludeId: id, statuses: ['ACTIVE'], label: 'A contact named' });
  }
  if (id) {
    const before = get(id);
    db.prepare(`UPDATE contacts SET ${FIELDS.map((f) => `${f}=?`).join(', ')} WHERE id = ?`).run(...vals, id);
    audit('contact', id, 'UPDATE', before, input, user_id);
  } else {
    if (!input.name) throw new Error('Contact name is required');
    id = Number(db.prepare(`INSERT INTO contacts (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`).run(...vals).lastInsertRowid);
    audit('contact', id, 'CREATE', null, input, user_id);
  }
  // addresses (replace-all, simple and adequate for a desktop app)
  if (input.addresses) {
    db.prepare('DELETE FROM contact_addresses WHERE contact_id = ?').run(id);
    const ins = db.prepare('INSERT INTO contact_addresses (contact_id, type, line1, line2, city, region, postcode, country) VALUES (?,?,?,?,?,?,?,?)');
    for (const a of input.addresses) ins.run(id, a.type ?? 'BILLING', a.line1 ?? null, a.line2 ?? null, a.city ?? null, a.region ?? null, a.postcode ?? null, a.country ?? null);
  }
  return get(id);
}

export function archive(id: number, user_id = 1) {
  getDb().prepare("UPDATE contacts SET status = 'ARCHIVED' WHERE id = ?").run(id);
  audit('contact', id, 'ARCHIVE', null, null, user_id);
}

export function restore(id: number, user_id = 1) {
  getDb().prepare("UPDATE contacts SET status = 'ACTIVE' WHERE id = ?").run(id);
  audit('contact', id, 'RESTORE', null, null, user_id);
}

/** Every place a contact is referenced, with the actual column name to move.
 *  bank_rules stores the contact a rule assigns under set_contact_id. */
const CONTACT_REFS: Array<{ table: string; col: string }> = [
  { table: 'invoices', col: 'contact_id' },
  { table: 'quotes', col: 'contact_id' },
  { table: 'purchase_orders', col: 'contact_id' },
  { table: 'payments', col: 'contact_id' },
  { table: 'bank_transactions', col: 'contact_id' },
  { table: 'journal_lines', col: 'contact_id' },
  { table: 'manual_journal_lines', col: 'contact_id' },
  { table: 'repeating_invoices', col: 'contact_id' },
  { table: 'bank_rules', col: 'set_contact_id' },
];

export function mergePreview(fromId: number, intoId: number) {
  const db = getDb();
  if (fromId === intoId) throw new Error('Pick two different contacts');
  const from = get(fromId);
  const into = get(intoId);
  if (!from || !into) throw new Error('Both contacts must exist');
  const counts: Record<string, number> = {};
  let total = 0;
  for (const { table, col } of CONTACT_REFS) {
    const n = db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`).get(fromId).n as number;
    if (n > 0) counts[table] = n;
    total += n;
  }
  return { from, into, counts, total };
}

/**
 * Merge `fromId` into `intoId`: move every transaction reference onto the
 * surviving contact, then archive the duplicate (its name suffixed so the
 * list stays readable). The exact set of moved rows is recorded in
 * contact_merges, so unmerge() can put everything back precisely — including
 * restoring the archived contact and its original name.
 */
export function merge(fromId: number, intoId: number, user_id = 1, keepName?: string) {
  const db = getDb();
  if (fromId === intoId) throw new Error('Pick two different contacts');
  const from = get(fromId);
  const into = get(intoId);
  if (!from) throw new Error('The contact being merged was not found');
  if (!into) throw new Error('The contact to keep was not found');
  if (from.status !== 'ACTIVE') throw new Error('Only an active contact can be merged away');
  if (into.status !== 'ACTIVE') throw new Error('The contact you keep must be active');

  return db.transaction(() => {
    const moves: Record<string, number[]> = {};
    for (const { table, col } of CONTACT_REFS) {
      const rows = db.prepare(`SELECT id FROM ${table} WHERE ${col} = ?`).all(fromId) as Array<{ id: number }>;
      if (rows.length) {
        moves[table] = rows.map((r) => r.id);
        db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(intoId, fromId);
      }
    }
    const archivedName = /\(merged\)\s*$/.test(from.name) ? from.name : `${from.name} (merged)`;
    db.prepare("UPDATE contacts SET status = 'ARCHIVED', name = ? WHERE id = ?").run(archivedName, fromId);
    // Optionally adopt the duplicate's name on the survivor (now that the
    // duplicate's own name has the "(merged)" suffix there's no clash).
    if (keepName && keepName.trim() && keepName.trim() !== into.name) {
      assertUniqueName({ table: 'contacts', column: 'name', value: keepName.trim(), excludeId: intoId, statuses: ['ACTIVE'], label: 'A contact named' });
      db.prepare('UPDATE contacts SET name = ? WHERE id = ?').run(keepName.trim(), intoId);
    }

    const mergeId = Number(db.prepare(
      `INSERT INTO contact_merges (user_id, from_id, into_id, from_name_before, moves_json)
       VALUES (?, ?, ?, ?, ?)`
    ).run(user_id, fromId, intoId, from.name, JSON.stringify(moves)).lastInsertRowid);

    audit('contact', intoId, 'MERGE', { from: fromId, from_name: from.name, moves }, { merge_id: mergeId }, user_id);
    return { merge_id: mergeId, moved: Object.values(moves).reduce((s2, a) => s2 + a.length, 0) };
  });
}

/** History of merges that are still in effect (newest first). */
export function mergeHistory() {
  const db = getDb();
  return db.prepare(
    `SELECT m.*, u.name AS user_name,
            (SELECT name FROM contacts WHERE id = m.into_id) AS into_name,
            (SELECT status FROM contacts WHERE id = m.from_id) AS from_status
     FROM contact_merges m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.status = 'MERGED' ORDER BY m.id DESC LIMIT 50`
  ).all();
}

/**
 * Undo a merge done by mistake: move exactly the rows that were moved back to
 * the original contact, restore it to active with its original name. Only the
 * rows recorded at merge time are touched, so transactions that genuinely
 * belonged to the surviving contact (or were added afterwards) stay put.
 */
export function unmerge(mergeId: number, user_id = 1) {
  const db = getDb();
  const m = db.prepare("SELECT * FROM contact_merges WHERE id = ? AND status = 'MERGED'").get(mergeId);
  if (!m) throw new Error('That merge was not found or has already been undone');
  const fromExists = get(m.from_id);
  if (!fromExists) throw new Error('The archived contact no longer exists, so this merge cannot be undone');

  return db.transaction(() => {
    const moves: Record<string, number[]> = JSON.parse(m.moves_json || '{}');
    let restored = 0;
    for (const [t, ids] of Object.entries(moves)) {
      const ref = CONTACT_REFS.find((x) => x.table === t);
      if (!ref || !ids.length) continue;
      // Only move back rows that are still on the survivor — anything since
      // re-coded elsewhere is left exactly where it is.
      const placeholders = ids.map(() => '?').join(',');
      const r = db.prepare(
        `UPDATE ${ref.table} SET ${ref.col} = ? WHERE ${ref.col} = ? AND id IN (${placeholders})`
      ).run(m.from_id, m.into_id, ...ids);
      restored += r.changes ?? 0;
    }
    // Restore the original name; if the survivor has since taken that exact
    // name, keep the restored one distinct so the active-uniqueness rule holds.
    let restoreName: string = m.from_name_before;
    const clash = db.prepare(
      "SELECT id FROM contacts WHERE id != ? AND status = 'ACTIVE' AND LOWER(TRIM(name)) = LOWER(?) LIMIT 1"
    ).get(m.from_id, restoreName);
    if (clash) restoreName = `${restoreName} (unmerged)`;
    db.prepare("UPDATE contacts SET status = 'ACTIVE', name = ? WHERE id = ?").run(restoreName, m.from_id);
    db.prepare("UPDATE contact_merges SET status = 'UNMERGED' WHERE id = ?").run(mergeId);
    audit('contact', m.from_id, 'UNMERGE', { merge_id: mergeId }, { restored }, user_id);
    return { restored };
  });
}

/** Data for a customer statement: open invoices + activity in range. */
export function statement(id: number, from: string, to: string) {
  const db = getDb();
  const contact = get(id);
  const lines = db
    .prepare(
      `SELECT date, invoice_number AS number, 'Invoice' AS kind, total AS amount, amount_due FROM invoices
        WHERE contact_id = ? AND type = 'ACCREC' AND status IN ('AUTHORISED','PAID') AND date BETWEEN ? AND ?
       UNION ALL
       SELECT p.date, p.reference AS number, 'Payment' AS kind, -p.amount AS amount, 0 FROM payments p
        WHERE p.contact_id = ? AND p.type = 'RECEIVE' AND p.status = 'POSTED' AND p.date BETWEEN ? AND ?
       ORDER BY date`
    )
    .all(id, from, to, id, from, to);
  const outstanding = db
    .prepare(`SELECT COALESCE(SUM(amount_due),0) AS due FROM invoices WHERE contact_id = ? AND type='ACCREC' AND status='AUTHORISED'`)
    .get(id).due;
  return { contact, lines, outstanding, from, to };
}
