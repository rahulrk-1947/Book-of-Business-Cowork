/**
 * Find & Recode — search transaction LINES across invoices/bills/credits,
 * spend & receive money, and manual journals; then re-code the chosen lines'
 * account, tax rate, tracking, or the document's contact.
 *
 * Safety model (each document is processed in its own transaction):
 *  - Amount-neutral changes (account, tracking, contact) are allowed on any
 *    live status including PAID: the document's posted journal is rebuilt
 *    IN PLACE from the same posting logic that created it, so totals, the
 *    journal number, and Σdebits = Σcredits are all preserved.
 *  - Tax-rate changes alter amounts, so they're only allowed on documents
 *    with no money attached (no payments, no credit allocations) — and only
 *    on invoices/bills/credits, where totals are recomputed properly.
 *  - Documents in a locked period, voided/deleted documents, and manual
 *    journals with an auto-reversal are skipped with a per-item reason —
 *    skipped items never block the rest.
 * Every run is recorded (criteria, changes, before/after per line).
 */
import { getDb } from '../db';
import { audit } from '../engine';
import * as invoices from './invoices';
import * as banking from './banking';
import * as journals from './journals';
import { assertDateUnlocked } from '../engine';

// ── Search ──────────────────────────────────────────────────────────────────

export type Cond =
  | { field: 'type'; values: string[] }
  | { field: 'status'; values: string[] }
  | { field: 'account'; op: 'in' | 'not_in'; values: number[] }
  | { field: 'contact'; op: 'in' | 'not_in'; values: number[] }
  | { field: 'tax'; values: number[] }
  | { field: 'tracking'; values: number[] }
  | { field: 'bank_account'; values: number[] }
  | { field: 'date'; from?: string; to?: string }
  | { field: 'amount'; min?: number; max?: number }
  | { field: 'text'; value: string };

export type SearchInput = { match: 'all' | 'any'; conds: Cond[] };

export type FoundLine = {
  source: 'INVOICE' | 'BANKTXN' | 'MANUAL';
  doc_id: number;
  line_id: number;
  date: string;
  type: string;
  type_label: string;
  status: string;
  contact_id: number | null;
  contact_name: string | null;
  number: string | null;
  reference: string | null;
  description: string | null;
  account_id: number;
  account_code: string;
  account_name: string;
  tax_rate_id: number | null;
  tax_name: string | null;
  tracking_option_1: number | null;
  tracking_option_2: number | null;
  tracking_1: string | null;
  tracking_2: string | null;
  amount: number;
  currency_code: string | null;
  bank_account_id: number | null;
};

const TYPE_LABEL: Record<string, string> = {
  ACCREC: 'Invoice', ACCPAY: 'Bill', ACCRECCREDIT: 'Credit note', ACCPAYCREDIT: 'Supplier credit',
  SPEND: 'Spend money', RECEIVE: 'Receive money', MANUAL: 'Manual journal',
};

