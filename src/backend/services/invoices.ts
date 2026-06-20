/**
 * The document layer for Sales & Purchases. One engine serves four document
 * types (spec §5–6): ACCREC (sales invoice), ACCPAY (bill), ACCRECCREDIT
 * (customer credit note), ACCPAYCREDIT (supplier credit note).
 *
 * Lifecycle: DRAFT → SUBMITTED → AUTHORISED → PAID, or VOIDED.
 * DRAFT/SUBMITTED post nothing. AUTHORISED posts the journal. PAID is driven
 * by allocations, never set by hand. VOID reverses the journal.
 */
import { getDb } from '../db';
import {
  postJournal, voidJournalsForSource, audit, nextNumber, systemAccount,
  taxComponents, taxRateType, today, assertDateUnlocked, assertValidDate, PostingError, baseCurrency,
} from '../engine';
import { calcDocument, LineAmountType } from '../tax';
import { toBase, formatCents } from '../money';
import * as items from './items';
import { syncProjectCostsFromDoc, removeProjectCostsForDoc } from './project-costing';

/**
 * Which posted purchase documents feed project costs, and with what sign.
 * A bill adds cost; a supplier credit (money back on a purchase) subtracts it.
 * Returns null for documents that don't touch project costs (sales, quotes…).
 */
function projectCostSource(type: string): { source_type: string; sign: number } | null {
  if (type === 'ACCPAY') return { source_type: 'BILL', sign: 1 };
  if (type === 'ACCPAYCREDIT') return { source_type: 'SUPPLIERCREDIT', sign: -1 };
  return null;
}

export type InvoiceType = 'ACCREC' | 'ACCPAY' | 'ACCRECCREDIT' | 'ACCPAYCREDIT';

export interface DocLineInput {
  item_id?: number | null;
  description: string;
  quantity: number;
  unit_amount: number; // cents
  discount_percent?: number;
  account_id: number;
  tax_rate_id?: number | null;
  tracking_option_1?: number | null;
  tracking_option_2?: number | null;
}

export interface DocInput {
  id?: number;
  type: InvoiceType;
  /** Optional explicit number (CSV import); otherwise auto-assigned. */
  invoice_number?: string;
  contact_id: number;
  date: string;
  due_date?: string;
  reference?: string;
  currency_code?: string;
  exchange_rate?: number;
  line_amount_type?: LineAmountType;
  lines: DocLineInput[];
}

/** Control accounts posted automatically by the engine — never hand-coded
 *  onto a document line. (COGS, Depreciation, Wages Payable etc. carry a
 *  system_account tag too, but they ARE valid posting accounts, so they're
 *  deliberately not in this set.) */
export const LOCKED_SYSTEM_ACCOUNTS = ['AR', 'AP', 'GST', 'RETAINED_EARNINGS', 'ROUNDING', 'UNREALISED_FX', 'REALISED_FX', 'CUSTOMER_PREPAYMENT', 'SUPPLIER_PREPAYMENT'];

function assertNoSystemAccounts(lines: Array<{ account_id: number }>) {
  const db = getDb();
  const ids = [...new Set(lines.map((l) => l.account_id).filter(Boolean))];
  if (!ids.length) return;
  const bad = db.prepare(
    `SELECT code, name FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})
      AND system_account IN (${LOCKED_SYSTEM_ACCOUNTS.map(() => '?').join(',')}) LIMIT 1`
  ).get(...ids, ...LOCKED_SYSTEM_ACCOUNTS) as { code: string; name: string } | undefined;
  if (bad) throw new Error(`"${bad.code} ${bad.name}" is a control account that's posted automatically — choose a normal account for this line.`);
}

function computeTotals(input: DocInput) {
  const mode = input.line_amount_type ?? 'EXCLUSIVE';
  return calcDocument(
    input.lines.map((l) => ({
      quantity: l.quantity,
      unit_amount: l.unit_amount,
      discount_percent: l.discount_percent,
      components: taxComponents(l.tax_rate_id),
    })),
    mode
  );
}

/** Compact snapshot of a document's coding/totals for the change history. */
function docSnapshot(id: number): Record<string, unknown> | null {
  const db = getDb();
  const inv: any = db.prepare(
    `SELECT i.date, i.due_date, i.reference, i.invoice_number, i.line_amount_type, i.total, i.total_tax,
            c.name AS contact FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id WHERE i.id = ?`
  ).get(id);
  if (!inv) return null;
  const lines = db.prepare(
    `SELECT il.description, il.quantity, il.unit_amount, il.line_amount, a.code AS account_code, a.name AS account_name, tr.name AS tax
       FROM invoice_lines il JOIN accounts a ON a.id = il.account_id
       LEFT JOIN tax_rates tr ON tr.id = il.tax_rate_id WHERE il.invoice_id = ? ORDER BY il.line_order`
  ).all(id);
  return {
    contact: inv.contact, date: inv.date, due_date: inv.due_date, reference: inv.reference,
    total: inv.total, total_tax: inv.total_tax,
    lines: lines.map((l: any) => ({ description: l.description, qty: l.quantity, unit_amount: l.unit_amount,
      amount: l.line_amount, account: `${l.account_code} ${l.account_name}`, tax: l.tax })),
  };
}

/** Resolve a document's exchange rate: an explicit positive rate wins; else
 *  look up the latest rate on/before the date for a foreign currency (base
 *  currency is always 1, and an unknown foreign rate falls back to 1). */
function resolveRate(currency_code: string | undefined, date: string, provided?: number): number {
  const base = baseCurrency();
  const cur = currency_code ?? base;
  if (cur === base) return 1;
  if (provided != null && provided > 0) return provided;
  const r = getDb()
    .prepare('SELECT rate FROM exchange_rates WHERE currency_code = ? AND date <= ? ORDER BY date DESC LIMIT 1')
    .get(cur, date) as { rate: number } | undefined;
  return r?.rate ?? 1;
}

