/**
 * Conversion (opening) balances.
 *
 * Lets a business migrating from another system enter its trial balance as at a
 * conversion date, so the books continue with correct comparatives. The entries
 * are posted as a single balanced opening journal dated on the conversion date.
 * Any imbalance during setup is absorbed into the seeded "Historical Adjustment"
 * equity account (system_account HISTORICAL), the same way Xero does it, so you
 * can get started and refine later. Re-saving replaces the prior opening journal.
 */
import { getDb } from '../db';
import { postJournal, voidJournalsForSource, audit, assertValidDate, systemAccount, PostingError } from '../engine';

const SOURCE = 'CONVERSION';
const SOURCE_ID = 1; // one set of conversion balances per book

export function get() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT cb.account_id, cb.debit, cb.credit, cb.conversion_date,
            a.code AS account_code, a.name AS account_name, a.type AS account_type
       FROM conversion_balances cb JOIN accounts a ON a.id = cb.account_id
      ORDER BY a.code`
  ).all() as any[];
  const conversion_date = rows[0]?.conversion_date ?? null;
  const posted = !!db.prepare(
    `SELECT 1 FROM journals j
      WHERE j.source_type=? AND j.source_id=? AND j.status='POSTED' AND j.reverses_journal_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_journal_id = j.id)`
  ).get(SOURCE, SOURCE_ID);
  const totalDr = rows.reduce((s, r) => s + r.debit, 0);
  const totalCr = rows.reduce((s, r) => s + r.credit, 0);
  return { conversion_date, posted, lines: rows, total_debit: totalDr, total_credit: totalCr, difference: totalDr - totalCr };
}

/**
 * Save (or replace) the opening balances. `lines` are per-account debit/credit
 * in base-currency cents. The opening journal is balanced automatically against
 * the Historical Adjustment account if the entered figures don't already tie.
 */
export function save(input: { conversion_date: string; lines: Array<{ account_id: number; debit?: number; credit?: number }> }, user_id = 1) {
  const db = getDb();
  assertValidDate(input.conversion_date, 'Conversion date');
  const clean = (input.lines ?? [])
    .map((l) => ({ account_id: l.account_id, debit: Math.max(0, Math.round(Number(l.debit) || 0)), credit: Math.max(0, Math.round(Number(l.credit) || 0)) }))
    .filter((l) => l.account_id && (l.debit !== 0 || l.credit !== 0));

  for (const l of clean) {
    if (l.debit > 0 && l.credit > 0) throw new PostingError('An account can have either a debit or a credit opening balance, not both');
    const a = db.prepare('SELECT id FROM accounts WHERE id = ?').get(l.account_id);
    if (!a) throw new PostingError(`Account ${l.account_id} not found`);
  }

  return db.transaction(() => {
    // Replace any prior opening journal so re-saving is clean.
    voidJournalsForSource(SOURCE, SOURCE_ID, user_id);
    db.prepare('DELETE FROM conversion_balances').run();

    if (clean.length === 0) {
      audit('conversion', SOURCE_ID, 'CLEAR', null, null, user_id);
      return get();
    }

    // Build journal lines; balance to Historical Adjustment if needed.
    const lines = clean.map((l) => ({ account_id: l.account_id, debit: l.debit, credit: l.credit, description: 'Opening balance' }));
    const diff = lines.reduce((s, l) => s + l.debit - l.credit, 0);
    if (diff !== 0) {
      const hist = systemAccount('HISTORICAL');
      lines.push(diff > 0
        ? { account_id: hist, debit: 0, credit: diff, description: 'Opening balance adjustment' }
        : { account_id: hist, debit: -diff, credit: 0, description: 'Opening balance adjustment' });
    }

    postJournal({
      date: input.conversion_date,
      narration: 'Opening balances',
      source_type: SOURCE,
      source_id: SOURCE_ID,
      lines,
      user_id,
    });

    const ins = db.prepare('INSERT INTO conversion_balances (account_id, debit, credit, conversion_date) VALUES (?,?,?,?)');
    for (const l of clean) ins.run(l.account_id, l.debit, l.credit, input.conversion_date);
    audit('conversion', SOURCE_ID, 'SAVE', null, { conversion_date: input.conversion_date, lines: clean.length, balanced_to_historical: diff !== 0 }, user_id);
    return get();
  });
}

export function clear(user_id = 1) {
  return save({ conversion_date: get().conversion_date ?? new Date().toISOString().slice(0, 10), lines: [] }, user_id);
}
