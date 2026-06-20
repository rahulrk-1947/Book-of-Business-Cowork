/** Manual journals: drafted, then posted through the engine like everything else. */
import { getDb } from '../db';
import { postJournal, voidJournalsForSource, audit, assertValidDate, PostingError } from '../engine';

export interface ManualJournalLine {
  id?: number;
  description?: string;
  account_id: number;
  tax_rate_id?: number | null;
  debit?: number;
  credit?: number;
  contact_id?: number | null;
  tracking_option_1?: number | null;
  tracking_option_2?: number | null;
}

export interface ManualJournalInput {
  id?: number;
  narration: string;
  date: string;
  auto_reversing_date?: string | null;
  show_on_cash_basis?: boolean;
  lines: ManualJournalLine[];
}

export function list(filter: {
  status?: string;
  search?: string;
  from?: string;
  to?: string;
  account_id?: number;
  contact_id?: number;
  min?: number;
  max?: number;
} = {}) {
  const db = getDb();
  const where: string[] = [];
  const args: any[] = [];
  if (filter.status) { where.push('mj.status = ?'); args.push(filter.status); }
  if (filter.from) { where.push('mj.date >= ?'); args.push(filter.from); }
  if (filter.to) { where.push('mj.date <= ?'); args.push(filter.to); }
  // Account / contact / text match against the journal's own lines.
  if (filter.account_id) {
    where.push('EXISTS (SELECT 1 FROM manual_journal_lines l WHERE l.manual_journal_id = mj.id AND l.account_id = ?)');
    args.push(filter.account_id);
  }
  if (filter.contact_id) {
    where.push('EXISTS (SELECT 1 FROM manual_journal_lines l WHERE l.manual_journal_id = mj.id AND l.contact_id = ?)');
    args.push(filter.contact_id);
  }
  if (filter.search?.trim()) {
    const q = `%${filter.search.trim()}%`;
    where.push(`(mj.narration LIKE ? OR j.journal_number LIKE ?
      OR EXISTS (SELECT 1 FROM manual_journal_lines l WHERE l.manual_journal_id = mj.id AND l.description LIKE ?))`);
    args.push(q, q, q);
  }
  // Amount filters compare against the journal's total debit (= total credit).
  const having: string[] = [];
  if (filter.min != null) { having.push('total_debit >= ?'); }
  if (filter.max != null) { having.push('total_debit <= ?'); }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `SELECT mj.*, j.journal_number,
              (SELECT COALESCE(SUM(debit),0) FROM manual_journal_lines WHERE manual_journal_id = mj.id) AS total_debit
       FROM manual_journals mj LEFT JOIN journals j ON j.id = mj.journal_id
       ${whereSql} ORDER BY mj.date DESC, mj.id DESC`
    )
    .all(...args) as any[];
  // Amount range applied after the aggregate is known.
  let out = rows;
  if (filter.min != null) out = out.filter((r) => r.total_debit >= filter.min!);
  if (filter.max != null) out = out.filter((r) => r.total_debit <= filter.max!);
  void having;
  return out;
}

export function get(id: number) {
  const db = getDb();
  const mj = db.prepare('SELECT * FROM manual_journals WHERE id = ?').get(id);
  if (!mj) throw new PostingError(`Manual journal ${id} not found`);
  mj.lines = db
    .prepare(
      `SELECT l.*, a.code AS account_code, a.name AS account_name, c.name AS contact_name,
              t1.name AS tracking_1, t2.name AS tracking_2
       FROM manual_journal_lines l
       JOIN accounts a ON a.id = l.account_id
       LEFT JOIN contacts c ON c.id = l.contact_id
       LEFT JOIN tracking_options t1 ON t1.id = l.tracking_option_1
       LEFT JOIN tracking_options t2 ON t2.id = l.tracking_option_2
       WHERE l.manual_journal_id = ? ORDER BY l.id`
    )
    .all(id);
  return mj;
}

/** Compact snapshot of a manual journal for the change history. */
function journalSnapshot(id: number): Record<string, unknown> | null {
  const db = getDb();
  const mj: any = db.prepare('SELECT narration, date, auto_reversing_date FROM manual_journals WHERE id = ?').get(id);
  if (!mj) return null;
  const lines = db.prepare(
    `SELECT ml.description, ml.debit, ml.credit, a.code AS account_code, a.name AS account_name, c.name AS contact
       FROM manual_journal_lines ml JOIN accounts a ON a.id = ml.account_id
       LEFT JOIN contacts c ON c.id = ml.contact_id WHERE ml.manual_journal_id = ? ORDER BY ml.id`
  ).all(id);
  return {
    narration: mj.narration, date: mj.date, auto_reversing_date: mj.auto_reversing_date,
    lines: lines.map((l: any) => ({ description: l.description, debit: l.debit, credit: l.credit,
      account: `${l.account_code} ${l.account_name}`, contact: l.contact })),
  };
}