export function saveDraft(input: DocInput, user_id = 1) {
  const db = getDb();
  if (!input.lines?.length) throw new Error('At least one line is required');
  // A real, in-range date (rejects 30 Feb, year typos, blanks).
  assertValidDate(input.date, 'Invoice date');
  if (input.due_date) assertValidDate(input.due_date, 'Due date');
  // Every line needs a positive quantity — a zero-qty line records nothing and
  // is almost always a mistake.
  input.lines.forEach((l, i) => {
    if (l.quantity == null || !(l.quantity > 0)) {
      throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
    }
    const dp = l.discount_percent ?? 0;
    if (!(dp >= 0 && dp <= 100)) {
      throw new Error(`Line ${i + 1}: discount must be between 0 and 100 percent`);
    }
  });
  // A foreign-currency document must carry a positive exchange rate. If a rate
  // is supplied it must be > 0; otherwise look one up for the document's date
  // (previously a missing rate silently became 1.0, booking foreign amounts at
  // par and zeroing realised FX on settlement).
  if (input.exchange_rate != null && !(input.exchange_rate > 0)) {
    throw new Error('Exchange rate must be greater than zero');
  }
  const exchangeRate = resolveRate(input.currency_code, input.date, input.exchange_rate);
  // Control accounts (Accounts Receivable / Payable, GST, etc.) are posted
  // automatically — they must never sit on a document line.
  assertNoSystemAccounts(input.lines);
  const totals = computeTotals(input);
  return db.transaction(() => {
    let id = input.id;
    let beforeSnapshot: Record<string, unknown> | null = null;
    if (id) {
      const existing = db.prepare('SELECT status FROM invoices WHERE id = ?').get(id);
      if (!existing) throw new Error('Document not found');
      if (!['DRAFT', 'SUBMITTED'].includes(existing.status)) {
        throw new Error(`Only draft documents can be edited (status: ${existing.status}). Void it or raise a credit note.`);
      }
      beforeSnapshot = docSnapshot(id);
      db.prepare(
        `UPDATE invoices SET contact_id=?, date=?, due_date=?, reference=?, currency_code=?, exchange_rate=?,
         line_amount_type=?, subtotal=?, total_tax=?, total=?, amount_due=?, updated_at=datetime('now') WHERE id=?`
      ).run(
        input.contact_id, input.date, input.due_date ?? null, input.reference ?? null,
        input.currency_code ?? baseCurrency(), exchangeRate,
        input.line_amount_type ?? 'EXCLUSIVE', totals.subtotal, totals.total_tax, totals.total, totals.total, id
      );
      db.prepare('DELETE FROM invoice_lines WHERE invoice_id = ?').run(id);
    } else {
      id = Number(
        db.prepare(
          `INSERT INTO invoices (type, invoice_number, contact_id, date, due_date, reference, currency_code, exchange_rate,
             line_amount_type, status, subtotal, total_tax, total, amount_paid, amount_due)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?, ?, ?, 0, ?)`
        ).run(
          input.type,
          input.invoice_number ?? numberFor(input.type),
          input.contact_id, input.date, input.due_date ?? null, input.reference ?? null,
          input.currency_code ?? baseCurrency(), exchangeRate,
          input.line_amount_type ?? 'EXCLUSIVE', totals.subtotal, totals.total_tax, totals.total, totals.total
        ).lastInsertRowid
      );
      audit('invoice', id, 'CREATE', null, { type: input.type }, user_id);
    }
    const ins = db.prepare(
      `INSERT INTO invoice_lines (invoice_id, line_order, item_id, description, quantity, unit_amount, discount_percent,
         account_id, tax_rate_id, tracking_option_1, tracking_option_2, project_id, line_amount, tax_amount)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    input.lines.forEach((l, i) => {
      ins.run(id, i, l.item_id ?? null, l.description, l.quantity, l.unit_amount, l.discount_percent ?? 0,
        l.account_id, l.tax_rate_id ?? null, l.tracking_option_1 ?? null, l.tracking_option_2 ?? null, (l as any).project_id ?? null,
        totals.lines[i].net, totals.lines[i].tax);
    });
    // Record an edit in the history with a before/after snapshot, so the
    // change log shows exactly what was altered and by whom.
    if (beforeSnapshot) {
      audit('invoice', id!, 'EDITED', beforeSnapshot, docSnapshot(id!), user_id);
    }
    return get(id!);
  });
}

function numberFor(type: InvoiceType): string {
  if (type === 'ACCREC') return nextNumber('INVOICE');
  if (type === 'ACCPAY') return nextNumber('BILL');
  return nextNumber('CREDITNOTE');
}

export function get(id: number) {
  const db = getDb();
  const inv = db
    .prepare(`SELECT i.*, c.name AS contact_name,
                     c.email AS contact_email, c.phone AS contact_phone, c.tax_number AS contact_tax_number
              FROM invoices i JOIN contacts c ON c.id = i.contact_id WHERE i.id = ?`)
    .get(id);
  if (!inv) return null;
  // Billing address (falls back to any address) for the document letterhead.
  inv.contact_address = db
    .prepare(`SELECT line1, line2, city, region, postcode, country FROM contact_addresses
              WHERE contact_id = ? ORDER BY (type = 'BILLING') DESC, id LIMIT 1`)
    .get(inv.contact_id) ?? null;
  inv.lines = db
    .prepare(`SELECT l.*, a.code AS account_code, a.name AS account_name, t.name AS tax_rate_name,
                     t1.name AS tracking_1, t2.name AS tracking_2
              FROM invoice_lines l JOIN accounts a ON a.id = l.account_id
              LEFT JOIN tax_rates t ON t.id = l.tax_rate_id
              LEFT JOIN tracking_options t1 ON t1.id = l.tracking_option_1
              LEFT JOIN tracking_options t2 ON t2.id = l.tracking_option_2
              WHERE l.invoice_id = ? ORDER BY l.line_order`)
    .all(id);
  inv.payments = db
    .prepare(`SELECT p.id, p.date, p.reference, pa.amount FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id WHERE pa.invoice_id = ? AND p.status='POSTED'`)
    .all(id);
  inv.credits = db
    .prepare(`SELECT ca.amount, ca.date, i2.invoice_number AS number FROM credit_allocations ca JOIN invoices i2 ON i2.id = ca.credit_invoice_id WHERE ca.target_invoice_id = ?`)
    .all(id);
  return inv;
}

export function list(opts: { type: InvoiceType | InvoiceType[]; status?: string; search?: string; overdue?: boolean } ) {
  const db = getDb();
  const types = Array.isArray(opts.type) ? opts.type : [opts.type];
  const where = [`i.type IN (${types.map(() => '?').join(',')})`, `i.status != 'DELETED'`];
  const params: unknown[] = [...types];
  if (opts.status && opts.status !== 'ALL') {
    where.push('i.status = ?');
    params.push(opts.status);
  }
  if (opts.overdue) where.push(`i.status = 'AUTHORISED' AND i.due_date < date('now')`);
  if (opts.search) {
    where.push('(i.invoice_number LIKE ? OR i.reference LIKE ? OR c.name LIKE ?)');
    params.push(`%${opts.search}%`, `%${opts.search}%`, `%${opts.search}%`);
  }
  return db
    .prepare(`SELECT i.*, c.name AS contact_name FROM invoices i JOIN contacts c ON c.id = i.contact_id
              WHERE ${where.join(' AND ')} ORDER BY i.date DESC, i.id DESC LIMIT 500`)
    .all(...params);
}

/**
 * Authorise: post the journal (spec §2.5) and, for tracked items, the
 * inventory side (COGS on sales; inventory asset on purchases).
 */
export function approve(id: number, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const inv = get(id);
    if (!inv) throw new Error('Document not found');
    if (!['DRAFT', 'SUBMITTED'].includes(inv.status)) throw new Error(`Cannot approve a ${inv.status} document`);
    // Approval gate — only bites when approval rules are configured for this
    // document type (otherwise unchanged). Reads tables directly to avoid an
    // import cycle; if the approvals tables are absent (pre-migration), it no-ops.
    let needsApproval = false;
    try {
      if (inv.type === 'ACCREC' || inv.type === 'ACCPAY') {
        const ruleHit = db.prepare('SELECT 1 FROM approval_rules WHERE enabled=1 AND doc_type=? AND min_amount<=? LIMIT 1').get(inv.type, inv.total);
        if (ruleHit) needsApproval = !db.prepare("SELECT 1 FROM approvals WHERE doc_type=? AND doc_id=? AND status='APPROVED' LIMIT 1").get(inv.type, id);
      }
    } catch { /* approvals infrastructure not present yet */ }
    if (needsApproval) throw new Error(`This ${inv.type === 'ACCPAY' ? 'bill' : 'invoice'} needs approval before it can be posted — submit it for approval.`);
    assertDateUnlocked(inv.date);

    const isSale = inv.type === 'ACCREC' || inv.type === 'ACCRECCREDIT';
    const isCredit = inv.type.endsWith('CREDIT');
    const sign = isCredit ? -1 : 1;
    const rate = inv.exchange_rate ?? 1;
    const { lines, narration } = buildPostingLines(inv);

    const journal_id = postJournal({
      date: inv.date,
      narration,
      source_type: 'INVOICE',
      source_id: id,
      currency_code: inv.currency_code,
      exchange_rate: rate,
      lines,
      user_id,
    });

    // Inventory movements + COGS for tracked items
    for (const l of inv.lines) {
      if (!l.item_id) continue;
      const item = items.get(l.item_id);
      if (!item?.is_tracked) continue;
      if (isSale) {
        const qty = sign * l.quantity; // credit note returns stock
        const cogs = items.recordMovement(l.item_id, inv.date, 'INVOICE', id, -qty);
        if (cogs !== 0) {
          postJournal({
            date: inv.date,
            narration: `COGS ${item.code} × ${qty} (${inv.invoice_number})`,
            source_type: 'INVOICE',
            source_id: id,
            lines: [
              { account_id: item.cogs_account_id ?? systemAccount('COGS'), debit: cogs > 0 ? cogs : 0, credit: cogs < 0 ? -cogs : 0 },
              { account_id: item.inventory_asset_account_id, credit: cogs > 0 ? cogs : 0, debit: cogs < 0 ? -cogs : 0 },
            ],
            user_id,
          });
        }
      } else {
        const qty = sign * l.quantity;
        const unitCost = Math.round(toBase(l.line_amount, rate) / l.quantity);
        items.recordMovement(l.item_id, inv.date, 'BILL', id, qty, unitCost);
      }
    }

    db.prepare("UPDATE invoices SET status='AUTHORISED', updated_at=datetime('now') WHERE id = ?").run(id);
    // A posted bill's project-tagged lines add costs to those projects; a
    // supplier credit's tagged lines subtract them (a negative cost).
    const pcs = projectCostSource(inv.type);
    if (pcs) {
      const costLines = (db.prepare('SELECT project_id, description, line_amount FROM invoice_lines WHERE invoice_id = ? AND project_id IS NOT NULL').all(id) as any[])
        .map((l) => ({ project_id: l.project_id, description: l.description, amount: l.line_amount * pcs.sign }));
      if (costLines.length) syncProjectCostsFromDoc(db, { source_type: pcs.source_type, source_id: id, date: inv.date, lines: costLines });
    }
    audit('invoice', id, 'APPROVE', { status: inv.status }, { status: 'AUTHORISED', journal_id }, user_id);
    return get(id);
  });
}

function push(
  lines: any[], account_id: number, signedDr: number, description?: string,
  tax_rate_id?: number | null, contact_id?: number | null, t1?: number | null, t2?: number | null
) {
  if (signedDr === 0) return;
  lines.push({
    account_id,
    debit: signedDr > 0 ? signedDr : 0,
    credit: signedDr < 0 ? -signedDr : 0,
    description, tax_rate_id, contact_id, tracking_option_1: t1, tracking_option_2: t2,
  });
}

function docLabel(type: InvoiceType) {
  return { ACCREC: 'Invoice', ACCPAY: 'Bill', ACCRECCREDIT: 'Credit Note', ACCPAYCREDIT: 'Supplier Credit' }[type];
}

export function submit(id: number, user_id = 1) {
  const db = getDb();
  const inv = db.prepare('SELECT status FROM invoices WHERE id = ?').get(id);
  if (inv?.status !== 'DRAFT') throw new Error('Only drafts can be submitted for approval');
  db.prepare("UPDATE invoices SET status='SUBMITTED' WHERE id = ?").run(id);
  audit('invoice', id, 'SUBMIT', null, null, user_id);
}

export function markSent(id: number, user_id = 1) {
  getDb().prepare("UPDATE invoices SET sent_status='SENT' WHERE id = ?").run(id);
  audit('invoice', id, 'SENT', null, null, user_id);
}

/** Reverse the GL journals and inventory movements of an AUTHORISED doc. */
function reverseApprovedPostings(inv: any, user_id: number) {
  voidJournalsForSource('INVOICE', inv.id, user_id);
  for (const l of inv.lines) {
    if (!l.item_id) continue;
    const item = items.get(l.item_id);
    if (!item?.is_tracked) continue;
    const isSale = inv.type === 'ACCREC';
    if (isSale) items.recordMovement(l.item_id, today(), 'VOID', inv.id, l.quantity);
    else items.recordMovement(l.item_id, today(), 'VOID', inv.id, -l.quantity, item.average_cost);
  }
}

export function voidDoc(id: number, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const inv = get(id);
    if (!inv) throw new Error('Document not found');
    if (inv.amount_paid > 0) throw new Error('Part-paid documents cannot be voided — raise a credit note instead');
    if (['DRAFT', 'SUBMITTED'].includes(inv.status)) {
      db.prepare("UPDATE invoices SET status='DELETED' WHERE id = ?").run(id);
    } else if (inv.status === 'AUTHORISED') {
      // Voiding posts a reversing journal — it must respect the period lock.
      assertDateUnlocked(inv.date);
      reverseApprovedPostings(inv, user_id);
      db.prepare("UPDATE invoices SET status='VOIDED', amount_due=0 WHERE id = ?").run(id);
      { const pcs = projectCostSource(inv.type); if (pcs) removeProjectCostsForDoc(db, pcs.source_type, id); }
    } else {
      throw new Error(`Cannot void a ${inv.status} document`);
    }
    audit('invoice', id, 'VOID', { status: inv.status }, null, user_id);
  });
}

// ── Bulk actions ────────────────────────────────────────────────────────────
// Process many documents at once, applying each in its own transaction so one
// bad apple (e.g. an already-approved or part-paid doc) doesn't roll back the
// rest. Returns a clear tally the UI can show: how many worked, and exactly
// which ones were skipped and why.

export type BulkResult = {
  ok_count: number;
  fail_count: number;
  succeeded: number[];
  failed: Array<{ id: number; number?: string; error: string }>;
};

function numberOf(id: number): string | undefined {
  try { return (getDb().prepare('SELECT invoice_number FROM invoices WHERE id = ?').get(id) as any)?.invoice_number; }
  catch { return undefined; }
}

function runBulk(ids: number[], op: (id: number, user_id: number) => void, user_id: number): BulkResult {
  const succeeded: number[] = [];
  const failed: BulkResult['failed'] = [];
  for (const id of ids ?? []) {
    try { op(id, user_id); succeeded.push(id); }
    catch (e: any) { failed.push({ id, number: numberOf(id), error: e?.message ?? String(e) }); }
  }
  return { ok_count: succeeded.length, fail_count: failed.length, succeeded, failed };
}

export function bulkApprove(ids: number[], user_id = 1): BulkResult {
  return runBulk(ids, (id, u) => approve(id, u), user_id);
}

export function bulkVoid(ids: number[], user_id = 1): BulkResult {
  return runBulk(ids, (id, u) => voidDoc(id, u), user_id);
}

/** Build a CSV of the selected documents (a summary line per document). */
export function exportSelectionCsv(ids: number[]) {
  const db = getDb();
  if (!ids?.length) throw new Error('Select at least one document to export');
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT i.invoice_number, i.type, i.status, i.date, i.due_date, i.reference,
            c.name AS contact, i.currency_code, i.subtotal, i.total_tax, i.total, i.amount_due
       FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
      WHERE i.id IN (${placeholders}) ORDER BY i.date, i.invoice_number`
  ).all(...ids) as any[];
  const DOC_LABEL: Record<string, string> = { ACCREC: 'Invoice', ACCPAY: 'Bill', ACCRECCREDIT: 'Credit note', ACCPAYCREDIT: 'Supplier credit' };
  const money = (c: number) => (c / 100).toFixed(2);
  const header = ['Number', 'Type', 'Status', 'Date', 'Due date', 'Reference', 'Contact', 'Currency', 'Subtotal', 'Tax', 'Total', 'Amount due'];
  const csvRows = rows.map((r) => [
    r.invoice_number, DOC_LABEL[r.type] ?? r.type, r.status, r.date, r.due_date ?? '', r.reference ?? '',
    r.contact ?? '', r.currency_code ?? '', money(r.subtotal ?? 0), money(r.total_tax ?? 0), money(r.total ?? 0), money(r.amount_due ?? 0),
  ]);
  const esc = (v: any) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const csv = [header, ...csvRows].map((row) => row.map(esc).join(',')).join('\n');
  return { filename: `documents-${new Date().toISOString().slice(0, 10)}.csv`, csv, count: rows.length };
}

/**
 * Edit an approved document, Xero-style: the original journals are reversed
 * (dated today, lock-date aware), the document returns to DRAFT keeping its
 * number, and re-approving posts fresh journals. Blocked once any money or
 * credit has been applied.
 */
export function revertToDraft(id: number, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const inv = get(id);
    if (!inv) throw new Error('Document not found');
    if (inv.status === 'PAID' || inv.amount_paid > 0)
      throw new Error('Payments or credits have been applied — remove them first, or raise a credit note');
    if (inv.status !== 'AUTHORISED') throw new Error(`Only approved documents can be edited (status: ${inv.status})`);
    const creditApplied = db
      .prepare('SELECT COUNT(*) AS n FROM credit_allocations WHERE target_invoice_id = ? OR credit_invoice_id = ?')
      .get(id, id);
    if (creditApplied.n > 0) throw new Error('A credit has been allocated against this document — remove the allocation first');
    reverseApprovedPostings(inv, user_id);
    db.prepare("UPDATE invoices SET status='DRAFT', amount_due=total, amount_paid=0, updated_at=datetime('now') WHERE id = ?").run(id);
    { const pcs = projectCostSource(inv.type); if (pcs) removeProjectCostsForDoc(db, pcs.source_type, id); }
    audit('invoice', id, 'REVERT_TO_DRAFT', { status: 'AUTHORISED' }, { status: 'DRAFT' }, user_id);
    return get(id);
  });
}