function fetchAllLines(): FoundLine[] {
  const db = getDb();
  const out: FoundLine[] = [];
  for (const r of db.prepare(`
    SELECT 'INVOICE' AS source, i.id AS doc_id, il.id AS line_id, i.date, i.type, i.status,
           i.contact_id, c.name AS contact_name, i.invoice_number AS number, i.reference,
           il.description, il.account_id, a.code AS account_code, a.name AS account_name,
           il.tax_rate_id, tr.name AS tax_name,
           il.tracking_option_1, il.tracking_option_2, t1.name AS tracking_1, t2.name AS tracking_2,
           il.line_amount AS amount, i.currency_code, NULL AS bank_account_id
    FROM invoice_lines il
    JOIN invoices i ON i.id = il.invoice_id
    JOIN accounts a ON a.id = il.account_id
    LEFT JOIN contacts c ON c.id = i.contact_id
    LEFT JOIN tax_rates tr ON tr.id = il.tax_rate_id
    LEFT JOIN tracking_options t1 ON t1.id = il.tracking_option_1
    LEFT JOIN tracking_options t2 ON t2.id = il.tracking_option_2
    WHERE i.status NOT IN ('DELETED') AND i.type IN ('ACCREC','ACCPAY','ACCRECCREDIT','ACCPAYCREDIT')`).all()) out.push({ ...r, type_label: TYPE_LABEL[r.type] ?? r.type });

  for (const r of db.prepare(`
    SELECT 'BANKTXN' AS source, b.id AS doc_id, bl.id AS line_id, b.date, b.type, b.status,
           b.contact_id, c.name AS contact_name, NULL AS number, b.reference,
           bl.description, bl.account_id, a.code AS account_code, a.name AS account_name,
           bl.tax_rate_id, tr.name AS tax_name,
           bl.tracking_option_1, bl.tracking_option_2, t1.name AS tracking_1, t2.name AS tracking_2,
           bl.line_amount AS amount, NULL AS currency_code, b.bank_account_id
    FROM bank_transaction_lines bl
    JOIN bank_transactions b ON b.id = bl.bank_transaction_id
    JOIN accounts a ON a.id = bl.account_id
    LEFT JOIN contacts c ON c.id = b.contact_id
    LEFT JOIN tax_rates tr ON tr.id = bl.tax_rate_id
    LEFT JOIN tracking_options t1 ON t1.id = bl.tracking_option_1
    LEFT JOIN tracking_options t2 ON t2.id = bl.tracking_option_2
    WHERE b.status NOT IN ('VOIDED','DELETED')`).all()) out.push({ ...r, type_label: TYPE_LABEL[r.type] ?? r.type });

  for (const r of db.prepare(`
    SELECT 'MANUAL' AS source, m.id AS doc_id, ml.id AS line_id, m.date, 'MANUAL' AS type, m.status,
           ml.contact_id, c.name AS contact_name, NULL AS number, m.narration AS reference,
           ml.description, ml.account_id, a.code AS account_code, a.name AS account_name,
           ml.tax_rate_id, tr.name AS tax_name,
           ml.tracking_option_1, ml.tracking_option_2, t1.name AS tracking_1, t2.name AS tracking_2,
           CASE WHEN ml.debit > 0 THEN ml.debit ELSE -ml.credit END AS amount, NULL AS currency_code, NULL AS bank_account_id
    FROM manual_journal_lines ml
    JOIN manual_journals m ON m.id = ml.manual_journal_id
    JOIN accounts a ON a.id = ml.account_id
    LEFT JOIN contacts c ON c.id = ml.contact_id
    LEFT JOIN tax_rates tr ON tr.id = ml.tax_rate_id
    LEFT JOIN tracking_options t1 ON t1.id = ml.tracking_option_1
    LEFT JOIN tracking_options t2 ON t2.id = ml.tracking_option_2
    WHERE m.status NOT IN ('VOIDED','DELETED')`).all()) out.push({ ...r, type_label: TYPE_LABEL[r.type] ?? r.type });
  return out;
}

function matches(l: FoundLine, c: Cond): boolean {
  switch (c.field) {
    case 'type': return c.values.includes(l.type);
    case 'status': return c.values.includes(l.status);
    case 'account': {
      const hit = c.values.includes(l.account_id);
      return c.op === 'not_in' ? !hit : hit;
    }
    case 'contact': {
      const hit = l.contact_id != null && c.values.includes(l.contact_id);
      return c.op === 'not_in' ? !hit : hit;
    }
    case 'tax': return l.tax_rate_id != null && c.values.includes(l.tax_rate_id);
    case 'tracking':
      return (l.tracking_option_1 != null && c.values.includes(l.tracking_option_1))
        || (l.tracking_option_2 != null && c.values.includes(l.tracking_option_2));
    case 'bank_account': return l.bank_account_id != null && c.values.includes(l.bank_account_id);
    case 'date':
      if (c.from && l.date < c.from) return false;
      if (c.to && l.date > c.to) return false;
      return true;
    case 'amount': {
      const a = Math.abs(l.amount);
      if (c.min != null && a < c.min) return false;
      if (c.max != null && a > c.max) return false;
      return true;
    }
    case 'text': {
      const q = c.value.trim().toLowerCase();
      if (!q) return true;
      return [l.number, l.reference, l.description, l.contact_name]
        .some((s) => (s ?? '').toLowerCase().includes(q));
    }
    default: return true;
  }
}

