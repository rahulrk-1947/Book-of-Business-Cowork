/**
 * Unrealised foreign-exchange revaluation.
 *
 * Foreign-currency invoices and bills are booked to AR/AP at the rate on their
 * date. While they sit open, the base-currency value of that balance drifts as
 * rates move. At period-end you restate the open foreign AR/AP to the closing
 * rate; the difference is an *unrealised* gain or loss (unrealised because you
 * haven't actually collected or paid yet).
 *
 * Standard treatment, which this follows:
 *   - Post one revaluation journal at the chosen date that moves AR/AP to the
 *     closing rate, offsetting to the Unrealised Currency Gains account.
 *   - Auto-reverse it the next day, because it's only an estimate — the real,
 *     realised gain/loss is recognised when the document is finally settled
 *     (payments.ts already does that). Reversing prevents double counting.
 *
 * Rates follow the app convention: base = foreign × rate.
 */
import { getDb } from '../db';
import { postJournal, systemAccount, baseCurrency, assertValidDate, assertDateUnlocked, today } from '../engine';

type Line = {
  currency: string;
  control: 'AR' | 'AP';
  open_foreign: number;   // cents, foreign
  rate_booked_avg: number;
  carrying_base: number;  // cents, base — value currently in the GL
  closing_rate: number;
  revalued_base: number;  // cents, base — value at the closing rate
  delta: number;          // revalued − carrying (cents, base)
};

/** Open foreign-currency documents grouped by currency + control account. */
function openForeignBalances(asOf: string): Array<{ currency: string; control: 'AR' | 'AP'; rows: any[] }> {
  const db = getDb();
  const base = baseCurrency();
  const rows = db.prepare(
    `SELECT i.id, i.type, i.currency_code, i.exchange_rate, i.amount_due, i.invoice_number
       FROM invoices i
      WHERE i.status = 'AUTHORISED' AND i.amount_due > 0
        AND i.currency_code <> ? AND i.date <= ?`
  ).all(base, asOf) as any[];

  const groups = new Map<string, { currency: string; control: 'AR' | 'AP'; rows: any[] }>();
  for (const r of rows) {
    const control: 'AR' | 'AP' = (r.type === 'ACCREC' || r.type === 'ACCRECCREDIT') ? 'AR' : 'AP';
    const key = `${r.currency_code}|${control}`;
    if (!groups.has(key)) groups.set(key, { currency: r.currency_code, control, rows: [] });
    groups.get(key)!.rows.push(r);
  }
  return [...groups.values()];
}

/** What a revaluation at `asOf` would post, given closing `rates` (currency→rate). */
export function preview(asOf: string, rates: Record<string, number>): {
  as_of: string; base: string; lines: Line[]; total_gain: number; missing_rates: string[];
} {
  assertValidDate(asOf, 'Revaluation date');
  const groups = openForeignBalances(asOf);
  const lines: Line[] = [];
  const missing = new Set<string>();

  for (const g of groups) {
    const closing = rates[g.currency];
    if (!(closing > 0)) { missing.add(g.currency); continue; }
    let openForeign = 0, carrying = 0;
    for (const r of g.rows) {
      openForeign += r.amount_due;
      carrying += Math.round(r.amount_due * r.exchange_rate); // base currently carried
    }
    const revalued = Math.round(openForeign * closing);
    lines.push({
      currency: g.currency, control: g.control, open_foreign: openForeign,
      rate_booked_avg: openForeign ? carrying / openForeign : 0,
      carrying_base: carrying, closing_rate: closing, revalued_base: revalued,
      delta: revalued - carrying,
    });
  }
  // A positive P&L gain overall: AR up is a gain; AP up is a loss.
  const totalGain = lines.reduce((s, l) => s + (l.control === 'AR' ? l.delta : -l.delta), 0);
  return { as_of: asOf, base: baseCurrency(), lines, total_gain: totalGain, missing_rates: [...missing] };
}

/**
 * Post the revaluation (and its next-day reversal). `rates` maps each foreign
 * currency to its closing rate (base per 1 foreign unit) at `asOf`.
 */
export function revalue(asOf: string, rates: Record<string, number>, user_id = 1): {
  posted: boolean; journal_id?: number; reversal_id?: number; total_gain: number; lines: Line[]; message?: string;
} {
  assertValidDate(asOf, 'Revaluation date');
  assertDateUnlocked(asOf);
  const nextDay = addDays(asOf, 1);
  assertDateUnlocked(nextDay);

  const pv = preview(asOf, rates);
  if (pv.missing_rates.length) {
    throw new Error(`Provide a closing rate for: ${pv.missing_rates.join(', ')}`);
  }
  const movements = pv.lines.filter((l) => l.delta !== 0);
  if (movements.length === 0) {
    return { posted: false, total_gain: 0, lines: pv.lines, message: 'No revaluation needed — open foreign balances already match the closing rates.' };
  }

  const db = getDb();
  const unrealised = systemAccount('UNREALISED_FX');
  const jLines: Array<{ account_id: number; debit?: number; credit?: number; description?: string }> = [];
  let netGain = 0; // base cents; positive = an unrealised P&L gain

  for (const l of movements) {
    const control = systemAccount(l.control);
    if (l.control === 'AR') {
      // Receivable: its base value moves with delta (a debit increases the asset).
      // A higher base value on what you're owed is a gain.
      if (l.delta >= 0) jLines.push({ account_id: control, debit: l.delta, description: `Revalue ${l.currency} AR to ${l.closing_rate}` });
      else jLines.push({ account_id: control, credit: -l.delta, description: `Revalue ${l.currency} AR to ${l.closing_rate}` });
      netGain += l.delta;
    } else {
      // Payable: owing more in base (delta > 0) INCREASES the liability (a credit)
      // and is a loss; owing less reduces it (a debit) and is a gain.
      if (l.delta >= 0) jLines.push({ account_id: control, credit: l.delta, description: `Revalue ${l.currency} AP to ${l.closing_rate}` });
      else jLines.push({ account_id: control, debit: -l.delta, description: `Revalue ${l.currency} AP to ${l.closing_rate}` });
      netGain += -l.delta;
    }
  }
  // Offset to the Unrealised FX account (an expense): a gain reduces expense
  // (credit), a loss increases it (debit). Matches preview()'s total_gain.
  if (netGain > 0) jLines.push({ account_id: unrealised, credit: netGain, description: 'Unrealised FX adjustment' });
  else if (netGain < 0) jLines.push({ account_id: unrealised, debit: -netGain, description: 'Unrealised FX adjustment' });

  return db.transaction(() => {
    const journal_id = postJournal({
      date: asOf, narration: `Unrealised FX revaluation as at ${asOf}`,
      source_type: 'FX', lines: jLines, user_id,
    });
    // Auto-reverse next day so settlement's realised FX isn't double counted.
    const reversal_id = postJournal({
      date: nextDay, narration: `Reversal of unrealised FX revaluation (${asOf})`,
      source_type: 'FX', reverses_journal_id: journal_id,
      lines: jLines.map((l) => ({ account_id: l.account_id, debit: l.credit ?? 0, credit: l.debit ?? 0, description: l.description })),
      user_id,
    });
    return { posted: true, journal_id, reversal_id, total_gain: pv.total_gain, lines: pv.lines };
  });
}

/** Foreign currencies that currently have open AR/AP (so the UI can ask for rates). */
export function openForeignCurrencies(asOf?: string): string[] {
  const when = asOf ?? today();
  return [...new Set(openForeignBalances(when).map((g) => g.currency))];
}

function addDays(dateIso: string, n: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