/** Copy a document into a fresh DRAFT dated today — same contact and lines. */
export function copy(id: number, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const src = get(id);
    if (!src) throw new Error('Document not found');
    const offset = src.due_date ? Math.max(0, Math.round((Date.parse(src.due_date) - Date.parse(src.date)) / 86400000)) : 14;
    const date = today();
    const due = new Date(Date.parse(date) + offset * 86400000).toISOString().slice(0, 10);
    const draft = saveDraft(
      {
        type: src.type,
        contact_id: src.contact_id,
        date,
        due_date: due,
        reference: src.reference ?? undefined,
        currency_code: src.currency_code ?? undefined,
        exchange_rate: undefined, // resolved fresh for the copy's date by saveDraft
        line_amount_type: src.line_amount_type,
        lines: src.lines.map((l: any) => ({
          item_id: l.item_id ?? null,
          description: l.description,
          quantity: l.quantity,
          unit_amount: l.unit_amount,
          discount_percent: l.discount_percent ?? 0,
          account_id: l.account_id,
          tax_rate_id: l.tax_rate_id,
          tracking_option_1: l.tracking_option_1 ?? null,
          tracking_option_2: l.tracking_option_2 ?? null,
        })),
      },
      user_id
    );
    audit('invoice', draft.id, 'COPIED_FROM', null, { source_id: id, source_number: src.invoice_number }, user_id);
    return draft;
  });
}

