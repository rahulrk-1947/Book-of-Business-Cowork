/**
 * One search box for the whole app. Given a short query, look across the
 * things people actually hunt for — contacts, invoices/bills/credit notes,
 * accounts, and manual journals — and return a compact, grouped, ranked list
 * the UI can turn into "jump straight there" results.
 */
import { getDb } from '../db';

export type Hit = {
  type: 'contact' | 'document' | 'account' | 'journal';
  id: number;
  title: string;
  subtitle?: string;
  badge?: string;          // e.g. status or doc type label
  open: { kind: 'source'; source: string; id: number } | { kind: 'nav'; hash: string };
};

const DOC_LABEL: Record<string, string> = {
  ACCREC: 'Invoice', ACCPAY: 'Bill', ACCRECCREDIT: 'Credit note', ACCPAYCREDIT: 'Supplier credit',
};

export function global(query: string, limit = 8): { query: string; groups: Array<{ type: string; label: string; hits: Hit[] }> } {
  const db = getDb();
  const q = (query ?? '').trim();
  if (q.length < 1) return { query: q, groups: [] };
  const like = `%${q}%`;

  // Contacts ────────────────────────────────────────────────────────────────
  const contacts = db.prepare(
    `SELECT id, name, email, is_customer, is_supplier FROM contacts
      WHERE status = 'ACTIVE' AND (name LIKE ? OR email LIKE ?)
      ORDER BY (name = ?) DESC, (name LIKE ?) DESC, name LIMIT ?`
  ).all(like, like, q, `${q}%`, limit) as any[];

  // Documents (invoices / bills / credits) ────────────────────────────────────
  const docs = db.prepare(
    `SELECT i.id, i.type, i.invoice_number, i.reference, i.status, i.total, i.date, c.name AS contact_name
       FROM invoices i LEFT JOIN contacts c ON c.id = i.contact_id
      WHERE i.status != 'DELETED'
        AND (i.invoice_number LIKE ? OR i.reference LIKE ? OR c.name LIKE ?)
      ORDER BY (i.invoice_number = ?) DESC, i.date DESC LIMIT ?`
  ).all(like, like, like, q, limit) as any[];

  // Accounts ──────────────────────────────────────────────────────────────────
  const accounts = db.prepare(
    `SELECT id, code, name, type FROM accounts
      WHERE status = 'ACTIVE' AND (code LIKE ? OR name LIKE ?)
      ORDER BY (code = ?) DESC, code LIMIT ?`
  ).all(like, like, q, limit) as any[];

  // Manual journals ─────────────────────────────────────────────────────────
  const journals = db.prepare(
    `SELECT mj.id, mj.narration, mj.date, mj.status, j.journal_number
       FROM manual_journals mj LEFT JOIN journals j ON j.id = mj.journal_id
      WHERE mj.status != 'DELETED' AND (mj.narration LIKE ? OR j.journal_number LIKE ?)
      ORDER BY mj.date DESC LIMIT ?`
  ).all(like, like, limit) as any[];

  const money = (c: number) => (c / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const groups: Array<{ type: string; label: string; hits: Hit[] }> = [];
  if (contacts.length) groups.push({
    type: 'contact', label: 'Contacts',
    hits: contacts.map((c) => ({
      type: 'contact', id: c.id, title: c.name,
      subtitle: [c.email, c.is_customer ? 'Customer' : '', c.is_supplier ? 'Supplier' : ''].filter(Boolean).join(' · '),
      open: { kind: 'nav', hash: `contacts/${c.id}` },
    })),
  });
  if (docs.length) groups.push({
    type: 'document', label: 'Invoices, bills & credits',
    hits: docs.map((d) => ({
      type: 'document', id: d.id, title: `${d.invoice_number}${d.contact_name ? ' · ' + d.contact_name : ''}`,
      subtitle: `${money(d.total)}${d.reference ? ' · ' + d.reference : ''}`,
      badge: `${DOC_LABEL[d.type] ?? d.type} · ${String(d.status).toLowerCase()}`,
      open: { kind: 'source', source: 'INVOICE', id: d.id },
    })),
  });
  if (accounts.length) groups.push({
    type: 'account', label: 'Accounts',
    hits: accounts.map((a) => ({
      type: 'account', id: a.id, title: `${a.code} · ${a.name}`,
      subtitle: String(a.type).replace(/_/g, ' ').toLowerCase(),
      open: { kind: 'nav', hash: 'coa' },
    })),
  });
  if (journals.length) groups.push({
    type: 'journal', label: 'Manual journals',
    hits: journals.map((j) => ({
      type: 'journal', id: j.id, title: j.narration || `Journal ${j.journal_number ?? j.id}`,
      subtitle: j.journal_number ?? '',
      badge: String(j.status).toLowerCase(),
      open: { kind: 'source', source: 'MANUAL', id: j.id },
    })),
  });

  return { query: q, groups };
}
