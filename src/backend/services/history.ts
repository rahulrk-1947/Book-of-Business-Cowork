/**
 * Change history for a single document. Reads the audit log (which records
 * every create / edit / approve / void / recode with a before & after snapshot)
 * and returns it newest-first with the acting user's name resolved, ready to
 * render as a timeline on the document.
 */
import { getDb } from '../db';

const ENTITY_FOR: Record<string, string> = {
  INVOICE: 'invoice',
  BANKTXN: 'bank_transaction',
  MANUAL: 'manual_journal',
  QUOTE: 'quote',
  PO: 'purchase_order',
};

const ACTION_LABEL: Record<string, string> = {
  CREATE: 'Created', CREATED: 'Created',
  EDITED: 'Edited', UPDATED: 'Edited', UPDATE: 'Edited',
  APPROVE: 'Approved', POSTED: 'Posted',
  SUBMIT: 'Submitted for approval', SENT: 'Marked as sent',
  VOID: 'Voided', VOIDED: 'Voided', DELETED: 'Deleted',
  REVERT_TO_DRAFT: 'Reopened as draft',
  COPIED_FROM: 'Copied from another document',
  CREDIT_ALLOCATED: 'Credit allocated',
  RECODE: 'Re-coded (Find & recode)',
};

export function forDocument(source: string, docId: number) {
  const db = getDb();
  const entity = ENTITY_FOR[source] ?? source.toLowerCase();
  const rows = db.prepare(
    `SELECT a.id, a.action, a.before_json, a.after_json, a.created_at, a.user_id, u.name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = ? AND a.entity_id = ?
      ORDER BY a.id ASC`
  ).all(entity, docId) as any[];

  // Also fold in recode events, which are logged against entity 'recode'
  // with the document id, so a re-code shows up in the document's own history.
  const recodes = db.prepare(
    `SELECT a.id, a.action, a.before_json, a.after_json, a.created_at, a.user_id, u.name AS user_name
       FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.entity_type = 'recode' AND a.entity_id = ?
      ORDER BY a.id ASC`
  ).all(docId) as any[];

  const all = [...rows, ...recodes].sort((x, y) => x.id - y.id).map((r) => ({
    id: r.id,
    action: r.action,
    label: ACTION_LABEL[r.action] ?? r.action,
    at: r.created_at,
    user: r.user_name ?? 'System',
    before: r.before_json ? JSON.parse(r.before_json) : null,
    after: r.after_json ? JSON.parse(r.after_json) : null,
  }));

  return { source, doc_id: docId, events: all.reverse() }; // newest first
}