/** Recompute paid/due from allocations; flip status PAID ⇄ AUTHORISED. */
export function refreshPaidStatus(id: number) {
  const db = getDb();
  const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(id);
  if (!inv) return;
  const paid =
    (db.prepare(`SELECT COALESCE(SUM(pa.amount),0) AS s FROM payment_allocations pa JOIN payments p ON p.id=pa.payment_id AND p.status='POSTED' WHERE pa.invoice_id = ?`).get(id).s ?? 0) +
    (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM credit_allocations WHERE target_invoice_id = ?`).get(id).s ?? 0) +
    (db.prepare(`SELECT COALESCE(SUM(amount),0) AS s FROM credit_allocations WHERE credit_invoice_id = ?`).get(id).s ?? 0);
  const due = inv.total - paid;
  const status = inv.status === 'VOIDED' || inv.status === 'DELETED' ? inv.status : due <= 0 && inv.total > 0 ? 'PAID' : inv.status === 'PAID' && due > 0 ? 'AUTHORISED' : inv.status;
  db.prepare(`UPDATE invoices SET amount_paid=?, amount_due=?, status=?, fully_paid_at=CASE WHEN ?<=0 THEN datetime('now') ELSE NULL END WHERE id=?`)
    .run(paid, due, status, due, id);
}

/** Allocate a credit note to an invoice/bill of the same side (spec §5.5). */
export function allocateCredit(creditId: number, targetId: number, amount: number, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const credit = db.prepare('SELECT * FROM invoices WHERE id = ?').get(creditId);
    const target = db.prepare('SELECT * FROM invoices WHERE id = ?').get(targetId);
    if (!credit || !target) throw new Error('Document not found');
    const pairs: Record<string, string> = { ACCRECCREDIT: 'ACCREC', ACCPAYCREDIT: 'ACCPAY' };
    if (pairs[credit.type] !== target.type) throw new Error('Credit note and invoice types do not match');
    // Both documents must be in the same currency. Allocating across currencies
    // would net different units against each other with no FX entry, so the
    // base-currency AR/AP control would stop reconciling to the sub-ledger.
    if ((credit.currency_code ?? baseCurrency()) !== (target.currency_code ?? baseCurrency())) {
      throw new Error('Credit note and invoice must be in the same currency');
    }
    if (credit.status !== 'AUTHORISED' && credit.status !== 'PAID') throw new Error('Credit note must be approved first');
    if (amount <= 0 || amount > credit.amount_due || amount > target.amount_due) {
      throw new PostingError('Allocation exceeds the remaining amount');
    }
    db.prepare('INSERT INTO credit_allocations (credit_invoice_id, target_invoice_id, date, amount) VALUES (?,?,?,?)')
      .run(creditId, targetId, today(), amount);
    // No GL impact: AR/AP already carries both documents; allocation just nets them.
    refreshPaidStatus(creditId);
    refreshPaidStatus(targetId);
    audit('invoice', targetId, 'CREDIT_ALLOCATED', null, { creditId, amount }, user_id);
  });
}

// ── Quotes ─────────────────────────────────────────────────────────────────

export function saveQuote(input: any, user_id = 1) {
  const db = getDb();
  const totals = computeTotals({ ...input, type: 'ACCREC' });
  return db.transaction(() => {
    let id = input.id;
    if (id) {
      db.prepare(`UPDATE quotes SET contact_id=?, title=?, date=?, expiry_date=?, line_amount_type=?, subtotal=?, total_tax=?, total=? WHERE id=?`)
        .run(input.contact_id, input.title ?? null, input.date, input.expiry_date ?? null, input.line_amount_type ?? 'EXCLUSIVE', totals.subtotal, totals.total_tax, totals.total, id);
      db.prepare('DELETE FROM quote_lines WHERE quote_id = ?').run(id);
    } else {
      id = Number(db.prepare(`INSERT INTO quotes (quote_number, contact_id, title, date, expiry_date, line_amount_type, status, subtotal, total_tax, total)
        VALUES (?,?,?,?,?,?, 'DRAFT', ?,?,?)`)
        .run(nextNumber('QUOTE'), input.contact_id, input.title ?? null, input.date, input.expiry_date ?? null, input.line_amount_type ?? 'EXCLUSIVE', totals.subtotal, totals.total_tax, totals.total).lastInsertRowid);
    }
    const ins = db.prepare(`INSERT INTO quote_lines (quote_id, line_order, item_id, description, quantity, unit_amount, discount_percent, account_id, tax_rate_id, line_amount) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    input.lines.forEach((l: any, i: number) =>
      ins.run(id, i, l.item_id ?? null, l.description, l.quantity, l.unit_amount, l.discount_percent ?? 0, l.account_id ?? null, l.tax_rate_id ?? null, totals.lines[i].net));
    audit('quote', id, input.id ? 'UPDATE' : 'CREATE', null, null, user_id);
    return getQuote(id);
  });
}

