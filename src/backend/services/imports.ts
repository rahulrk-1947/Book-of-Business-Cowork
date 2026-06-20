/**
 * Bulk CSV import for documents (invoices, bills, credit notes) and manual
 * journals. Imports always land as DRAFTS so nothing touches the ledger
 * until a human reviews and approves — a deliberate safety choice.
 *
 * Document CSV columns (header row required, order free):
 *   ContactName*, Number*, Date*, DueDate, Reference, Description*,
 *   Quantity, UnitAmount*, AccountCode*, TaxRate, Tracking1, Tracking2
 * Rows sharing the same Number become lines of one document.
 *
 * Journal CSV columns:
 *   Narration*, Date*, Description, AccountCode*, Debit, Credit,
 *   Tracking1, Tracking2
 * Rows sharing the same Narration + Date become one journal; each journal
 * must balance.
 */
import { getDb } from '../db';
import * as contacts from './contacts';
import * as invoices from './invoices';
import * as journals from './journals';

type Row = Record<string, string>;

/** Small, strict CSV parser: quotes, escaped quotes, CRLF. */
export function parseCsvTable(text: string): { headers: string[]; rows: Row[] } {
  const out: string[][] = [];
  let cur: string[] = [];
  let field = '';
  let inQ = false;
  const pushField = () => { cur.push(field); field = ''; };
  const pushRow = () => { if (cur.length > 1 || cur[0]?.trim()) out.push(cur); cur = []; };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') pushField();
    else if (ch === '\n') { pushField(); pushRow(); }
    else if (ch === '\r') { /* swallow */ }
    else field += ch;
  }
  pushField();
  pushRow();
  if (!out.length) return { headers: [], rows: [] };
  const headers = out[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  const rows = out.slice(1).map((cells) => {
    const r: Row = {};
    headers.forEach((h, i) => { r[h] = (cells[i] ?? '').trim(); });
    return r;
  });
  return { headers, rows };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function lookups() {
  const db = getDb();
  const accounts = new Map<string, any>();
  for (const a of db.prepare("SELECT id, code, name, is_bank_account FROM accounts WHERE status = 'ACTIVE'").all()) {
    accounts.set(String(a.code).toLowerCase(), a);
  }
  const taxByName = new Map<string, number>();
  for (const t of db.prepare("SELECT id, name FROM tax_rates WHERE status = 'ACTIVE'").all()) {
    taxByName.set(String(t.name).toLowerCase(), t.id);
  }
  const trackingByName = new Map<string, { id: number; cat: number }>();
  for (const o of db
    .prepare(`SELECT o.id, o.name, o.category_id FROM tracking_options o
              JOIN tracking_categories c ON c.id = o.category_id
              WHERE o.status = 'ACTIVE' AND c.status = 'ACTIVE'`)
    .all()) {
    trackingByName.set(String(o.name).toLowerCase(), { id: o.id, cat: o.category_id });
  }
  const contactByName = new Map<string, number>();
  for (const c of db.prepare("SELECT id, name FROM contacts WHERE status = 'ACTIVE'").all()) {
    contactByName.set(String(c.name).trim().toLowerCase(), c.id);
  }
  return { accounts, taxByName, trackingByName, contactByName };
}

function toCents(v: string, what: string, line: number): number {
  const n = Number(String(v).replace(/[, ]/g, ''));
  if (!isFinite(n)) throw new Error(`Line ${line}: ${what} "${v}" is not a number`);
  return Math.round(n * 100);
}

function resolveTracking(L: ReturnType<typeof lookups>, r: Row, line: number) {
  const pick = (v: string) => {
    if (!v) return null;
    const hit = L.trackingByName.get(v.toLowerCase());
    if (!hit) throw new Error(`Line ${line}: tracking option "${v}" doesn't exist (Settings → Tracking)`);
    return hit.id;
  };
  return { t1: pick(r.tracking1 ?? ''), t2: pick(r.tracking2 ?? '') };
}

export function importDocuments(params: { type: 'ACCREC' | 'ACCPAY' | 'ACCRECCREDIT' | 'ACCPAYCREDIT'; csv: string; dry_run?: boolean }, user_id = 1) {
  const { rows } = parseCsvTable(params.csv);
  if (!rows.length) throw new Error('The file has no data rows');
  const L = lookups();
  const groups = new Map<string, { rows: Array<{ r: Row; line: number }> }>();
  rows.forEach((r, i) => {
    const num = r.number || r.invoicenumber || r.billnumber || r.creditnumber || '';
    if (!num) throw new Error(`Line ${i + 2}: Number is required — rows with the same Number become one document`);
    if (!groups.has(num)) groups.set(num, { rows: [] });
    groups.get(num)!.rows.push({ r, line: i + 2 });
  });

  const created: Array<{ id: number; number: string; lines: number }> = [];
  const errors: Array<{ doc: string; message: string }> = [];
  let contactsCreated = 0;

  for (const [num, g] of groups) {
    try {
      const first = g.rows[0].r;
      const fl = g.rows[0].line;
      const name = first.contactname || first.contact;
      if (!name) throw new Error(`Line ${fl}: ContactName is required`);
      let contactId: number | undefined = L.contactByName.get(name.trim().toLowerCase());
      if (!contactId) {
        if (params.dry_run) {
          contactsCreated++;
          contactId = -1; // placeholder: would be created on the real run
        } else {
          const isSale = params.type.startsWith('ACCREC');
          contactId = contacts.save({ name, is_customer: isSale, is_supplier: !isSale }, user_id).id as number;
          L.contactByName.set(name.trim().toLowerCase(), contactId);
          contactsCreated++;
        }
      }
      const cid = contactId as number;
      if (!DATE_RE.test(first.date ?? '')) throw new Error(`Line ${fl}: Date must be YYYY-MM-DD`);
      if (first.duedate && !DATE_RE.test(first.duedate)) throw new Error(`Line ${fl}: DueDate must be YYYY-MM-DD`);

      const lines = g.rows.map(({ r, line }) => {
        const code = (r.accountcode || r.account || '').toLowerCase();
        const acct = L.accounts.get(code);
        if (!acct) throw new Error(`Line ${line}: account code "${r.accountcode}" not found`);
        if (acct.is_bank_account) throw new Error(`Line ${line}: documents can't post straight to a bank account`);
        let tax: number | null = null;
        if (r.taxrate) {
          tax = L.taxByName.get(r.taxrate.toLowerCase()) ?? null;
          if (tax == null) throw new Error(`Line ${line}: tax rate "${r.taxrate}" not found (use the exact name from Settings)`);
        }
        const { t1, t2 } = resolveTracking(L, r, line);
        return {
          description: r.description || '(imported)',
          quantity: r.quantity ? Number(r.quantity) : 1,
          unit_amount: toCents(r.unitamount || r.amount || '', 'UnitAmount', line),
          account_id: acct.id,
          tax_rate_id: tax,
          tracking_option_1: t1,
          tracking_option_2: t2,
        };
      });

      if (params.dry_run) {
        created.push({ id: 0, number: num, lines: lines.length });
      } else {
        const draft = invoices.saveDraft(
          {
            type: params.type,
            contact_id: cid,
            invoice_number: num,
            date: first.date,
            due_date: first.duedate || undefined,
            reference: first.reference || undefined,
            lines,
          },
          user_id
        );
        created.push({ id: draft.id, number: num, lines: lines.length });
      }
    } catch (e: any) {
      errors.push({ doc: num, message: e.message });
    }
  }
  return { created, errors, contacts_created: contactsCreated, total_documents: groups.size };
}

export function importJournals(params: { csv: string; dry_run?: boolean }, user_id = 1) {
  const { rows } = parseCsvTable(params.csv);
  if (!rows.length) throw new Error('The file has no data rows');
  const L = lookups();
  const groups = new Map<string, Array<{ r: Row; line: number }>>();
  rows.forEach((r, i) => {
    const narration = r.narration || r.description0 || '';
    if (!narration) throw new Error(`Line ${i + 2}: Narration is required — rows with the same Narration + Date become one journal`);
    if (!DATE_RE.test(r.date ?? '')) throw new Error(`Line ${i + 2}: Date must be YYYY-MM-DD`);
    const key = `${narration}@@${r.date}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push({ r, line: i + 2 });
  });

  const created: Array<{ id: number; narration: string; lines: number }> = [];
  const errors: Array<{ doc: string; message: string }> = [];

  for (const [key, g] of groups) {
    const [narration, date] = key.split('@@');
    try {
      let dr = 0;
      let cr = 0;
      const lines = g.map(({ r, line }) => {
        const acct = L.accounts.get((r.accountcode || r.account || '').toLowerCase());
        if (!acct) throw new Error(`Line ${line}: account code "${r.accountcode}" not found`);
        const debit = r.debit ? toCents(r.debit, 'Debit', line) : 0;
        const credit = r.credit ? toCents(r.credit, 'Credit', line) : 0;
        if ((debit > 0) === (credit > 0)) throw new Error(`Line ${line}: each row needs a Debit or a Credit (not both, not neither)`);
        dr += debit;
        cr += credit;
        const { t1, t2 } = resolveTracking(L, r, line);
        return { description: r.description || undefined, account_id: acct.id, debit, credit, tracking_option_1: t1, tracking_option_2: t2 };
      });
      if (dr !== cr) throw new Error(`Journal "${narration}" doesn't balance: debits ${(dr / 100).toFixed(2)} vs credits ${(cr / 100).toFixed(2)}`);
      const id = params.dry_run ? 0 : journals.saveDraft({ narration, date, lines }, user_id);
      created.push({ id, narration, lines: lines.length });
    } catch (e: any) {
      errors.push({ doc: narration, message: e.message });
    }
  }
  return { created, errors, total_documents: groups.size };
}

export function documentTemplate(type: string) {
  const db = getDb();
  const sale = type.startsWith('ACCREC');
  const tax = db.prepare("SELECT name FROM tax_rates WHERE status='ACTIVE' AND name LIKE ? LIMIT 1").get(sale ? '%Sales%' : '%Purchase%')?.name
    ?? db.prepare("SELECT name FROM tax_rates WHERE status='ACTIVE' LIMIT 1").get()?.name ?? 'No Tax';
  const acct = db.prepare("SELECT code FROM accounts WHERE status='ACTIVE' AND type = ? AND is_bank_account = 0 LIMIT 1").get(sale ? 'REVENUE' : 'EXPENSE')?.code ?? (sale ? '200' : '310');
  const trk = db.prepare("SELECT o.name FROM tracking_options o JOIN tracking_categories c ON c.id=o.category_id WHERE o.status='ACTIVE' AND c.status='ACTIVE' LIMIT 1").get()?.name ?? '';
  const num = sale ? 'INV-1001' : 'BILL-2001';
  const who = sale ? 'Harbourview Hotels' : 'Meridian Logistics';
  return [
    'ContactName,Number,Date,DueDate,Reference,Description,Quantity,UnitAmount,AccountCode,TaxRate,Tracking1,Tracking2',
    `${who},${num},2026-06-01,2026-06-15,REF-1,Consulting day,1,1500.00,${acct},${tax},${trk},`,
    `${who},${num},2026-06-01,2026-06-15,REF-1,Travel,2,80.00,${acct},${tax},${trk},`,
  ].join('\n');
}

export function journalTemplate() {
  return [
    'Narration,Date,Description,AccountCode,Debit,Credit,Tracking1,Tracking2',
    'Monthly accrual,2026-06-30,Facilitation fees,310,380.00,,South,Workshop',
    'Monthly accrual,2026-06-30,Accrued expenses,825,,380.00,,',
  ].join('\n');
}