export function saveDraft(input: ManualJournalInput, userId = 1): number {
  const db = getDb();
  if (!input.lines?.length) throw new PostingError('A journal needs lines');
  assertValidDate(input.date, 'Journal date');
  if (input.auto_reversing_date) assertValidDate(input.auto_reversing_date, 'Auto-reversal date');
  return db.transaction(() => {
    let id = input.id ?? 0;
    let beforeSnapshot: Record<string, unknown> | null = null;
    if (id) {
      const existing = db.prepare('SELECT status FROM manual_journals WHERE id = ?').get(id);
      if (!existing) throw new PostingError(`Manual journal ${id} not found`);
      if (existing.status !== 'DRAFT') throw new PostingError('Only draft journals can be edited');
      beforeSnapshot = journalSnapshot(id);
      db.prepare(
        `UPDATE manual_journals SET narration = ?, date = ?, auto_reversing_date = ?, show_on_cash_basis = ? WHERE id = ?`
      ).run(input.narration, input.date, input.auto_reversing_date ?? null, input.show_on_cash_basis === false ? 0 : 1, id);
      db.prepare('DELETE FROM manual_journal_lines WHERE manual_journal_id = ?').run(id);
    } else {
      id = Number(
        db
          .prepare(
            `INSERT INTO manual_journals (narration, date, auto_reversing_date, show_on_cash_basis, status)
             VALUES (?, ?, ?, ?, 'DRAFT')`
          )
          .run(input.narration, input.date, input.auto_reversing_date ?? null, input.show_on_cash_basis === false ? 0 : 1)
          .lastInsertRowid
      );
    }
    const ins = db.prepare(
      `INSERT INTO manual_journal_lines (manual_journal_id, description, account_id, tax_rate_id, debit, credit, contact_id, tracking_option_1, tracking_option_2)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of input.lines) {
      ins.run(
        id,
        l.description ?? null,
        l.account_id,
        l.tax_rate_id ?? null,
        Math.trunc(l.debit ?? 0),
        Math.trunc(l.credit ?? 0),
        l.contact_id ?? null,
        l.tracking_option_1 ?? null,
        l.tracking_option_2 ?? null
      );
    }
    if (input.id && beforeSnapshot) audit('manual_journal', id, 'EDITED', beforeSnapshot, journalSnapshot(id), userId);
    else audit('manual_journal', id, 'CREATED', null, journalSnapshot(id), userId);
    return id;
  });
}

export function post(id: number, userId = 1) {
  const db = getDb();
  return db.transaction(() => {
    const mj = get(id);
    if (mj.status !== 'DRAFT') throw new PostingError('Only draft journals can be posted');
    const jid = postJournal({
      date: mj.date,
      narration: mj.narration,
      source_type: 'MANUAL',
      source_id: id,
      user_id: userId,
      lines: mj.lines.map((l: any) => ({
        account_id: l.account_id,
        debit: l.debit,
        credit: l.credit,
        description: l.description,
        tax_rate_id: l.tax_rate_id,
        contact_id: l.contact_id,
        tracking_option_1: l.tracking_option_1,
        tracking_option_2: l.tracking_option_2,
      })),
    });
    db.prepare("UPDATE manual_journals SET status = 'POSTED', journal_id = ? WHERE id = ?").run(jid, id);

    // Auto-reversing journal, if requested.
    if (mj.auto_reversing_date) {
      postJournal({
        date: mj.auto_reversing_date,
        narration: `Reversal of ${mj.narration}`,
        source_type: 'MANUAL',
        source_id: id,
        reverses_journal_id: jid,
        user_id: userId,
        lines: mj.lines.map((l: any) => ({
          account_id: l.account_id,
          debit: l.credit,
          credit: l.debit,
          description: l.description,
          contact_id: l.contact_id,
        })),
      });
    }
    audit('manual_journal', id, 'POSTED', null, { journal_id: jid }, userId);
    return jid;
  });
}

export function voidJournal(id: number, userId = 1) {
  const db = getDb();
  return db.transaction(() => {
    const mj = db.prepare('SELECT * FROM manual_journals WHERE id = ?').get(id);
    if (!mj) throw new PostingError(`Manual journal ${id} not found`);
    if (mj.status === 'POSTED') voidJournalsForSource('MANUAL', id, userId);
    db.prepare("UPDATE manual_journals SET status = 'VOIDED' WHERE id = ?").run(id);
    audit('manual_journal', id, 'VOIDED', null, null, userId);
  });
}

export function remove(id: number, userId = 1) {
  const db = getDb();
  const mj = db.prepare('SELECT status FROM manual_journals WHERE id = ?').get(id);
  if (!mj) return;
  if (mj.status !== 'DRAFT') throw new PostingError('Only drafts can be deleted; void posted journals instead');
  db.transaction(() => {
    db.prepare('DELETE FROM manual_journal_lines WHERE manual_journal_id = ?').run(id);
    db.prepare('DELETE FROM manual_journals WHERE id = ?').run(id);
    audit('manual_journal', id, 'DELETED', null, null, userId);
  });
}

/** Posted → DRAFT for editing: reverses the postings (today-dated), keeps the entry. */
export function revertToDraft(id: number, userId = 1) {
  const db = getDb();
  return db.transaction(() => {
    const mj = db.prepare('SELECT * FROM manual_journals WHERE id = ?').get(id);
    if (!mj) throw new PostingError(`Manual journal ${id} not found`);
    if (mj.status !== 'POSTED') throw new PostingError(`Only posted journals can be reverted (status: ${mj.status})`);
    voidJournalsForSource('MANUAL', id, userId);
    db.prepare("UPDATE manual_journals SET status='DRAFT', journal_id=NULL WHERE id = ?").run(id);
    audit('manual_journal', id, 'REVERT_TO_DRAFT', { status: 'POSTED' }, { status: 'DRAFT' }, userId);
    return get(id);
  });
}

/** Duplicate into a fresh DRAFT dated today. */
export function copy(id: number, userId = 1) {
  const src = get(id);
  const newId = saveDraft(
    {
      narration: src.narration,
      date: new Date().toISOString().slice(0, 10),
      show_on_cash_basis: !!src.show_on_cash_basis,
      lines: src.lines.map((l: any) => ({
        description: l.description ?? undefined,
        account_id: l.account_id,
        tax_rate_id: l.tax_rate_id ?? null,
        debit: l.debit,
        credit: l.credit,
        contact_id: l.contact_id ?? null,
        tracking_option_1: l.tracking_option_1 ?? null,
        tracking_option_2: l.tracking_option_2 ?? null,
      })),
    },
    userId
  );
  audit('manual_journal', newId, 'COPIED_FROM', null, { source_id: id }, userId);
  return get(newId);
}

/** Every posted/void journal behind a source document — the generic detail view. */
export function forSource(source_type: string, source_id: number) {
  const db = getDb();
  const journals = db
    .prepare(`SELECT * FROM journals WHERE source_type = ? AND source_id = ? ORDER BY id`)
    .all(source_type, source_id);
  const lines = db.prepare(
    `SELECT jl.*, a.code AS account_code, a.name AS account_name, c.name AS contact_name,
            t1.name AS tracking_1, t2.name AS tracking_2
     FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     LEFT JOIN contacts c ON c.id = jl.contact_id
     LEFT JOIN tracking_options t1 ON t1.id = jl.tracking_option_1
     LEFT JOIN tracking_options t2 ON t2.id = jl.tracking_option_2
     WHERE jl.journal_id = ? ORDER BY jl.id`
  );
  for (const j of journals) j.lines = lines.all(j.id);
  return journals;
}


/** Rebuild a posted manual journal's ledger entry IN PLACE after a recode. */
export function rebuildManualLedger(id: number) {
  const db = getDb();
  const mj = get(id);
  if (mj.status !== 'POSTED') throw new Error('journal is not posted');
  if (!mj.journal_id) throw new Error('journal has no ledger entry to rebuild');
  let dr = 0; let cr = 0;
  for (const l of mj.lines) { dr += l.debit ?? 0; cr += l.credit ?? 0; }
  if (dr !== cr) throw new Error(`rebuild would unbalance the journal (${dr} vs ${cr})`);
  db.prepare('DELETE FROM journal_lines WHERE journal_id = ?').run(mj.journal_id);
  const ins = db.prepare(
    `INSERT INTO journal_lines (journal_id, account_id, description, debit, credit, tax_rate_id, contact_id, tracking_option_1, tracking_option_2)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const l of mj.lines) {
    ins.run(mj.journal_id, l.account_id, l.description ?? null, l.debit ?? 0, l.credit ?? 0,
      l.tax_rate_id ?? null, l.contact_id ?? null, l.tracking_option_1 ?? null, l.tracking_option_2 ?? null);
  }
  db.prepare('UPDATE journals SET narration = ? WHERE id = ?').run(mj.narration, mj.journal_id);
}