export function getQuote(id: number) {
  const db = getDb();
  const q = db.prepare('SELECT q.*, c.name AS contact_name FROM quotes q JOIN contacts c ON c.id=q.contact_id WHERE q.id = ?').get(id);
  if (q) q.lines = db.prepare('SELECT * FROM quote_lines WHERE quote_id = ? ORDER BY line_order').all(id);
  return q;
}

export function listQuotes(status?: string) {
  const db = getDb();
  return db.prepare(`SELECT q.*, c.name AS contact_name FROM quotes q JOIN contacts c ON c.id=q.contact_id ${status && status !== 'ALL' ? 'WHERE q.status = ?' : ''} ORDER BY q.date DESC`).all(...(status && status !== 'ALL' ? [status] : []));
}

export function setQuoteStatus(id: number, status: string, user_id = 1) {
  if (!['DRAFT', 'SENT', 'ACCEPTED', 'DECLINED', 'EXPIRED'].includes(status)) throw new Error('Bad quote status');
  getDb().prepare('UPDATE quotes SET status = ? WHERE id = ?').run(status, id);
  audit('quote', id, status, null, null, user_id);
}

/** One-click: accepted quote → draft invoice (spec §5.4). */
export function quoteToInvoice(id: number, user_id = 1) {
  const q = getQuote(id);
  if (!q) throw new Error('Quote not found');
  const inv = saveDraft({
    type: 'ACCREC', contact_id: q.contact_id, date: today(),
    line_amount_type: q.line_amount_type,
    lines: q.lines.map((l: any) => ({
      item_id: l.item_id, description: l.description, quantity: l.quantity,
      unit_amount: l.unit_amount, discount_percent: l.discount_percent,
      account_id: l.account_id, tax_rate_id: l.tax_rate_id,
    })),
  }, user_id);
  getDb().prepare("UPDATE quotes SET status='INVOICED' WHERE id = ?").run(id);
  return inv;
}

