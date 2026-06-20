/**
 * The core accounting engine. Every module — invoices, bills, payments, bank
 * transactions, depreciation, manual journals — ultimately calls postJournal().
 *
 * Invariants enforced here (and nowhere bypassable):
 *   1. Σdebits = Σcredits, to the cent, or the posting throws.
 *   2. Every line has a positive debit XOR credit.
 *   3. No posting into a locked period.
 *   4. Voiding posts a dated reversing journal; history is never destroyed.
 *   5. Every posting writes the audit log.
 */
import { getDb } from './db';
import * as session from './session';

export interface JournalLineInput {
  account_id: number;
  debit?: number; // cents
  credit?: number; // cents
  description?: string;
  tax_rate_id?: number | null;
  contact_id?: number | null;
  tracking_option_1?: number | null;
  tracking_option_2?: number | null;
}

export interface PostJournalInput {
  date: string; // YYYY-MM-DD
  narration?: string;
  source_type: string;
  source_id?: number | null;
  currency_code?: string;
  exchange_rate?: number;
  is_cash_basis?: boolean;
  lines: JournalLineInput[];
  user_id?: number;
  reverses_journal_id?: number;
  /** Optional dedupe key: a repeat post with the same key returns the original journal. */
  idempotency_key?: string;
}

export class PostingError extends Error {}

/**
 * Reject impossible or malformed dates (e.g. "02/30/275760", "2026-13-40",
 * blank). Accepts an ISO yyyy-mm-dd and verifies the calendar actually has
 * that day, with a sane year range so a typo'd year can't slip through.
 */
export function assertValidDate(date: string, field = 'Date'): void {
  const s = (date ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new PostingError(`${field} must be a real calendar date`);
  const y = +m[1]; const mo = +m[2]; const d = +m[3];
  if (y < 1900 || y > 2200) throw new PostingError(`${field} year ${y} is out of range`);
  if (mo < 1 || mo > 12) throw new PostingError(`${field} has an invalid month`);
  // Round-trip through Date to confirm the day exists in that month (catches
  // 30 Feb, 31 Apr, etc.).
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    throw new PostingError(`${field} is not a real calendar date`);
  }
}

export function assertDateUnlocked(date: string) {
  const db = getDb();
  const org = db.prepare('SELECT lock_date, adviser_lock_date FROM organisations WHERE id = 1').get();
  // Honour BOTH locks. lock_date is the "all users" barrier; adviser_lock_date
  // is the (often stricter) adviser-set barrier. The effective barrier is the
  // later of the two — anything on or before it is rejected for everyone.
  // (Previously adviser_lock_date was selected but never enforced, so the
  // adviser lock did nothing.)
  const effective = [org?.lock_date, org?.adviser_lock_date]
    .filter((d): d is string => !!d)
    .sort()
    .pop();
  if (effective && date <= effective) {
    throw new PostingError(`Period locked: cannot post on or before ${effective}`);
  }
}