export function search(input: SearchInput) {
  const conds = (input.conds ?? []).filter(Boolean);
  if (!conds.length) throw new Error('Add at least one condition');
  const all = fetchAllLines();
  const test = (l: FoundLine) =>
    input.match === 'any' ? conds.some((c) => matches(l, c)) : conds.every((c) => matches(l, c));
  const hits = all.filter(test).sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.line_id - a.line_id));
  const docs = new Set(hits.map((h) => `${h.source}:${h.doc_id}`)).size;
  return { total: hits.length, transactions: docs, lines: hits.slice(0, 5000), truncated: hits.length > 5000 };
}

// ── Recode ──────────────────────────────────────────────────────────────────

export type Changes = {
  contact_id?: number;
  account_id?: number;
  tax_rate_id?: number;
  /** null clears the option; undefined leaves it alone. */
  tracking_option_1?: number | null;
  tracking_option_2?: number | null;
};

export type Target = { source: FoundLine['source']; doc_id: number; line_id: number };

export function recode(input: { targets: Target[]; changes: Changes; criteria?: unknown }, user_id = 1) {
  const db = getDb();
  const ch = input.changes ?? {};
  const wantsAnything = ['contact_id', 'account_id', 'tax_rate_id', 'tracking_option_1', 'tracking_option_2']
    .some((k) => (ch as any)[k] !== undefined);
  if (!wantsAnything) throw new Error('Choose at least one thing to change');
  if (!input.targets?.length) throw new Error('Select at least one line to recode');

  const runId = Number(db.prepare(
    'INSERT INTO recode_runs (user_id, criteria_json, changes_json) VALUES (?, ?, ?)'
  ).run(user_id, JSON.stringify(input.criteria ?? null), JSON.stringify(ch)).lastInsertRowid);
  const insItem = db.prepare(
    'INSERT INTO recode_items (run_id, source, doc_id, line_id, status, reason, before_json, after_json) VALUES (?,?,?,?,?,?,?,?)'
  );

  // Group targets per document — each document succeeds or skips atomically.
  const byDoc = new Map<string, Target[]>();
  for (const t of input.targets) {
    const k = `${t.source}:${t.doc_id}`;
    if (!byDoc.has(k)) byDoc.set(k, []);
    byDoc.get(k)!.push(t);
  }

  let done = 0;
  let skipped = 0;
  const results: Array<{ source: string; doc_id: number; lines: number; status: 'DONE' | 'SKIPPED'; reason?: string; label: string }> = [];
  const lineCols = {
    INVOICE: { table: 'invoice_lines', fk: 'invoice_id' },
    BANKTXN: { table: 'bank_transaction_lines', fk: 'bank_transaction_id' },
    MANUAL: { table: 'manual_journal_lines', fk: 'manual_journal_id' },
  } as const;

  for (const [key, targets] of byDoc) {
    const source = targets[0].source;
    const docId = targets[0].doc_id;
    const lineIds = targets.map((t) => t.line_id);
    const cols = lineCols[source];
    let label = key;
    try {
      db.transaction(() => {
        // Load + guard
        const doc =
          source === 'INVOICE' ? db.prepare('SELECT * FROM invoices WHERE id = ?').get(docId)
          : source === 'BANKTXN' ? db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(docId)
          : db.prepare('SELECT * FROM manual_journals WHERE id = ?').get(docId);
        if (!doc) throw new Error('Document not found');
        label = source === 'INVOICE' ? `${TYPE_LABEL[doc.type]} ${doc.invoice_number ?? docId}`
          : source === 'BANKTXN' ? `${TYPE_LABEL[doc.type]} ${doc.reference ?? '#' + docId}`
          : `Journal — ${doc.narration ?? '#' + docId}`;
        if (['VOIDED', 'DELETED'].includes(doc.status)) throw new Error(`is ${doc.status.toLowerCase()} — nothing to recode`);
        assertDateUnlocked(doc.date); // locked periods stay locked

        const posted = source === 'INVOICE'
          ? ['AUTHORISED', 'PAID'].includes(doc.status)
          : doc.status === 'POSTED';

        if (ch.tax_rate_id !== undefined) {
          if (source !== 'INVOICE') throw new Error('tax can only be recoded on invoices, bills and credit notes — edit the document for other types');
          if (doc.amount_paid && doc.amount_paid !== 0) throw new Error('has payments — tax changes would break the amounts. Remove payments first');
          const allocs = db.prepare(
            'SELECT COUNT(*) AS n FROM credit_allocations WHERE target_invoice_id = ? OR credit_invoice_id = ?'
          ).get(docId, docId).n;
          if (allocs > 0) throw new Error('has credit allocations — tax changes would break the amounts');
        }
        if (ch.contact_id !== undefined && source === 'MANUAL') {
          throw new Error('manual journals have no document contact — edit the journal lines directly');
        }
        if (source === 'MANUAL' && doc.auto_reversing_date && posted) {
          throw new Error('has an auto-reversal scheduled — recoding would desync the pair. Edit it directly');
        }

        // Snapshot before
        const before = db.prepare(
          `SELECT id, account_id, tax_rate_id, tracking_option_1, tracking_option_2 FROM ${cols.table} WHERE ${cols.fk} = ? AND id IN (${lineIds.map(() => '?').join(',')})`
        ).all(docId, ...lineIds);
        if (before.length !== lineIds.length) throw new Error('some selected lines no longer exist');

        // Apply line-level changes
        const sets: string[] = [];
        const args: any[] = [];
        if (ch.account_id !== undefined) { sets.push('account_id = ?'); args.push(ch.account_id); }
        if (ch.tax_rate_id !== undefined && source === 'INVOICE') { sets.push('tax_rate_id = ?'); args.push(ch.tax_rate_id); }
        if (ch.tracking_option_1 !== undefined) { sets.push('tracking_option_1 = ?'); args.push(ch.tracking_option_1); }
        if (ch.tracking_option_2 !== undefined) { sets.push('tracking_option_2 = ?'); args.push(ch.tracking_option_2); }
        if (sets.length) {
          db.prepare(`UPDATE ${cols.table} SET ${sets.join(', ')} WHERE ${cols.fk} = ? AND id IN (${lineIds.map(() => '?').join(',')})`)
            .run(...args, docId, ...lineIds);
        }
        // Document-level contact
        if (ch.contact_id !== undefined && source !== 'MANUAL') {
          db.prepare(`UPDATE ${source === 'INVOICE' ? 'invoices' : 'bank_transactions'} SET contact_id = ? WHERE id = ?`).run(ch.contact_id, docId);
        }
        // Tax → recompute money
        if (ch.tax_rate_id !== undefined && source === 'INVOICE') {
          invoices.recomputeStoredTotals(docId);
        }
        // Rebuild the posted journal in place so the ledger matches the document again
        if (posted) {
          if (source === 'INVOICE') invoices.rebuildMainJournal(docId);
          else if (source === 'BANKTXN') banking.rebuildBankTxnJournal(docId);
          else journals.rebuildManualLedger(docId);
        }

        const after = db.prepare(
          `SELECT id, account_id, tax_rate_id, tracking_option_1, tracking_option_2 FROM ${cols.table} WHERE ${cols.fk} = ? AND id IN (${lineIds.map(() => '?').join(',')})`
        ).all(docId, ...lineIds);
        for (const b of before) {
          const a = after.find((x: any) => x.id === b.id);
          insItem.run(runId, source, docId, b.id, 'DONE', null, JSON.stringify(b), JSON.stringify(a));
        }
        audit('recode', docId, 'RECODE', { source, lines: lineIds }, ch, user_id);
      });
      done += lineIds.length;
      results.push({ source, doc_id: docId, lines: lineIds.length, status: 'DONE', label });
    } catch (e: any) {
      skipped += lineIds.length;
      for (const lid of lineIds) insItem.run(runId, source, docId, lid, 'SKIPPED', e.message, null, null);
      results.push({ source, doc_id: docId, lines: lineIds.length, status: 'SKIPPED', reason: e.message, label });
    }
  }

  db.prepare('UPDATE recode_runs SET items_done = ?, items_skipped = ? WHERE id = ?').run(done, skipped, runId);
  return { run_id: runId, done, skipped, results };
}

export function history() {
  const db = getDb();
  const runs = db.prepare(
    `SELECT r.*, u.name AS user_name FROM recode_runs r LEFT JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT 50`
  ).all();
  return runs;
}

export function runItems(run_id: number) {
  return getDb().prepare('SELECT * FROM recode_items WHERE run_id = ? ORDER BY id').all(run_id);
}