/**
 * Progress invoicing — how much of a quote has been invoiced so far via linked
 * invoices, and what's left. Voided/deleted invoices don't count.
 */
export function quoteProgress(quote_id: number) {
  const db = getDb();
  const q = getQuote(quote_id);
  if (!q) throw new Error('Quote not found');
  const invoices = db.prepare(
    `SELECT id, invoice_number, status, total, amount_due, progress_pct, date
       FROM invoices WHERE from_quote_id = ? AND status NOT IN ('VOIDED','DELETED')
      ORDER BY date, id`
  ).all(quote_id) as any[];
  const total = (q.total as number) || 0;
  const invoiced = invoices.reduce((s, i) => s + (i.total as number), 0);
  const remaining = total - invoiced;
  return {
    quote_id,
    quote_number: q.quote_number,
    contact_id: q.contact_id,
    status: q.status,
    total,
    invoiced,
    remaining,
    invoiced_pct: total ? Math.round((invoiced / total) * 10000) / 100 : 0,
    remaining_pct: total ? Math.round((remaining / total) * 10000) / 100 : 0,
    invoices,
  };
}

/**
 * Create a draft invoice billing a portion of a quote — either a `percent` of
 * the whole quote or a flat `amount`. Each quote line is scaled proportionally
 * (so the right accounts, tax and tracking are used), the invoice is linked to
 * the quote, and invoicing more than the quote total is refused.
 */
export function invoiceQuoteProgress(
  input: { quote_id: number; percent?: number; amount?: number; date?: string; due_date?: string },
  user_id = 1
) {
  const db = getDb();
  const q = getQuote(input.quote_id);
  if (!q) throw new Error('Quote not found');
  const total = (q.total as number) || 0;
  if (total <= 0) throw new Error('This quote has no value to invoice');
  const prog = quoteProgress(input.quote_id);

  let fraction: number;
  if (input.amount != null) fraction = input.amount / total;
  else if (input.percent != null) fraction = input.percent / 100;
  else throw new Error('Provide a percentage or an amount to invoice');
  if (!(fraction > 0)) throw new Error('The amount to invoice must be greater than zero');

  const lines = (q.lines as any[])
    .map((l) => ({
      account_id: l.account_id,
      tax_rate_id: l.tax_rate_id,
      tracking_option_1: l.tracking_option_1 ?? null,
      tracking_option_2: l.tracking_option_2 ?? null,
      description: `${l.description ?? 'Progress'} (${Math.round(fraction * 10000) / 100}% of ${q.quote_number || 'quote'})`,
      quantity: 1,
      unit_amount: Math.round((l.line_amount ?? 0) * fraction),
      discount_percent: 0,
    }))
    .filter((l) => l.unit_amount !== 0);
  if (lines.length === 0) throw new Error('That percentage rounds to nothing to invoice');

  const draft = { type: 'ACCREC' as const, contact_id: q.contact_id, date: input.date ?? today(), due_date: input.due_date, line_amount_type: q.line_amount_type, lines };
  const totals = computeTotals(draft as any);
  const tolerance = lines.length + 1; // absorb per-line rounding (cents)
  if (prog.invoiced + totals.total > total + tolerance) {
    throw new Error(`That would invoice more than the quote total — ${formatCents(prog.remaining)} remains to invoice.`);
  }

  return db.transaction(() => {
    const inv = saveDraft(draft as any, user_id);
    db.prepare('UPDATE invoices SET from_quote_id = ?, progress_pct = ? WHERE id = ?')
      .run(input.quote_id, Math.round(fraction * 10000) / 100, inv.id);
    // Mark the quote fully invoiced once the cumulative total reaches it.
    if (prog.invoiced + totals.total >= total - tolerance) {
      db.prepare("UPDATE quotes SET status = 'INVOICED' WHERE id = ?").run(input.quote_id);
    }
    return { invoice_id: inv.id, progress: quoteProgress(input.quote_id) };
  });
}

// ── Purchase orders ────────────────────────────────────────────────────────

export function savePO(input: any, user_id = 1) {
  const db = getDb();
  const totals = computeTotals({ ...input, type: 'ACCPAY' });
  return db.transaction(() => {
    let id = input.id;
    if (id) {
      db.prepare(`UPDATE purchase_orders SET contact_id=?, date=?, delivery_date=?, reference=?, line_amount_type=?, subtotal=?, total_tax=?, total=? WHERE id=?`)
        .run(input.contact_id, input.date, input.delivery_date ?? null, input.reference ?? null, input.line_amount_type ?? 'EXCLUSIVE', totals.subtotal, totals.total_tax, totals.total, id);
      db.prepare('DELETE FROM purchase_order_lines WHERE purchase_order_id = ?').run(id);
    } else {
      id = Number(db.prepare(`INSERT INTO purchase_orders (order_number, contact_id, date, delivery_date, reference, line_amount_type, status, subtotal, total_tax, total)
        VALUES (?,?,?,?,?,?,'DRAFT',?,?,?)`)
        .run(nextNumber('PO'), input.contact_id, input.date, input.delivery_date ?? null, input.reference ?? null, input.line_amount_type ?? 'EXCLUSIVE', totals.subtotal, totals.total_tax, totals.total).lastInsertRowid);
    }
    const ins = db.prepare(`INSERT INTO purchase_order_lines (purchase_order_id, line_order, item_id, description, quantity, unit_amount, discount_percent, account_id, tax_rate_id, line_amount) VALUES (?,?,?,?,?,?,?,?,?,?)`);
    input.lines.forEach((l: any, i: number) =>
      ins.run(id, i, l.item_id ?? null, l.description, l.quantity, l.unit_amount, l.discount_percent ?? 0, l.account_id ?? null, l.tax_rate_id ?? null, totals.lines[i].net));
    audit('purchase_order', id, input.id ? 'UPDATE' : 'CREATE', null, null, user_id);
    return getPO(id);
  });
}