export function postJournal(input: PostJournalInput): number {
  const db = getDb();
  if (!input.lines || input.lines.length < 2) {
    throw new PostingError('A journal needs at least two lines');
  }
  let dr = 0;
  let cr = 0;
  for (const l of input.lines) {
    const d = Math.trunc(l.debit ?? 0);
    const c = Math.trunc(l.credit ?? 0);
    if (d < 0 || c < 0) throw new PostingError('Debits/credits must be non-negative');
    if (d > 0 && c > 0) throw new PostingError('A line cannot be both debit and credit');
    if (d === 0 && c === 0) throw new PostingError('A line must have a debit or a credit');
    dr += d;
    cr += c;
  }
  if (dr !== cr) {
    throw new PostingError(`Unbalanced journal: debits ${dr} ≠ credits ${cr} (cents)`);
  }
  assertValidDate(input.date);
  assertDateUnlocked(input.date);

  return db.transaction(() => {
    // Accounting-level idempotency: if this exact post was already made under
    // the same key, return the original journal rather than posting again.
    if (input.idempotency_key) {
      const existing = db.prepare('SELECT id FROM journals WHERE idempotency_key = ?').get(input.idempotency_key) as { id: number } | undefined;
      if (existing) return existing.id;
    }
    const jid = Number(
      db
        .prepare(
          `INSERT INTO journals (journal_number, date, narration, source_type, source_id, status,
             currency_code, exchange_rate, is_cash_basis, reverses_journal_id, created_by, posted_at, idempotency_key)
           VALUES (?, ?, ?, ?, ?, 'POSTED', ?, ?, ?, ?, ?, datetime('now'), ?)`
        )
        .run(
          nextNumber('JOURNAL'),
          input.date,
          input.narration ?? null,
          input.source_type,
          input.source_id ?? null,
          input.currency_code ?? baseCurrency(),
          input.exchange_rate ?? 1,
          input.is_cash_basis ? 1 : 0,
          input.reverses_journal_id ?? null,
          input.user_id ?? session.currentUser(),
          input.idempotency_key ?? null
        ).lastInsertRowid
    );
    const ins = db.prepare(
      `INSERT INTO journal_lines (journal_id, account_id, description, debit, credit, tax_rate_id, contact_id, tracking_option_1, tracking_option_2)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of input.lines) {
      ins.run(
        jid,
        l.account_id,
        l.description ?? null,
        Math.trunc(l.debit ?? 0),
        Math.trunc(l.credit ?? 0),
        l.tax_rate_id ?? null,
        l.contact_id ?? null,
        l.tracking_option_1 ?? null,
        l.tracking_option_2 ?? null
      );
    }
    audit('journal', jid, 'POSTED', null, { source: input.source_type, source_id: input.source_id, dr }, input.user_id);
    return jid;
  });
}

/**
 * Post the exact mirror of a journal. Dated the original date, or — if that
 * period is now locked — the supplied fallback date (spec §2.4).
 */
export function reverseJournal(journalId: number, opts: { date?: string; narration?: string; user_id?: number } = {}): number {
  const db = getDb();
  const j = db.prepare('SELECT * FROM journals WHERE id = ?').get(journalId);
  if (!j) throw new PostingError(`Journal ${journalId} not found`);
  if (j.status !== 'POSTED') throw new PostingError(`Journal ${journalId} is not POSTED`);
  const lines = db.prepare('SELECT * FROM journal_lines WHERE journal_id = ?').all(journalId);

  let date = opts.date ?? j.date;
  let rescheduled = false;
  try {
    assertDateUnlocked(date);
  } catch {
    // The original date sits in a locked period. Reverse into today instead,
    // but record that we moved it so it isn't a silent change.
    date = today();
    rescheduled = true;
  }
  const baseNarration = opts.narration ?? `Reversal of ${j.journal_number ?? journalId}`;
  const narration = rescheduled
    ? `${baseNarration} (original date ${j.date} was in a locked period; reversed on ${date})`
    : baseNarration;
  return postJournal({
    date,
    narration,
    source_type: j.source_type,
    source_id: j.source_id,
    currency_code: j.currency_code,
    exchange_rate: j.exchange_rate,
    reverses_journal_id: journalId,
    user_id: opts.user_id,
    lines: lines.map((l: any) => ({
      account_id: l.account_id,
      debit: l.credit,
      credit: l.debit,
      description: l.description,
      tax_rate_id: l.tax_rate_id,
      contact_id: l.contact_id,
      tracking_option_1: l.tracking_option_1,
      tracking_option_2: l.tracking_option_2,
    })),
  });
}

export function voidJournalsForSource(source_type: string, source_id: number, user_id?: number) {
  const db = getDb();
  const journals = db
    .prepare(`SELECT id FROM journals WHERE source_type = ? AND source_id = ? AND status = 'POSTED' AND reverses_journal_id IS NULL
              AND id NOT IN (SELECT reverses_journal_id FROM journals WHERE reverses_journal_id IS NOT NULL)`)
    .all(source_type, source_id);
  for (const j of journals) {
    // Both the original and the reversal remain POSTED: together they net to
    // zero in every report, and history is never destroyed (spec §2.4).
    reverseJournal(j.id, { user_id, narration: `Void ${source_type} ${source_id}` });
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

export function baseCurrency(): string {
  return getDb().prepare('SELECT base_currency FROM organisations WHERE id = 1').get()?.base_currency ?? 'USD';
}

export function today(): string {
  // Local calendar date (not UTC). Using toISOString() returned the UTC day,
  // which is "tomorrow" for users west of GMT in the evening — pushing default
  // document dates, recurring/forecast triggers and fully_paid_at off by one.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Atomic document numbering from number_sequences; creates the sequence on first use. */
export function nextNumber(documentType: string): string {
  const db = getDb();
  return db.transaction(() => {
    let seq = db.prepare('SELECT * FROM number_sequences WHERE document_type = ?').get(documentType);
    if (!seq) {
      db.prepare('INSERT INTO number_sequences (document_type, prefix, next_number, padding) VALUES (?, ?, 1, 4)').run(
        documentType,
        documentType === 'JOURNAL' ? 'JNL-' : documentType.slice(0, 3) + '-'
      );
      seq = db.prepare('SELECT * FROM number_sequences WHERE document_type = ?').get(documentType);
    }
    db.prepare('UPDATE number_sequences SET next_number = next_number + 1 WHERE document_type = ?').run(documentType);
    return `${seq.prefix ?? ''}${String(seq.next_number).padStart(seq.padding ?? 4, '0')}`;
  });
}

export function audit(entity_type: string, entity_id: number, action: string, before: unknown, after: unknown, user_id = 1) {
  // Services pass an explicit id when they have one; the default (1) or an
  // omitted id means "whoever is signed in", resolved through the session.
  if (user_id == null || user_id === 1) user_id = session.currentUser();
  getDb()
    .prepare('INSERT INTO audit_log (entity_type, entity_id, action, before_json, after_json, user_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(entity_type, entity_id, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, user_id);
}

export function systemAccount(code: string): number {
  const a = getDb().prepare('SELECT id FROM accounts WHERE system_account = ?').get(code);
  if (!a) throw new PostingError(`System account ${code} missing`);
  return a.id;
}

export function taxComponents(taxRateId?: number | null): Array<{ percent: number; is_compound: 0 | 1 }> {
  if (!taxRateId) return [];
  return getDb().prepare('SELECT percent, is_compound FROM tax_components WHERE tax_rate_id = ?').all(taxRateId);
}

export function taxRateType(taxRateId?: number | null): string {
  if (!taxRateId) return 'NONE';
  return getDb().prepare('SELECT tax_type FROM tax_rates WHERE id = ?').get(taxRateId)?.tax_type ?? 'NONE';
}
