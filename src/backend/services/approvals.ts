/**
 * Approval workflows for invoices and bills.
 *
 * Rules say when sign-off is needed (e.g. "bills of $5,000 or more"). A document
 * that needs approval must be SUBMITTED, then approved before it can be posted —
 * enforced in `invoices.approve` (which blocks posting unless an APPROVED record
 * exists). Approving here records who/when, then posts via the normal path;
 * rejecting sends it back to draft. With no rules configured, nothing changes.
 */
import { getDb } from '../db';
import * as invoices from './invoices';

const labelFor = (t: string) => (t === 'ACCPAY' ? 'bill' : 'invoice');

// ── Rules ─────────────────────────────────────────────────────────────────
export function listRules() {
  return getDb().prepare('SELECT * FROM approval_rules ORDER BY doc_type, min_amount').all();
}

export function saveRule(input: any) {
  const db = getDb();
  const doc_type = input.doc_type === 'ACCPAY' ? 'ACCPAY' : 'ACCREC';
  const min_amount = Math.max(0, Math.round(Number(input.min_amount ?? 0)));
  const enabled = input.enabled === false ? 0 : 1;
  if (input.id) {
    db.prepare('UPDATE approval_rules SET doc_type=?, min_amount=?, enabled=? WHERE id=?').run(doc_type, min_amount, enabled, input.id);
    return db.prepare('SELECT * FROM approval_rules WHERE id=?').get(input.id);
  }
  const id = Number(db.prepare('INSERT INTO approval_rules (doc_type, min_amount, enabled) VALUES (?,?,?)').run(doc_type, min_amount, enabled).lastInsertRowid);
  return db.prepare('SELECT * FROM approval_rules WHERE id=?').get(id);
}

export function setRuleEnabled(id: number, enabled: boolean) {
  getDb().prepare('UPDATE approval_rules SET enabled=? WHERE id=?').run(enabled ? 1 : 0, id);
}

export function removeRule(id: number) {
  getDb().prepare('DELETE FROM approval_rules WHERE id=?').run(id);
}

/** Does a document of this type and total require approval under current rules? */
export function requiresApproval(doc_type: string, total: number): boolean {
  if (doc_type !== 'ACCREC' && doc_type !== 'ACCPAY') return false;
  return !!getDb().prepare('SELECT 1 FROM approval_rules WHERE enabled=1 AND doc_type=? AND min_amount<=? LIMIT 1').get(doc_type, total);
}

// ── Requests & decisions ────────────────────────────────────────────────────
export function approvalFor(doc_type: string, doc_id: number): any {
  return getDb().prepare('SELECT * FROM approvals WHERE doc_type=? AND doc_id=? ORDER BY id DESC LIMIT 1').get(doc_type, doc_id) ?? null;
}

/** Approval context for a document, used by the editor to decide which buttons to show. */
export function state(doc_id: number) {
  const doc = getDb().prepare('SELECT id, type, total, status FROM invoices WHERE id=?').get(doc_id) as any;
  if (!doc) return { requires: false, approval: null, doc_status: null, doc_type: null };
  return { requires: requiresApproval(doc.type, doc.total), approval: approvalFor(doc.type, doc_id), doc_status: doc.status, doc_type: doc.type };
}

export function submit(doc_id: number, user_id = 1) {
  const db = getDb();
  const doc = db.prepare('SELECT id, type, total, status FROM invoices WHERE id=?').get(doc_id) as any;
  if (!doc) throw new Error('Document not found');
  if (doc.type !== 'ACCREC' && doc.type !== 'ACCPAY') throw new Error('Only invoices and bills use approvals.');
  if (doc.status !== 'DRAFT') throw new Error('Only drafts can be submitted for approval.');
  invoices.submit(doc_id, user_id); // → SUBMITTED (+ audit)
  db.prepare("INSERT INTO approvals (doc_type, doc_id, status, requested_by) VALUES (?,?, 'PENDING', ?)").run(doc.type, doc_id, user_id);
  return approvalFor(doc.type, doc_id);
}

export function listPending() {
  return getDb().prepare(
    `SELECT a.id, a.doc_type, a.doc_id, a.requested_at,
            i.invoice_number, i.total, i.date, i.currency_code, i.status AS doc_status,
            c.name AS contact_name
       FROM approvals a
       JOIN invoices i ON i.id = a.doc_id
       LEFT JOIN contacts c ON c.id = i.contact_id
      WHERE a.status='PENDING' AND i.status='SUBMITTED'
      ORDER BY a.requested_at, a.id`,
  ).all();
}

export function pendingCount(): number {
  return Number((getDb().prepare("SELECT COUNT(*) AS n FROM approvals a JOIN invoices i ON i.id=a.doc_id WHERE a.status='PENDING' AND i.status='SUBMITTED'").get() as any).n);
}

export function approve(doc_id: number, note?: string, user_id = 1) {
  const db = getDb();
  const doc = db.prepare('SELECT id, type FROM invoices WHERE id=?').get(doc_id) as any;
  if (!doc) throw new Error('Document not found');
  const ap = approvalFor(doc.type, doc_id);
  if (!ap || ap.status !== 'PENDING') throw new Error('There is no pending approval for this document.');
  // Mark approved first so the posting gate passes, then post via the normal path.
  db.prepare("UPDATE approvals SET status='APPROVED', decided_by=?, decided_at=datetime('now'), note=? WHERE id=?").run(user_id, note ?? null, ap.id);
  try {
    invoices.approve(doc_id, user_id);
  } catch (e) {
    db.prepare("UPDATE approvals SET status='PENDING', decided_by=NULL, decided_at=NULL WHERE id=?").run(ap.id);
    throw e;
  }
  return approvalFor(doc.type, doc_id);
}

export function reject(doc_id: number, note?: string, user_id = 1) {
  const db = getDb();
  const doc = db.prepare('SELECT id, type, status FROM invoices WHERE id=?').get(doc_id) as any;
  if (!doc) throw new Error('Document not found');
  const ap = approvalFor(doc.type, doc_id);
  if (!ap || ap.status !== 'PENDING') throw new Error('There is no pending approval for this document.');
  db.transaction(() => {
    db.prepare("UPDATE approvals SET status='REJECTED', decided_by=?, decided_at=datetime('now'), note=? WHERE id=?").run(user_id, note ?? null, ap.id);
    if (doc.status === 'SUBMITTED') db.prepare("UPDATE invoices SET status='DRAFT' WHERE id=?").run(doc_id);
  });
  return approvalFor(doc.type, doc_id);
}