export function getPO(id: number) {
  const db = getDb();
  const po: any = db.prepare(
    `SELECT p.*, c.name AS contact_name, c.email AS contact_email, c.phone AS contact_phone, c.tax_number AS contact_tax_number
       FROM purchase_orders p JOIN contacts c ON c.id=p.contact_id WHERE p.id = ?`
  ).get(id);
  if (po) {
    po.lines = db.prepare(
      `SELECT l.*, a.code AS account_code, a.name AS account_name
         FROM purchase_order_lines l LEFT JOIN accounts a ON a.id = l.account_id
        WHERE l.purchase_order_id = ? ORDER BY l.line_order`
    ).all(id);
    po.contact_address = db.prepare(
      `SELECT line1, line2, city, region, postcode, country FROM contact_addresses
        WHERE contact_id = ? ORDER BY (type = 'BILLING') DESC, id LIMIT 1`
    ).get(po.contact_id) ?? null;
  }
  return po;
}

export function listPOs(status?: string) {
  return getDb().prepare(`SELECT p.*, c.name AS contact_name FROM purchase_orders p JOIN contacts c ON c.id=p.contact_id ${status && status !== 'ALL' ? 'WHERE p.status = ?' : ''} ORDER BY p.date DESC`).all(...(status && status !== 'ALL' ? [status] : []));
}

export function setPOStatus(id: number, status: string, user_id = 1) {
  if (!['DRAFT', 'SUBMITTED', 'APPROVED'].includes(status)) throw new Error('Bad PO status');
  getDb().prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, id);
  audit('purchase_order', id, status, null, null, user_id);
}

export function poToBill(id: number, user_id = 1) {
  const po = getPO(id);
  if (!po) throw new Error('Purchase order not found');
  const bill = saveDraft({
    type: 'ACCPAY', contact_id: po.contact_id, date: today(), reference: po.order_number,
    line_amount_type: po.line_amount_type,
    lines: po.lines.map((l: any) => ({
      item_id: l.item_id, description: l.description, quantity: l.quantity,
      unit_amount: l.unit_amount, discount_percent: l.discount_percent,
      account_id: l.account_id, tax_rate_id: l.tax_rate_id,
    })),
  }, user_id);
  getDb().prepare("UPDATE purchase_orders SET status='BILLED' WHERE id = ?").run(id);
  return bill;
}

// ── Repeating invoices ─────────────────────────────────────────────────────

export function saveRepeating(input: any, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    let id = input.id;
    const vals = [input.type ?? 'ACCREC', input.contact_id, input.unit ?? 'MONTH', input.interval_n ?? 1,
      input.start_date, input.end_date ?? null, input.due_rule ?? null, input.save_as ?? 'DRAFT',
      input.reference ?? null, input.line_amount_type ?? 'EXCLUSIVE', input.next_run_date ?? input.start_date];
    if (id) {
      db.prepare(`UPDATE repeating_invoices SET type=?, contact_id=?, unit=?, interval_n=?, start_date=?, end_date=?, due_rule=?, save_as=?, reference=?, line_amount_type=?, next_run_date=? WHERE id=?`).run(...vals, id);
      db.prepare('DELETE FROM repeating_invoice_lines WHERE repeating_invoice_id = ?').run(id);
    } else {
      id = Number(db.prepare(`INSERT INTO repeating_invoices (type, contact_id, unit, interval_n, start_date, end_date, due_rule, save_as, reference, line_amount_type, next_run_date) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(...vals).lastInsertRowid);
    }
    const ins = db.prepare(`INSERT INTO repeating_invoice_lines (repeating_invoice_id, line_order, item_id, description, quantity, unit_amount, discount_percent, account_id, tax_rate_id) VALUES (?,?,?,?,?,?,?,?,?)`);
    input.lines.forEach((l: any, i: number) =>
      ins.run(id, i, l.item_id ?? null, l.description, l.quantity, l.unit_amount, l.discount_percent ?? 0, l.account_id, l.tax_rate_id ?? null));
    audit('repeating_invoice', id, 'SAVE', null, null, user_id);
    return id;
  });
}

export function listRepeating() {
  return getDb().prepare(`SELECT r.*, c.name AS contact_name FROM repeating_invoices r JOIN contacts c ON c.id=r.contact_id ORDER BY r.next_run_date`).all();
}

/** Scheduler: create invoices for every template whose next_run_date is due. Idempotent per day. */
export function runRepeatingDue(asOf = today(), user_id = 1): number[] {
  const db = getDb();
  const due = db.prepare(`SELECT * FROM repeating_invoices WHERE status='ACTIVE' AND next_run_date <= ? AND (end_date IS NULL OR next_run_date <= end_date)`).all(asOf);
  const created: number[] = [];
  for (const t of due) {
    let next = t.next_run_date;
    while (next <= asOf && (!t.end_date || next <= t.end_date)) {
      const lines = db.prepare('SELECT * FROM repeating_invoice_lines WHERE repeating_invoice_id = ? ORDER BY line_order').all(t.id);
      const inv = saveDraft({
        type: t.type, contact_id: t.contact_id, date: next,
        due_date: dueFromRule(next, t.due_rule), reference: t.reference,
        line_amount_type: t.line_amount_type,
        lines: lines.map((l: any) => ({
          item_id: l.item_id, description: l.description, quantity: l.quantity,
          unit_amount: l.unit_amount, discount_percent: l.discount_percent,
          account_id: l.account_id, tax_rate_id: l.tax_rate_id,
        })),
      }, user_id);
      if (t.save_as !== 'DRAFT') approve(inv.id, user_id);
      created.push(inv.id);
      next = advance(next, t.unit, t.interval_n);
    }
    db.prepare('UPDATE repeating_invoices SET next_run_date = ? WHERE id = ?').run(next, t.id);
  }
  return created;
}

function advance(date: string, unit: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  if (unit === 'DAY') d.setUTCDate(d.getUTCDate() + n);
  else if (unit === 'WEEK') d.setUTCDate(d.getUTCDate() + 7 * n);
  else d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
}

function dueFromRule(date: string, rule?: string | null): string {
  const m = /NET(\d+)/.exec(rule ?? 'NET14');
  const days = m ? parseInt(m[1], 10) : 14;
  return advance(date, 'DAY', days);
}

/** The single source of truth for how a document posts to the ledger —
 *  used by approve() and by recode's in-place journal rebuild. */
export function buildPostingLines(inv: any) {
  const isSale = inv.type === 'ACCREC' || inv.type === 'ACCRECCREDIT';
  const isCredit = inv.type.endsWith('CREDIT');
  const sign = isCredit ? -1 : 1; // credit notes post the mirror image
  const rate = inv.exchange_rate ?? 1;
  const control = systemAccount(isSale ? 'AR' : 'AP');
  const gst = systemAccount('GST');

  const lines: Parameters<typeof postJournal>[0]['lines'] = [];
  const totalBase = toBase(inv.total, rate);

  // Control account (gross)
  push(lines, control, sign * (isSale ? totalBase : -totalBase), `${inv.invoice_number} ${inv.contact_name}`, null, inv.contact_id);

  for (const l of inv.lines) {
    const netBase = toBase(l.line_amount, rate);
    const taxBase = toBase(l.tax_amount, rate);
    // Tracked-item purchases hit the inventory asset account instead of expense
    let lineAccount = l.account_id;
    if (!isSale && l.item_id) {
      const item = items.get(l.item_id);
      if (item?.is_tracked) lineAccount = item.inventory_asset_account_id;
    }
    // Revenue (Cr on sale) / Expense or Inventory (Dr on purchase)
    push(lines, lineAccount, sign * (isSale ? -netBase : netBase), l.description, l.tax_rate_id, inv.contact_id, l.tracking_option_1, l.tracking_option_2);
    if (taxBase !== 0) {
      // Output tax → credit liability; input tax → debit (recoverable)
      push(lines, gst, sign * (isSale ? -taxBase : taxBase), `${taxRateType(l.tax_rate_id)} tax`, l.tax_rate_id, inv.contact_id);
    }
  }

  // Foreign-currency rounding residual: converting each line independently and
  // converting the document total can differ by a cent or two (rounding each
  // line then summing ≠ rounding the sum). Post the difference to the Rounding
  // account so the journal always balances, at any exchange rate. For base-
  // currency documents the lines tie to the total exactly, so this is a no-op.
  const imbalance = lines.reduce((s, l) => s + (l.debit ?? 0) - (l.credit ?? 0), 0);
  if (imbalance !== 0) {
    push(lines, systemAccount('ROUNDING'), -imbalance, 'Foreign exchange rounding');
  }

  return { lines, narration: `${docLabel(inv.type)} ${inv.invoice_number} — ${inv.contact_name}` };
}

/** Recompute per-line amounts and document totals from the stored lines
 *  (used after a tax-rate recode). Refuses to leave amount_due negative. */
export function recomputeStoredTotals(id: number) {
  const db = getDb();
  const inv = get(id);
  const totals = computeTotals({
    type: inv.type,
    contact_id: inv.contact_id,
    date: inv.date,
    line_amount_type: inv.line_amount_type,
    lines: inv.lines.map((l: any) => ({
      description: l.description, quantity: l.quantity, unit_amount: l.unit_amount,
      discount_percent: l.discount_percent, account_id: l.account_id, tax_rate_id: l.tax_rate_id,
    })),
  } as DocInput);
  inv.lines.forEach((l: any, i: number) => {
    db.prepare('UPDATE invoice_lines SET line_amount = ?, tax_amount = ? WHERE id = ?')
      .run(totals.lines[i].net, totals.lines[i].tax, l.id);
  });
  const amountDue = totals.total - (inv.amount_paid ?? 0);
  if (amountDue < 0) throw new Error('recomputed total is below what was already paid');
  db.prepare('UPDATE invoices SET subtotal = ?, total_tax = ?, total = ?, amount_due = ? WHERE id = ?')
    .run(totals.subtotal, totals.total_tax, totals.total, amountDue, id);
}

/** Rebuild the document's main posted journal IN PLACE: same journal id,
 *  number and date — only the lines and narration are regenerated. */
export function rebuildMainJournal(id: number) {
  const db = getDb();
  const inv = get(id);
  if (!['AUTHORISED', 'PAID'].includes(inv.status)) throw new Error(`cannot rebuild a ${inv.status} document's journal`);
  const main = db.prepare(
    `SELECT * FROM journals WHERE source_type = 'INVOICE' AND source_id = ? AND status = 'POSTED'
     AND narration NOT LIKE 'COGS %' AND narration NOT LIKE 'Reversal%' ORDER BY id LIMIT 1`
  ).get(id);
  if (!main) throw new Error('posted journal not found for this document');
  const { lines, narration } = buildPostingLines(inv);
  let dr = 0; let cr = 0;
  for (const l of lines) { dr += l.debit ?? 0; cr += l.credit ?? 0; }
  if (dr !== cr) throw new Error(`rebuild would unbalance the journal (${dr} vs ${cr})`);
  db.prepare('DELETE FROM journal_lines WHERE journal_id = ?').run(main.id);
  const ins = db.prepare(
    `INSERT INTO journal_lines (journal_id, account_id, description, debit, credit, tax_rate_id, contact_id, tracking_option_1, tracking_option_2)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const l of lines) {
    ins.run(main.id, l.account_id, l.description ?? null, l.debit ?? 0, l.credit ?? 0,
      l.tax_rate_id ?? null, l.contact_id ?? null, l.tracking_option_1 ?? null, l.tracking_option_2 ?? null);
  }
  db.prepare('UPDATE journals SET narration = ? WHERE id = ?').run(narration, main.id);
}
