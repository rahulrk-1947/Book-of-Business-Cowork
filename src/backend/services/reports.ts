/**
 * Reports. Every report derives from posted journal lines, so by construction
 * each one agrees with the ledger. Amounts are cents (base currency).
 *
 * Sign convention: ASSET and EXPENSE accounts are debit-natural (balance =
 * debits − credits); LIABILITY, EQUITY and REVENUE are credit-natural.
 */
import { getDb } from '../db';
import * as fxrevalue from './fxrevalue';
import * as contactsSvc from './contacts';
import { formatCents } from '../money';
import { baseCurrency, systemAccount, today } from '../engine';

const DEBIT_NATURAL = new Set(['ASSET', 'EXPENSE']);

function natural(type: string, dr: number, cr: number): number {
  return DEBIT_NATURAL.has(type) ? dr - cr : cr - dr;
}

interface Row {
  account_id: number;
  code: string;
  name: string;
  type: string;
  subtype: string | null;
  dr: number;
  cr: number;
}

function accountTotals(from: string | null, to: string | null, opts: { types?: string[]; tracking_option_id?: number } = {}): Row[] {
  const db = getDb();
  const cond: string[] = ["j.status = 'POSTED'"];
  const args: any[] = [];
  if (opts.tracking_option_id) {
    cond.push('(jl.tracking_option_1 = ? OR jl.tracking_option_2 = ?)');
    args.push(opts.tracking_option_id, opts.tracking_option_id);
  }
  if (from) {
    cond.push('j.date >= ?');
    args.push(from);
  }
  if (to) {
    cond.push('j.date <= ?');
    args.push(to);
  }
  if (opts.types?.length) {
    cond.push(`a.type IN (${opts.types.map(() => '?').join(',')})`);
    args.push(...opts.types);
  }
  return db
    .prepare(
      `SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
              COALESCE(SUM(jl.debit),0) AS dr, COALESCE(SUM(jl.credit),0) AS cr
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       JOIN accounts a ON a.id = jl.account_id
       WHERE ${cond.join(' AND ')}
       GROUP BY a.id HAVING dr <> 0 OR cr <> 0
       ORDER BY a.code`
    )
    .all(...args);
}

// ── Profit & Loss ──────────────────────────────────────────────────────────


/**
 * Cash-basis P&L rows in the same shape accountTotals produces.
 * Recognition rules, honestly stated:
 *  - Spend/receive money hits the P&L on its own date (it IS cash).
 *  - Invoices and bills hit the P&L proportionally as they are PAID:
 *    each payment allocation recognises the document's net line amounts
 *    multiplied by the share of the document that allocation settles.
 *  - Manual journals appear only when flagged "show on cash basis".
 *  - Pure accrual entries (the invoice posting itself, depreciation,
 *    FX revaluations, credit allocations) are excluded — no cash moved.
 */
function cashTotals(from: string, to: string, opts: { tracking_option_id?: number } = {}) {
  const db = getDb();
  const trk = opts.tracking_option_id;
  type Row = { account_id: number; code: string; name: string; type: string; subtype: string | null; dr: number; cr: number };
  const acc = new Map<number, Row>();
  const bump = (r: any, dr: number, cr: number) => {
    let row = acc.get(r.account_id);
    if (!row) { row = { account_id: r.account_id, code: r.code, name: r.name, type: r.type, subtype: r.subtype, dr: 0, cr: 0 }; acc.set(r.account_id, row); }
    row.dr += dr; row.cr += cr;
  };

  const trkJl = trk ? ' AND (jl.tracking_option_1 = ? OR jl.tracking_option_2 = ?)' : '';
  const direct = `
    SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype, SUM(jl.debit) AS dr, SUM(jl.credit) AS cr
    FROM journal_lines jl
    JOIN journals j ON j.id = jl.journal_id
    JOIN accounts a ON a.id = jl.account_id
    WHERE j.status = 'POSTED' AND j.date >= ? AND j.date <= ?
      AND a.type IN ('REVENUE', 'EXPENSE')
      AND (
        j.source_type = 'BANKTXN'
        OR (j.source_type = 'MANUAL' AND EXISTS (
          SELECT 1 FROM manual_journals mj WHERE mj.id = j.source_id AND mj.show_on_cash_basis = 1
        ))
      )${trkJl}
    GROUP BY a.id`;
  for (const r of db.prepare(direct).all(...(trk ? [from, to, trk, trk] : [from, to]))) bump(r, r.dr, r.cr);

  const trkIl = trk ? ' AND (il.tracking_option_1 = ? OR il.tracking_option_2 = ?)' : '';
  const paid = `
    SELECT a.id AS account_id, a.code, a.name, a.type, a.subtype,
           il.line_amount, inv.total, inv.type AS doc_type, COALESCE(inv.exchange_rate, 1) AS fx, pa.amount AS alloc
    FROM payments p
    JOIN payment_allocations pa ON pa.payment_id = p.id
    JOIN invoices inv ON inv.id = pa.invoice_id
    JOIN invoice_lines il ON il.invoice_id = inv.id
    JOIN accounts a ON a.id = il.account_id
    WHERE p.date >= ? AND p.date <= ? AND p.status = 'POSTED' AND inv.total != 0
      AND a.type IN ('REVENUE', 'EXPENSE')${trkIl}`;
  for (const r of db.prepare(paid).all(...(trk ? [from, to, trk, trk] : [from, to]))) {
    const sign = r.doc_type === 'ACCRECCREDIT' || r.doc_type === 'ACCPAYCREDIT' ? -1 : 1;
    const net = Math.round(r.line_amount * r.fx * (r.alloc / r.total)) * sign;
    if (r.type === 'REVENUE') bump(r, net < 0 ? -net : 0, net > 0 ? net : 0);
    else bump(r, net > 0 ? net : 0, net < 0 ? -net : 0);
  }
  return [...acc.values()].filter((r) => r.dr !== 0 || r.cr !== 0).sort((a, b) => a.code.localeCompare(b.code));
}

export function profitAndLoss(params: {
  from: string;
  to: string;
  compare_from?: string;
  compare_to?: string;
  /** Any number of additional periods to show side by side. */
  compare?: Array<{ from: string; to: string; label?: string }>;
  tracking_option_id?: number;
  /** ACCRUAL (default) recognises documents on their date; CASH when paid. */
  basis?: 'ACCRUAL' | 'CASH';
}) {
  const cash = params.basis === 'CASH';
  const build = (from: string, to: string) => {
    const rows = cash
      ? cashTotals(from, to, { tracking_option_id: params.tracking_option_id })
      : accountTotals(from, to, { types: ['REVENUE', 'EXPENSE'], tracking_option_id: params.tracking_option_id });
    const income = rows.filter((r) => r.type === 'REVENUE').map((r) => ({ ...r, amount: natural(r.type, r.dr, r.cr) }));
    const cogs = rows.filter((r) => r.type === 'EXPENSE' && r.subtype === 'COGS').map((r) => ({ ...r, amount: natural(r.type, r.dr, r.cr) }));
    const expenses = rows
      .filter((r) => r.type === 'EXPENSE' && r.subtype !== 'COGS')
      .map((r) => ({ ...r, amount: natural(r.type, r.dr, r.cr) }));
    const totalIncome = income.reduce((s, r) => s + r.amount, 0);
    const totalCogs = cogs.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
    return {
      income,
      cogs,
      expenses,
      total_income: totalIncome,
      total_cogs: totalCogs,
      gross_profit: totalIncome - totalCogs,
      total_expenses: totalExpenses,
      net_profit: totalIncome - totalCogs - totalExpenses,
    };
  };
  const current = build(params.from, params.to);
  const periods = params.compare ?? (params.compare_from && params.compare_to ? [{ from: params.compare_from, to: params.compare_to }] : []);
  const comparisons = periods.map((p) => ({ from: p.from, to: p.to, label: p.label ?? `${p.from} – ${p.to}`, ...build(p.from, p.to) }));
  return {
    from: params.from,
    to: params.to,
    currency: baseCurrency(),
    tracking_option_id: params.tracking_option_id ?? null,
    basis: cash ? 'CASH' : 'ACCRUAL',
    ...current,
    comparisons,
    compare: comparisons[0] ?? null, // legacy single-compare shape
  };
}

// ── Balance Sheet ──────────────────────────────────────────────────────────

export function balanceSheet(params: { as_at: string; compare?: Array<{ as_at: string; label: string }>; revalue?: boolean; basis?: 'ACCRUAL' | 'CASH' }) {
  const single = (as_at: string) => balanceSheetAt(as_at, { revalue: params.revalue, basis: params.basis });
  const current = single(params.as_at);
  const comparisons = (params.compare ?? []).map((c) => ({ label: c.label, ...single(c.as_at) }));
  return { ...current, comparisons };
}

/**
 * Start date of the financial year that contains `asAt`, from the organisation's
 * financial-year-end month/day. Example: FY-end 31 March → an as-at of 15 Jun
 * 2026 yields 2026-04-01; an as-at of 10 Feb 2026 yields 2025-04-01.
 */
function financialYearStart(asAt: string): string {
  const org: any = getDb().prepare('SELECT financial_year_end_month AS m, financial_year_end_day AS d FROM organisations WHERE id = 1').get() ?? { m: 12, d: 31 };
  const endMonth = Math.min(Math.max(Number(org.m) || 12, 1), 12);
  const [ay] = asAt.split('-').map(Number);
  const dayInMonth = (y: number, m1: number, d: number) => Math.min(d, new Date(Date.UTC(y, m1, 0)).getUTCDate()); // clamp e.g. Feb 30→28/29
  const endDay = dayInMonth(ay, endMonth, Number(org.d) || 31);
  const thisYearEnd = `${ay}-${String(endMonth).padStart(2, '0')}-${String(endDay).padStart(2, '0')}`;
  // FY end on/after asAt → FY started day after the previous year's end; else day after this year's end.
  const endYear = asAt <= thisYearEnd ? ay - 1 : ay;
  const ed = dayInMonth(endYear, endMonth, Number(org.d) || 31);
  const prevEnd = new Date(Date.UTC(endYear, endMonth - 1, ed));
  prevEnd.setUTCDate(prevEnd.getUTCDate() + 1); // day after = FY start
  return prevEnd.toISOString().slice(0, 10);
}

function balanceSheetAt(as_at: string, opts: { revalue?: boolean; basis?: 'ACCRUAL' | 'CASH' } = {}) {
  const revalue = opts.revalue ?? false;
  const cashBasis = opts.basis === 'CASH';
  const params = { as_at };
  {
  const rows = accountTotals(null, params.as_at);
  const pick = (type: string) =>
    rows
      .filter((r) => r.type === type)
      .map((r) => ({ ...r, amount: natural(r.type, r.dr, r.cr) }))
      .filter((r) => r.amount !== 0);

  const assets = pick('ASSET');
  const liabilities = pick('LIABILITY');
  const equity = pick('EQUITY');

  // Equity split (Xero-style, computed — no closing journals needed):
  //   • Current year earnings = net P&L within the current financial year.
  //   • Retained earnings = accumulated P&L from before this financial year,
  //     added to any amount posted directly to the Retained Earnings account.
  // Revenue/expense accounts are intentionally never closed; the split is
  // derived so the multi-year equity section is correct without disturbing the
  // immutable ledger or the P&L report.
  const fyStart = financialYearStart(params.as_at);
  const plNet = (rs: typeof rows) => rs.reduce((s, r) => s + (r.type === 'REVENUE' ? r.cr - r.dr : r.type === 'EXPENSE' ? -(r.dr - r.cr) : 0), 0);
  const totalEarnings = plNet(rows);                                   // all P&L up to as_at
  const currentEarnings = plNet(accountTotals(fyStart, params.as_at)); // this financial year
  const priorEarnings = totalEarnings - currentEarnings;              // prior years → retained

  // Fold prior-year earnings into the Retained Earnings line.
  let reId = 0;
  try { reId = systemAccount('RETAINED_EARNINGS'); } catch { /* no RE account */ }
  if (priorEarnings !== 0) {
    const existing = equity.find((r) => reId && (r as any).account_id === reId);
    if (existing) (existing as any).amount += priorEarnings;
    else equity.push({ account_id: reId, code: '', name: 'Retained earnings', type: 'EQUITY', subtype: null, dr: 0, cr: 0, amount: priorEarnings } as any);
  }
  if (currentEarnings !== 0) {
    equity.push({
      account_id: 0,
      code: '',
      name: 'Current year earnings',
      type: 'EQUITY',
      subtype: null,
      dr: 0,
      cr: 0,
      amount: currentEarnings,
    } as any);
  }

  // Cash-basis Balance Sheet: on a cash basis, unpaid invoices/bills haven't
  // been recognised, so Accounts Receivable and Accounts Payable don't exist,
  // the GST embedded in those unpaid amounts isn't yet collected/paid, and the
  // net income/expense isn't recognised. We remove AR/AP, restate the GST
  // control for the unsettled portion, and fold the net into earnings. The
  // adjustments are derived so the sheet balances to the cent.
  let cash_basis = false;
  if (cashBasis) {
    const db = getDb();
    const arId = (() => { try { return systemAccount('AR'); } catch { return 0; } })();
    const apId = (() => { try { return systemAccount('AP'); } catch { return 0; } })();
    let gstId = 0; try { gstId = systemAccount('GST'); } catch { /* none */ }

    const arLedger = (assets.find((r: any) => r.account_id === arId) as any)?.amount ?? 0;
    const apLedger = (liabilities.find((r: any) => r.account_id === apId) as any)?.amount ?? 0;

    // GST embedded in the still-unpaid portion of open documents (proportional), in base.
    const openDocs = (db.prepare(
      `SELECT i.type, i.total, i.total_tax, i.exchange_rate,
              ( i.total
                - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                            WHERE pa.invoice_id = i.id AND p.status = 'POSTED' AND p.date <= ?), 0)
                - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca WHERE ca.target_invoice_id = i.id AND ca.date <= ?), 0)
                - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca WHERE ca.credit_invoice_id = i.id AND ca.date <= ?), 0)
              ) AS amount_due
         FROM invoices i
        WHERE i.status IN ('AUTHORISED','PAID') AND i.total <> 0 AND i.date <= ?`
    ).all(params.as_at, params.as_at, params.as_at, params.as_at) as any[]).filter((d) => d.amount_due !== 0);
    let unpaidOutputGST = 0, unpaidInputGST = 0;
    for (const d of openDocs) {
      const gstForeign = Math.round((d.total_tax || 0) * (d.amount_due / d.total));
      const gstBase = Math.round(gstForeign * (d.exchange_rate || 1));
      if (d.type === 'ACCREC' || d.type === 'ACCRECCREDIT') unpaidOutputGST += gstBase;
      else unpaidInputGST += gstBase;
    }

    // Remove AR and AP — they don't exist on a cash basis.
    const rm = (arr: any[], id: number) => { const i = arr.findIndex((r) => r.account_id === id); if (i >= 0) arr.splice(i, 1); };
    rm(assets, arId);
    rm(liabilities, apId);

    // Restate GST: drop output GST not yet collected, add back input GST not yet paid.
    const gstDelta = -unpaidOutputGST + unpaidInputGST; // liability sense
    if (gstId && gstDelta !== 0) {
      const gstRow = liabilities.find((r: any) => r.account_id === gstId) as any;
      if (gstRow) gstRow.amount += gstDelta;
      else liabilities.push({ account_id: gstId, code: '', name: 'Sales Tax', type: 'LIABILITY', subtype: null, dr: 0, cr: 0, amount: gstDelta } as any);
    }

    // Fold the unrecognised net income/expense into earnings (balances by construction).
    const earningsDelta = -(arLedger - unpaidOutputGST) + (apLedger - unpaidInputGST);
    if (earningsDelta !== 0) {
      const ce = equity.find((r: any) => r.name === 'Current year earnings') as any;
      if (ce) ce.amount += earningsDelta;
      else equity.push({ account_id: 0, code: '', name: 'Current year earnings', type: 'EQUITY', subtype: null, dr: 0, cr: 0, amount: earningsDelta } as any);
    }
    cash_basis = true;
  }

  // On-report FX revaluation (presentation only — no journals posted). Shows
  // open foreign AR/AP at the exchange rate as at the report date, with the
  // unrealised gain/loss as an equity line. Skipped if a manual revaluation is
  // already posted (and un-reversed) as at the date, since the ledger already
  // reflects it — this prevents any double counting.
  let revalued_fx = false;
  if (revalue && !cashBasis) {
    const db = getDb();
    const hasManual = db.prepare(
      `SELECT 1 FROM journals j
        WHERE j.source_type='FX' AND j.status='POSTED' AND j.reverses_journal_id IS NULL AND j.date <= ?
          AND NOT EXISTS (SELECT 1 FROM journals r WHERE r.reverses_journal_id = j.id AND r.status='POSTED' AND r.date <= ?)
        LIMIT 1`
    ).get(params.as_at, params.as_at);
    if (!hasManual) {
      // Find which foreign currencies are open, then their closing rate as at the date.
      const probe = fxrevalue.preview(params.as_at, {});
      const rates: Record<string, number> = {};
      for (const ccy of probe.missing_rates) {
        const r: any = db.prepare('SELECT rate FROM exchange_rates WHERE currency_code = ? AND date <= ? ORDER BY date DESC LIMIT 1').get(ccy, params.as_at);
        if (r) rates[ccy] = r.rate;
      }
      const pv = fxrevalue.preview(params.as_at, rates);
      if (pv.lines.length) {
        let dAR = 0, dAP = 0;
        for (const l of pv.lines) { if (l.control === 'AR') dAR += l.delta; else dAP += l.delta; }
        const arId = (() => { try { return systemAccount('AR'); } catch { return 0; } })();
        const apId = (() => { try { return systemAccount('AP'); } catch { return 0; } })();
        const bump = (arr: any[], acctId: number, name: string, type: string, amt: number) => {
          if (amt === 0) return;
          const row = arr.find((r) => r.account_id === acctId);
          if (row) row.amount += amt;
          else arr.push({ account_id: acctId, code: '', name, type, subtype: null, dr: 0, cr: 0, amount: amt });
        };
        bump(assets, arId, 'Accounts Receivable', 'ASSET', dAR);
        bump(liabilities, apId, 'Accounts Payable', 'LIABILITY', dAP);
        if (pv.total_gain !== 0) {
          equity.push({ account_id: 0, code: '', name: 'Unrealised currency gains/(losses)', type: 'EQUITY', subtype: null, dr: 0, cr: 0, amount: pv.total_gain } as any);
        }
        revalued_fx = pv.lines.length > 0;
      }
    }
  }

  const totalAssets = assets.reduce((s, r) => s + r.amount, 0);
  const totalLiabilities = liabilities.reduce((s, r) => s + r.amount, 0);
  const totalEquity = equity.reduce((s, r) => s + r.amount, 0);
  return {
    as_at: params.as_at,
    fy_start: fyStart,
    currency: baseCurrency(),
    assets,
    liabilities,
    equity,
    retained_earnings: priorEarnings,
    current_year_earnings: currentEarnings,
    revalued_fx,
    cash_basis,
    total_assets: totalAssets,
    total_liabilities: totalLiabilities,
    total_equity: totalEquity,
    balances: totalAssets === totalLiabilities + totalEquity,
  };
  }
}

// ── Trial Balance ──────────────────────────────────────────────────────────

export function trialBalance(params: { as_at: string }) {
  const rows = accountTotals(null, params.as_at).map((r) => {
    const bal = r.dr - r.cr;
    return { ...r, debit: bal > 0 ? bal : 0, credit: bal < 0 ? -bal : 0 };
  });
  return {
    as_at: params.as_at,
    rows,
    total_debit: rows.reduce((s, r) => s + r.debit, 0),
    total_credit: rows.reduce((s, r) => s + r.credit, 0),
  };
}

// ── General Ledger ─────────────────────────────────────────────────────────

export function generalLedger(params: { from: string; to: string; account_id?: number }) {
  const db = getDb();
  const accCond = params.account_id ? 'AND a.id = ?' : '';
  const accounts = db
    .prepare(
      `SELECT DISTINCT a.id, a.code, a.name, a.type FROM accounts a
       JOIN journal_lines jl ON jl.account_id = a.id
       JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
       WHERE 1=1 ${accCond} ORDER BY a.code`
    )
    .all(...(params.account_id ? [params.account_id] : []));

  const opening = db.prepare(
    `SELECT COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0) AS bal
     FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
     WHERE jl.account_id = ? AND j.status = 'POSTED' AND j.date < ?`
  );
  const movements = db.prepare(
    `SELECT j.id AS journal_id, j.journal_number, j.date, j.narration, j.source_type, j.source_id,
            jl.description, jl.debit, jl.credit, jl.contact_id, c.name AS contact_name,
            inv.invoice_number AS doc_number,
              COALESCE(inv.reference, pay.reference, bt.reference) AS doc_reference,
              t1.name AS tracking_1, t2.name AS tracking_2
     FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
     LEFT JOIN contacts c ON c.id = jl.contact_id
     LEFT JOIN invoices inv ON j.source_type = 'INVOICE' AND inv.id = j.source_id
       LEFT JOIN payments pay ON j.source_type = 'PAYMENT' AND pay.id = j.source_id
       LEFT JOIN bank_transactions bt ON j.source_type = 'BANKTXN' AND bt.id = j.source_id
       LEFT JOIN tracking_options t1 ON t1.id = jl.tracking_option_1
       LEFT JOIN tracking_options t2 ON t2.id = jl.tracking_option_2
     WHERE jl.account_id = ? AND j.status = 'POSTED' AND j.date >= ? AND j.date <= ?
     ORDER BY j.date, j.id`
  );

  return accounts.map((a: any) => {
    const open = Number(opening.get(a.id, params.from)?.bal ?? 0);
    let running = open;
    const lines = movements.all(a.id, params.from, params.to).map((m: any) => {
      running += m.debit - m.credit;
      return { ...m, balance: running };
    });
    return { ...a, opening: open, closing: running, lines };
  });
}

// ── Account transactions (drill-down) ──────────────────────────────────────

export function accountTransactions(params: {
  account_id: number;
  from?: string;
  to?: string;
  /** Only journals that also touch a bank account (cash-flow drill). */
  cash_only?: boolean;
  tracking_option_id?: number;
  limit?: number;
}) {
  const db = getDb();
  const account = db.prepare('SELECT id, code, name, type FROM accounts WHERE id = ?').get(params.account_id);
  if (!account) throw new Error('Account not found');
  const limit = Math.min(params.limit ?? 500, 2000);
  const cond: string[] = ["jl.account_id = ?", "j.status = 'POSTED'"];
  const args: any[] = [params.account_id];
  if (params.from) { cond.push('j.date >= ?'); args.push(params.from); }
  if (params.to) { cond.push('j.date <= ?'); args.push(params.to); }
  if (params.cash_only) {
    cond.push(`EXISTS (SELECT 1 FROM journal_lines b JOIN accounts ba ON ba.id = b.account_id AND ba.is_bank_account = 1 WHERE b.journal_id = j.id)`);
  }
  if (params.tracking_option_id) {
    cond.push('(jl.tracking_option_1 = ? OR jl.tracking_option_2 = ?)');
    args.push(params.tracking_option_id, params.tracking_option_id);
  }
  const lines = db
    .prepare(
      `SELECT j.id AS journal_id, j.journal_number, j.date, j.narration, j.source_type, j.source_id,
              jl.description, jl.debit, jl.credit, c.name AS contact_name,
              inv.invoice_number AS doc_number,
              COALESCE(inv.reference, pay.reference, bt.reference) AS doc_reference,
              t1.name AS tracking_1, t2.name AS tracking_2
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       LEFT JOIN contacts c ON c.id = jl.contact_id
       LEFT JOIN invoices inv ON j.source_type = 'INVOICE' AND inv.id = j.source_id
       LEFT JOIN payments pay ON j.source_type = 'PAYMENT' AND pay.id = j.source_id
       LEFT JOIN bank_transactions bt ON j.source_type = 'BANKTXN' AND bt.id = j.source_id
       LEFT JOIN tracking_options t1 ON t1.id = jl.tracking_option_1
       LEFT JOIN tracking_options t2 ON t2.id = jl.tracking_option_2
       WHERE ${cond.join(' AND ')}
       ORDER BY j.date, j.id LIMIT ?`
    )
    .all(...args, limit + 1);
  const truncated = lines.length > limit;
  if (truncated) lines.pop();
  return {
    account,
    from: params.from ?? null,
    to: params.to ?? null,
    lines,
    total: lines.reduce((s: number, l: any) => s + l.debit - l.credit, 0),
    truncated,
  };
}

/**
 * Account Statement (Xero's "Account Transactions"): a flat, fully
 * filterable list of ledger lines. Any mix of accounts, contacts, source
 * types and account types; free-text search across description, narration,
 * journal number and contact. When the result is a single account's
 * unfiltered history, an opening balance is included so the UI can show a
 * running balance honestly.
 */
export function accountStatement(params: {
  from: string;
  to: string;
  account_ids?: number[];
  contact_ids?: number[];
  source_types?: string[];
  account_types?: string[];
  search?: string;
  limit?: number;
}) {
  const db = getDb();
  const limit = Math.min(params.limit ?? 1000, 5000);
  const cond: string[] = ["j.status = 'POSTED'", 'j.date >= ?', 'j.date <= ?'];
  const args: any[] = [params.from, params.to];
  const inClause = (col: string, vals?: any[]) => {
    if (vals && vals.length) {
      cond.push(`${col} IN (${vals.map(() => '?').join(',')})`);
      args.push(...vals);
    }
  };
  inClause('jl.account_id', params.account_ids);
  inClause('jl.contact_id', params.contact_ids);
  inClause('j.source_type', params.source_types);
  inClause('a.type', params.account_types);
  if (params.search?.trim()) {
    cond.push(
      `(jl.description LIKE ? OR j.narration LIKE ? OR j.journal_number LIKE ? OR c.name LIKE ?
        OR inv.invoice_number LIKE ? OR inv.reference LIKE ? OR pay.reference LIKE ? OR bt.reference LIKE ?)`
    );
    const q = `%${params.search.trim()}%`;
    args.push(q, q, q, q, q, q, q, q);
  }
  const lines = db
    .prepare(
      `SELECT j.id AS journal_id, j.journal_number, j.date, j.narration, j.source_type, j.source_id,
              jl.description, jl.debit, jl.credit, jl.contact_id, c.name AS contact_name,
              a.id AS account_id, a.code AS account_code, a.name AS account_name, a.type AS account_type,
              inv.invoice_number AS doc_number,
              COALESCE(inv.reference, pay.reference, bt.reference) AS doc_reference,
              t1.name AS tracking_1, t2.name AS tracking_2
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       JOIN accounts a ON a.id = jl.account_id
       LEFT JOIN contacts c ON c.id = jl.contact_id
       LEFT JOIN invoices inv ON j.source_type = 'INVOICE' AND inv.id = j.source_id
       LEFT JOIN payments pay ON j.source_type = 'PAYMENT' AND pay.id = j.source_id
       LEFT JOIN bank_transactions bt ON j.source_type = 'BANKTXN' AND bt.id = j.source_id
       LEFT JOIN tracking_options t1 ON t1.id = jl.tracking_option_1
       LEFT JOIN tracking_options t2 ON t2.id = jl.tracking_option_2
       WHERE ${cond.join(' AND ')}
       ORDER BY j.date, j.id, jl.id LIMIT ?`
    )
    .all(...args, limit + 1);
  const truncated = lines.length > limit;
  if (truncated) lines.pop();

  // Opening balance: only meaningful for one account with no other filters.
  let opening: number | null = null;
  const single =
    params.account_ids?.length === 1 &&
    !params.contact_ids?.length && !params.source_types?.length &&
    !params.account_types?.length && !params.search?.trim();
  if (single) {
    opening = Number(
      db.prepare(
        `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS b FROM journal_lines jl
         JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
         WHERE jl.account_id = ? AND j.date < ?`
      ).get(params.account_ids![0], params.from).b
    );
  }
  // Running balance only makes sense for a single account in date order
  // (the lines are already ordered by date, journal, line). Each row carries
  // the account balance immediately after it posts, starting from `opening`.
  if (single && opening !== null) {
    let bal = opening;
    for (const l of lines as any[]) {
      bal += l.debit - l.credit;
      l.running_balance = bal;
    }
  }
  const closing = single && opening !== null
    ? opening + lines.reduce((s: number, l: any) => s + (l.debit - l.credit), 0)
    : null;

  return {
    from: params.from,
    to: params.to,
    lines,
    opening,
    closing,
    has_running_balance: single && opening !== null,
    total_debit: lines.reduce((s: number, l: any) => s + l.debit, 0),
    total_credit: lines.reduce((s: number, l: any) => s + l.credit, 0),
    truncated,
  };
}

/** Invoice/bill lines behind one tax rate in a period (tax summary drill). */
export function taxRateLines(params: { tax_rate_id: number; from: string; to: string }) {
  const db = getDb();
  return db
    .prepare(
      `SELECT il.id, il.description, il.line_amount, il.tax_amount,
              i.id AS invoice_id, i.type, i.invoice_number, i.date, i.status, c.name AS contact_name
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id AND i.status IN ('AUTHORISED','PAID') AND i.date >= ? AND i.date <= ?
       JOIN contacts c ON c.id = i.contact_id
       WHERE il.tax_rate_id = ?
       ORDER BY i.date, i.id LIMIT 1000`
    )
    .all(params.from, params.to, params.tax_rate_id);
}

// ── Aged receivables / payables ────────────────────────────────────────────

function aged(type: 'ACCREC' | 'ACCPAY', asAt: string) {
  const db = getDb();
  // Outstanding as OF the report date: reconstruct each document's balance from
  // payments and credit allocations dated on or before asAt, instead of reading
  // the live (mutable) amount_due column. Otherwise a back-dated aging drops
  // invoices that were paid after asAt and understates ones partly paid later,
  // and it would not tie to the AR/AP control on a balance sheet at that date.
  const rows = db
    .prepare(
      `SELECT i.id, i.invoice_number, i.date, i.due_date, i.total,
              c.id AS contact_id, c.name AS contact_name,
              ( i.total
                - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                            WHERE pa.invoice_id = i.id AND p.status = 'POSTED' AND p.date <= ?), 0)
                - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca WHERE ca.target_invoice_id = i.id AND ca.date <= ?), 0)
                - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca WHERE ca.credit_invoice_id = i.id AND ca.date <= ?), 0)
              ) AS amount_due
       FROM invoices i JOIN contacts c ON c.id = i.contact_id
       WHERE i.type = ? AND i.status IN ('AUTHORISED','PAID') AND i.date <= ?
       ORDER BY c.name, i.due_date`
    )
    .all(asAt, asAt, asAt, type, asAt);
  const buckets = (days: number) => (days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus');
  const byContact = new Map<number, any>();
  for (const r of rows) {
    if (r.amount_due <= 0) continue; // fully settled on or before the as-at date
    const due = r.due_date ?? r.date;
    const days = Math.floor((Date.parse(asAt) - Date.parse(due)) / 86400000);
    const b = buckets(days);
    let c = byContact.get(r.contact_id);
    if (!c) {
      c = { contact_id: r.contact_id, contact_name: r.contact_name, current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0, total: 0, invoices: [] };
      byContact.set(r.contact_id, c);
    }
    c[b] += r.amount_due;
    c.total += r.amount_due;
    c.invoices.push({ ...r, bucket: b, days_overdue: Math.max(0, days) });
  }
  const contacts = [...byContact.values()];
  const sum = (k: string) => contacts.reduce((s, c) => s + c[k], 0);
  return {
    as_at: asAt,
    contacts,
    totals: { current: sum('current'), d1_30: sum('d1_30'), d31_60: sum('d31_60'), d61_90: sum('d61_90'), d90_plus: sum('d90_plus'), total: sum('total') },
  };
}

export function agedReceivables(params: { as_at: string }) {
  return aged('ACCREC', params.as_at);
}
export function agedPayables(params: { as_at: string }) {
  return aged('ACCPAY', params.as_at);
}

// ── Cash flow (cash movements by category) ─────────────────────────────────

export function cashFlow(params: { from: string; to: string }) {
  const db = getDb();
  // Each posted journal in the period that touches a bank account, with its net
  // bank movement. We classify each NON-bank counterpart line on its OWN side
  // (a credit is a source of cash → inflow; a debit is a use of cash → outflow)
  // instead of forcing every counterpart to the sign of the net bank delta,
  // which mis-bucketed mixed-sign journals (e.g. a receipt net of a fee) and
  // double-counted counterparts when a journal had more than one bank line.
  const journals = db
    .prepare(
      `SELECT j.id,
              COALESCE(SUM(CASE WHEN a.is_bank_account = 1 THEN jl.debit - jl.credit ELSE 0 END), 0) AS bank_delta
       FROM journals j
       JOIN journal_lines jl ON jl.journal_id = j.id
       JOIN accounts a ON a.id = jl.account_id
       WHERE j.status = 'POSTED' AND j.date >= ? AND j.date <= ?
       GROUP BY j.id
       HAVING SUM(CASE WHEN a.is_bank_account = 1 THEN 1 ELSE 0 END) > 0`
    )
    .all(params.from, params.to);

  const counter = db.prepare(
    `SELECT a.id, a.code, a.name, a.type, a.is_bank_account, jl.debit, jl.credit
     FROM journal_lines jl JOIN accounts a ON a.id = jl.account_id
     WHERE jl.journal_id = ?`
  );

  const inflows = new Map<string, { code: string; name: string; amount: number }>();
  const outflows = new Map<string, { code: string; name: string; amount: number }>();
  let netMovement = 0;

  for (const b of journals) {
    netMovement += b.bank_delta;
    const lines = counter.all(b.id).filter((l: any) => !l.is_bank_account);
    for (const l of lines) {
      // Cash contribution of a counterpart line = credit − debit (the opposite
      // of its ledger delta, since the bank side equals minus the sum of the
      // counterparts). Positive = cash in, negative = cash out.
      const contribution = l.credit - l.debit;
      if (contribution === 0) continue;
      const target = contribution > 0 ? inflows : outflows;
      const key = l.code;
      const e = target.get(key) ?? { code: l.code, name: l.name, amount: 0 };
      e.amount += Math.abs(contribution);
      target.set(key, e);
    }
  }

  const opening = db
    .prepare(
      `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS bal
       FROM journal_lines jl
       JOIN accounts a ON a.id = jl.account_id AND a.is_bank_account = 1
       JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED' AND j.date < ?`
    )
    .get(params.from)?.bal ?? 0;

  return {
    from: params.from,
    to: params.to,
    opening_balance: Number(opening),
    inflows: [...inflows.values()].sort((a, b) => b.amount - a.amount),
    outflows: [...outflows.values()].sort((a, b) => b.amount - a.amount),
    net_movement: netMovement,
    closing_balance: Number(opening) + netMovement,
  };
}

// ── Tax / GST return summary ───────────────────────────────────────────────

export function taxSummary(params: { from: string; to: string }) {
  const db = getDb();
  // Tax collected/paid: movements on the GST control account(s), split by the
  // source document direction. Plus taxable sales/purchases from documents.
  const gstId = systemAccount('GST');

  const gst = db
    .prepare(
      `SELECT j.source_type, COALESCE(SUM(jl.credit),0) AS cr, COALESCE(SUM(jl.debit),0) AS dr
       FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
       WHERE jl.account_id = ? AND j.status = 'POSTED' AND j.date >= ? AND j.date <= ?
         AND j.source_type <> 'GST_PAYMENT'
       GROUP BY j.source_type`
    )
    .all(gstId, params.from, params.to);

  let collected = 0;
  let paid = 0;
  for (const g of gst) {
    collected += g.cr;
    paid += g.dr;
  }

  const docs = db
    .prepare(
      `SELECT type, COALESCE(SUM(subtotal),0) AS net, COALESCE(SUM(total_tax),0) AS tax
       FROM invoices WHERE status IN ('AUTHORISED','PAID') AND date >= ? AND date <= ?
       GROUP BY type`
    )
    .all(params.from, params.to);
  const byType: any = Object.fromEntries(docs.map((d: any) => [d.type, d]));

  const byRate = db
    .prepare(
      `SELECT tr.id, tr.name, tr.display_rate, i.type,
              COALESCE(SUM(il.line_amount),0) AS net, COALESCE(SUM(il.tax_amount),0) AS tax
       FROM invoice_lines il
       JOIN invoices i ON i.id = il.invoice_id AND i.status IN ('AUTHORISED','PAID') AND i.date >= ? AND i.date <= ?
       JOIN tax_rates tr ON tr.id = il.tax_rate_id
       GROUP BY tr.id, i.type ORDER BY tr.name`
    )
    .all(params.from, params.to);

  const balance = db
    .prepare(
      `SELECT COALESCE(SUM(jl.credit - jl.debit),0) AS bal
       FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
       WHERE jl.account_id = ? AND j.status = 'POSTED' AND j.date <= ?`
    )
    .get(gstId, params.to)?.bal ?? 0;

  return {
    from: params.from,
    to: params.to,
    tax_collected: collected,
    tax_paid: paid,
    net_tax: collected - paid,
    gst_control_balance: Number(balance),
    sales: { net: (byType.ACCREC?.net ?? 0) - (byType.ACCRECCREDIT?.net ?? 0), tax: (byType.ACCREC?.tax ?? 0) - (byType.ACCRECCREDIT?.tax ?? 0) },
    purchases: { net: (byType.ACCPAY?.net ?? 0) - (byType.ACCPAYCREDIT?.net ?? 0), tax: (byType.ACCPAY?.tax ?? 0) - (byType.ACCPAYCREDIT?.tax ?? 0) },
    by_rate: byRate,
  };
}

// ── Journal report (raw journals listing) ──────────────────────────────────

export function journalReport(params: { from: string; to: string }) {
  const db = getDb();
  const journals = db
    .prepare(`SELECT * FROM journals WHERE date >= ? AND date <= ? AND status IN ('POSTED','VOID') ORDER BY date, id`)
    .all(params.from, params.to);
  const lines = db.prepare(
    `SELECT jl.*, a.code AS account_code, a.name AS account_name FROM journal_lines jl
     JOIN accounts a ON a.id = jl.account_id WHERE jl.journal_id = ? ORDER BY jl.id`
  );
  for (const j of journals) j.lines = lines.all(j.id);
  return journals;
}

// ── CSV export ─────────────────────────────────────────────────────────────

function csvEscape(v: unknown): string {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(headers: string[], rows: unknown[][]): string {
  return [headers.map(csvEscape).join(','), ...rows.map((r) => r.map(csvEscape).join(','))].join('\n');
}

export function exportCsv(params: { report: string; [k: string]: any }): { filename: string; csv: string } {
  const p = params as any;
  const money = (c: number) => formatCents(c);
  switch (params.report) {
    case 'profit_and_loss': {
      const r = profitAndLoss(p);
      const cmps: any[] = r.comparisons ?? [];
      const cmpAmt = (c: any, section: string, accountId: number) =>
        money((c[section] ?? []).find((x: any) => x.account_id === accountId)?.amount ?? 0);
      const line = (section: string, key: string, s2: any) => [section, s2.code, s2.name, money(s2.amount), ...cmps.map((c) => cmpAmt(c, key, s2.account_id))];
      const total = (label: string, key: string) => ['', '', label, money((r as any)[key]), ...cmps.map((c) => money(c[key]))];
      const rows: unknown[][] = [];
      for (const s2 of r.income) rows.push(line('Income', 'income', s2));
      rows.push(total('Total income', 'total_income'));
      for (const s2 of r.cogs) rows.push(line('Cost of sales', 'cogs', s2));
      rows.push(total('Gross profit', 'gross_profit'));
      for (const s2 of r.expenses) rows.push(line('Expenses', 'expenses', s2));
      rows.push(total('Total expenses', 'total_expenses'));
      rows.push(total('Net profit', 'net_profit'));
      const headers = ['Section', 'Code', 'Account', `${p.from} – ${p.to}`, ...cmps.map((c: any) => c.label)];
      return { filename: `profit-and-loss${p.basis === 'CASH' ? '-cash' : ''}-${p.from}-to-${p.to}.csv`, csv: toCsv(headers, rows) };
    }
    case 'balance_sheet': {
      const r = balanceSheet(p);
      const cmps: any[] = r.comparisons ?? [];
      const key = (x: any) => x.account_id ?? x.name;
      const cmpAmt = (c: any, section: string, row: any) =>
        money((c[section] ?? []).find((x: any) => key(x) === key(row))?.amount ?? 0);
      const line = (label: string, section: string, row: any) =>
        [label, row.code ?? '', row.name, money(row.amount), ...cmps.map((c) => cmpAmt(c, section, row))];
      const total = (label: string, k: string) => ['', '', label, money((r as any)[k]), ...cmps.map((c) => money(c[k]))];
      const rows: unknown[][] = [];
      for (const s of r.assets) rows.push(line('Assets', 'assets', s));
      rows.push(total('Total assets', 'total_assets'));
      for (const s of r.liabilities) rows.push(line('Liabilities', 'liabilities', s));
      rows.push(total('Total liabilities', 'total_liabilities'));
      for (const s of r.equity) rows.push(line('Equity', 'equity', s));
      rows.push(total('Total equity', 'total_equity'));
      return { filename: `balance-sheet-${p.as_at}.csv`, csv: toCsv(['Section', 'Code', 'Account', `As at ${p.as_at}`, ...cmps.map((c: any) => c.label)], rows) };
    }
    case 'trial_balance': {
      const r = trialBalance(p);
      const rows = r.rows.map((x: any) => [x.code, x.name, x.type, money(x.debit), money(x.credit)]);
      rows.push(['', 'TOTAL', '', money(r.total_debit), money(r.total_credit)]);
      return { filename: `trial-balance-${p.as_at}.csv`, csv: toCsv(['Code', 'Account', 'Type', 'Debit', 'Credit'], rows) };
    }
    case 'account_statement': {
      const r = accountStatement(p);
      const trk = (l: any) => [l.tracking_1, l.tracking_2].filter(Boolean).join(' · ');
      const withBal = r.has_running_balance;
      const head = ['Date', 'Journal', 'Document #', 'Reference', 'Source', 'Code', 'Account', 'Account type', 'Description', 'Contact', 'Tracking', 'Debit', 'Credit'];
      if (withBal) head.push('Running balance');
      const rows: unknown[][] = [];
      if (withBal) rows.push(['', '', '', '', '', '', '', '', 'Opening balance', '', '', '', '', money(r.opening!)]);
      for (const l of r.lines as any[]) {
        const row: unknown[] = [
          l.date, l.journal_number, l.doc_number ?? '', l.doc_reference ?? '', l.source_type, l.account_code, l.account_name, l.account_type,
          l.description ?? l.narration ?? '', l.contact_name ?? '', trk(l), money(l.debit), money(l.credit),
        ];
        if (withBal) row.push(money(l.running_balance ?? 0));
        rows.push(row);
      }
      const totalRow: unknown[] = ['', '', '', '', '', '', '', '', 'Totals', '', '', money(r.total_debit), money(r.total_credit)];
      if (withBal) totalRow.push(money(r.closing!));
      rows.push(totalRow);
      return {
        filename: `account-statement-${p.from}-to-${p.to}.csv`,
        csv: toCsv(head, rows),
      };
    }
    case 'aged_receivables_detail':
    case 'aged_payables_detail': {
      const r = params.report === 'aged_receivables_detail' ? agedReceivables(p) : agedPayables(p);
      const bucket = (days: number, due: number) => {
        const b = ['', '', '', '', ''];
        const i = days <= 0 ? 0 : days <= 30 ? 1 : days <= 60 ? 2 : days <= 90 ? 3 : 4;
        b[i] = money(due);
        return b;
      };
      const rows: unknown[][] = [];
      for (const c of r.contacts) {
        for (const inv of c.invoices) {
          rows.push([c.contact_name, inv.invoice_number, inv.date, inv.due_date, inv.days_overdue > 0 ? inv.days_overdue : 0, ...bucket(inv.days_overdue, inv.amount_due), money(inv.amount_due)]);
        }
        rows.push([`${c.contact_name} subtotal`, '', '', '', '', money(c.current), money(c.d1_30), money(c.d31_60), money(c.d61_90), money(c.d90_plus), money(c.total)]);
      }
      rows.push(['Total', '', '', '', '', money(r.totals.current), money(r.totals.d1_30), money(r.totals.d31_60), money(r.totals.d61_90), money(r.totals.d90_plus), money(r.totals.total)]);
      return {
        filename: `${params.report.replace(/_/g, '-')}-${p.as_at}.csv`,
        csv: toCsv(['Contact', 'Number', 'Date', 'Due date', 'Days overdue', 'Current', '1-30', '31-60', '61-90', '90+', 'Total'], rows),
      };
    }
    case 'contact_activity': {
      const act = contactsSvc.activity(p.contact_id, { from: p.from, to: p.to });
      const c = contactsSvc.get(p.contact_id);
      const rows = act.rows.map((r2: any) => [
        r2.date, r2.kind, r2.number ?? '', r2.reference ?? '', r2.status, money(r2.total), r2.amount_due != null ? money(r2.amount_due) : '',
      ]);
      return {
        filename: `activity-${(c?.name ?? 'contact').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.csv`,
        csv: toCsv(['Date', 'Type', 'Number', 'Reference', 'Status', 'Total', 'Outstanding'], rows),
      };
    }
    case 'general_ledger': {
      const accounts = generalLedger(p);
      const rows: unknown[][] = [];
      for (const a of accounts) {
        rows.push([a.code, a.name, '', '', 'Opening', money(a.opening)]);
        for (const l of a.lines) rows.push([a.code, a.name, l.date, l.journal_number, l.description ?? l.narration ?? '', money(l.debit - l.credit), money(l.balance)]);
        rows.push([a.code, a.name, '', '', 'Closing', money(a.closing)]);
      }
      return { filename: `general-ledger-${p.from}-to-${p.to}.csv`, csv: toCsv(['Code', 'Account', 'Date', 'Journal', 'Description', 'Amount', 'Balance'], rows) };
    }
    case 'aged_receivables':
    case 'aged_payables': {
      const r = params.report === 'aged_receivables' ? agedReceivables(p) : agedPayables(p);
      const rows = r.contacts.map((c: any) => [c.contact_name, money(c.current), money(c.d1_30), money(c.d31_60), money(c.d61_90), money(c.d90_plus), money(c.total)]);
      rows.push(['TOTAL', money(r.totals.current), money(r.totals.d1_30), money(r.totals.d31_60), money(r.totals.d61_90), money(r.totals.d90_plus), money(r.totals.total)]);
      return { filename: `${params.report.replace('_', '-')}-${p.as_at}.csv`, csv: toCsv(['Contact', 'Current', '1-30', '31-60', '61-90', '90+', 'Total'], rows) };
    }
    case 'cash_flow': {
      const r = cashFlow(p);
      const rows: unknown[][] = [['', 'Opening balance', money(r.opening_balance)]];
      for (const i of r.inflows) rows.push(['Inflow', `${i.code} ${i.name}`, money(i.amount)]);
      for (const o of r.outflows) rows.push(['Outflow', `${o.code} ${o.name}`, money(-o.amount)]);
      rows.push(['', 'Net movement', money(r.net_movement)]);
      rows.push(['', 'Closing balance', money(r.closing_balance)]);
      return { filename: `cash-flow-${p.from}-to-${p.to}.csv`, csv: toCsv(['Direction', 'Account', 'Amount'], rows) };
    }
    case 'tax_summary': {
      const r = taxSummary(p);
      const rows: unknown[][] = [
        ['Tax on sales (collected)', money(r.tax_collected)],
        ['Tax on purchases (paid)', money(r.tax_paid)],
        ['Net tax', money(r.net_tax)],
        ['Taxable sales (net)', money(r.sales.net)],
        ['Taxable purchases (net)', money(r.purchases.net)],
      ];
      for (const br of r.by_rate) rows.push([`${br.name} (${br.display_rate}%) — ${br.type}`, `${money(br.net)} net / ${money(br.tax)} tax`]);
      return { filename: `tax-summary-${p.from}-to-${p.to}.csv`, csv: toCsv(['Line', 'Amount'], rows) };
    }
    case 'project_pl': {
      const r = projectProfitability(p);
      const rows: unknown[][] = r.rows.map((x: any) => [x.code ? `${x.code} · ${x.name}` : x.name, x.contact_name ?? '', money(x.revenue), money(x.cost), money(x.margin), x.margin_pct == null ? '' : `${x.margin_pct}%`]);
      rows.push(['Total', '', money(r.totals.revenue), money(r.totals.cost), money(r.totals.margin), r.totals.margin_pct == null ? '' : `${r.totals.margin_pct}%`]);
      return { filename: `project-p-and-l-${p.from}-to-${p.to}.csv`, csv: toCsv(['Project', 'Customer', 'Revenue', 'Cost', 'Margin', 'Margin %'], rows) };
    }
    case 'inventory_valuation': {
      const r = inventoryValuation({ as_at: params.as_at });
      const rows: unknown[][] = r.rows.map((x: any) => [x.code, x.name, x.quantity, money(x.average_cost), money(x.total_value), x.reorder_point ?? '', x.low ? 'LOW' : '']);
      rows.push(['', 'Total', r.total_quantity, '', money(r.total_value), '', '']);
      return { filename: `inventory-valuation-${r.as_at}.csv`, csv: toCsv(['Code', 'Item', 'Qty on hand', 'Avg cost', 'Total value', 'Reorder point', 'Status'], rows) };
    }
    default:
      throw new Error(`Unknown report ${params.report}`);
  }
}

/**
 * Ledger integrity health check (non-throwing). Confirms every posted journal
 * balances and the whole ledger nets to zero. Returns a structured result so
 * the UI can show a green/amber status; `db.integrityCheck` is the throwing
 * version used on backup/restore.
 */
export function integrityCheck() {
  const db = getDb();
  const unbalanced = db.prepare(
    `SELECT j.id, j.journal_number, j.narration,
            COALESCE(SUM(l.debit),0) AS dr, COALESCE(SUM(l.credit),0) AS cr
       FROM journals j JOIN journal_lines l ON l.journal_id = j.id
      WHERE j.status = 'POSTED'
      GROUP BY j.id HAVING COALESCE(SUM(l.debit),0) <> COALESCE(SUM(l.credit),0)`
  ).all() as any[];
  const tot: any = db.prepare(
    `SELECT COALESCE(SUM(l.debit),0) AS dr, COALESCE(SUM(l.credit),0) AS cr
       FROM journal_lines l JOIN journals j ON j.id = l.journal_id
      WHERE j.status = 'POSTED'`
  ).get();
  // Orphaned lines (a line whose journal is missing) would corrupt totals.
  const orphans: any = db.prepare(
    `SELECT COUNT(*) AS n FROM journal_lines l WHERE NOT EXISTS (SELECT 1 FROM journals j WHERE j.id = l.journal_id)`
  ).get();
  const ledger_balanced = tot.dr === tot.cr;
  return {
    ok: unbalanced.length === 0 && ledger_balanced && orphans.n === 0,
    unbalanced_journals: unbalanced,
    ledger_debit: tot.dr,
    ledger_credit: tot.cr,
    ledger_balanced,
    orphaned_lines: orphans.n,
  };
}

/**
 * Project / job profitability: a P&L summary for each option of a tracking
 * category (e.g. each project or job), side by side. Reuses the P&L engine per
 * option, so it honours the accrual/cash basis. Income and costs that aren't
 * tagged to any option in this category are not included in a column.
 */
export function trackingProfitability(params: { category_id: number; from: string; to: string; basis?: 'ACCRUAL' | 'CASH' }) {
  const db = getDb();
  const cat: any = db.prepare('SELECT id, name FROM tracking_categories WHERE id = ?').get(params.category_id);
  if (!cat) throw new Error('Tracking category not found');
  const options = db.prepare("SELECT id, name FROM tracking_options WHERE category_id = ? AND status = 'ACTIVE' ORDER BY name").all(params.category_id) as any[];
  const rows = options.map((o) => {
    const pl: any = profitAndLoss({ from: params.from, to: params.to, basis: params.basis, tracking_option_id: o.id });
    return {
      option_id: o.id,
      name: o.name,
      income: pl.total_income,
      cogs: pl.total_cogs,
      gross_profit: pl.gross_profit,
      expenses: pl.total_expenses,
      net: pl.net_profit,
    };
  });
  const totals = rows.reduce(
    (s, r) => ({ income: s.income + r.income, cogs: s.cogs + r.cogs, gross_profit: s.gross_profit + r.gross_profit, expenses: s.expenses + r.expenses, net: s.net + r.net }),
    { income: 0, cogs: 0, gross_profit: 0, expenses: 0, net: 0 }
  );
  return { category: cat, from: params.from, to: params.to, basis: params.basis ?? 'ACCRUAL', rows, totals };
}

/**
 * Project P&L — for each project, billed revenue (sales invoices tagged to the
 * project, net of customer credit notes) against recorded costs (bills,
 * expense claims, supplier credits and manual costs tagged to it) over a date
 * range, with the resulting margin. Uses the projects module directly, so it's
 * a true per-job profit picture rather than a class/tracking cut of the ledger.
 */
export function projectProfitability(params: { from: string; to: string }) {
  const db = getDb();
  const { from, to } = params;
  const revRows = db.prepare(
    `SELECT l.project_id AS pid,
            COALESCE(SUM(CASE WHEN i.type = 'ACCRECCREDIT' THEN -l.line_amount ELSE l.line_amount END), 0) AS revenue
       FROM invoice_lines l JOIN invoices i ON i.id = l.invoice_id
      WHERE l.project_id IS NOT NULL AND i.type IN ('ACCREC', 'ACCRECCREDIT')
        AND i.status IN ('AUTHORISED', 'PAID') AND i.date BETWEEN ? AND ?
      GROUP BY l.project_id`,
  ).all(from, to) as any[];
  const costRows = db.prepare(
    `SELECT project_id AS pid, COALESCE(SUM(cost_amount), 0) AS cost
       FROM project_expenses WHERE date BETWEEN ? AND ? GROUP BY project_id`,
  ).all(from, to) as any[];
  const revBy = new Map(revRows.map((r) => [r.pid, Number(r.revenue)]));
  const costBy = new Map(costRows.map((r) => [r.pid, Number(r.cost)]));
  const projects = db.prepare(
    `SELECT p.id, p.name, p.code, p.status, c.name AS contact_name
       FROM projects p LEFT JOIN contacts c ON c.id = p.contact_id
      ORDER BY p.name COLLATE NOCASE`,
  ).all() as any[];
  const pct = (margin: number, revenue: number) => (revenue !== 0 ? Math.round((margin / revenue) * 1000) / 10 : null);
  const rows = projects
    .map((p) => {
      const revenue = revBy.get(p.id) || 0;
      const cost = costBy.get(p.id) || 0;
      const margin = revenue - cost;
      return { project_id: p.id, name: p.name, code: p.code, status: p.status, contact_name: p.contact_name, revenue, cost, margin, margin_pct: pct(margin, revenue) };
    })
    .filter((r) => r.revenue !== 0 || r.cost !== 0 || r.status === 'IN_PROGRESS');
  const totals = rows.reduce(
    (s, r) => ({ revenue: s.revenue + r.revenue, cost: s.cost + r.cost, margin: s.margin + r.margin }),
    { revenue: 0, cost: 0, margin: 0 },
  );
  return { from, to, rows, totals: { ...totals, margin_pct: pct(totals.margin, totals.revenue) } };
}

/**
 * Inventory valuation — current quantity on hand and value (at weighted-average
 * cost) for every tracked item, with low-stock flags against each item's
 * reorder point. A snapshot as of now: the figures match the items' running
 * balances, which reconcile to the inventory asset accounts in the ledger.
 */
export function inventoryValuation(params: { as_at?: string } = {}) {
  const db = getDb();
  const asAt = params.as_at;
  const historical = !!asAt && asAt < today();
  let items: any[];
  if (historical) {
    // As at a past date: rebuild each item's position by summing every movement
    // dated on or before as_at (robust to back-dated movements).
    items = db.prepare(
      `SELECT i.code, i.name, i.reorder_point,
              COALESCE(mv.qty, 0) AS quantity_on_hand,
              COALESCE(mv.value, 0) AS total_value
         FROM items i
         LEFT JOIN (
           SELECT item_id, SUM(qty_delta) AS qty, SUM(value_delta) AS value
             FROM inventory_movements WHERE date <= ? GROUP BY item_id
         ) mv ON mv.item_id = i.id
        WHERE i.is_tracked = 1 AND (i.status = 'ACTIVE' OR mv.item_id IS NOT NULL)
        ORDER BY i.code COLLATE NOCASE`,
    ).all(asAt) as any[];
    for (const i of items) i.average_cost = i.quantity_on_hand > 1e-9 ? Math.round(i.total_value / i.quantity_on_hand) : 0;
  } else {
    items = db.prepare(
      `SELECT code, name, quantity_on_hand, average_cost, total_value, reorder_point
         FROM items
        WHERE is_tracked = 1 AND (status = 'ACTIVE' OR total_value != 0 OR quantity_on_hand != 0)
        ORDER BY code COLLATE NOCASE`,
    ).all() as any[];
  }
  const rows = items.map((i) => ({
    code: i.code,
    name: i.name,
    quantity: i.quantity_on_hand,
    average_cost: i.average_cost,
    total_value: i.total_value,
    reorder_point: i.reorder_point,
    low: i.reorder_point != null && i.quantity_on_hand < i.reorder_point,
  }));
  return {
    as_at: asAt ?? today(),
    historical,
    rows,
    total_value: rows.reduce((s, r) => s + (r.total_value || 0), 0),
    total_quantity: rows.reduce((s, r) => s + (r.quantity || 0), 0),
    low_count: rows.filter((r) => r.low).length,
  };
}

/**
 * Customer statement — a document you can print or send to a customer.
 *   OUTSTANDING (open-item): every unpaid invoice / unapplied credit note as at
 *     a date, with ageing and the total owed.
 *   ACTIVITY (balance-forward): opening balance, every transaction in a period
 *     with a running balance, and the closing balance.
 * Both read the receivables sub-ledger for the contact, so they reconcile to the
 * Accounts Receivable control.
 */
export function customerStatement(params: { contact_id: number; type?: 'OUTSTANDING' | 'ACTIVITY'; as_at?: string; from?: string; to?: string }) {
  const db = getDb();
  const contact: any = db.prepare('SELECT id, name, email FROM contacts WHERE id = ?').get(params.contact_id);
  if (!contact) throw new Error('Contact not found');
  const arId = (() => { try { return systemAccount('AR'); } catch { return 0; } })();
  const type = params.type ?? 'OUTSTANDING';
  const org: any = db.prepare('SELECT trading_name, legal_name FROM organisations LIMIT 1').get() || {};
  const org_name = org.trading_name || org.legal_name || null;

  if (type === 'ACTIVITY') {
    const from = params.from; const to = params.to ?? today();
    if (!from) throw new Error('An activity statement needs a from date');
    const opening = (db.prepare(
      `SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS bal
         FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
        WHERE jl.account_id = ? AND jl.contact_id = ? AND j.status = 'POSTED' AND j.date < ?`
    ).get(arId, params.contact_id, from) as any).bal as number;
    const txns = db.prepare(
      `SELECT j.date, j.narration, j.source_type, jl.debit, jl.credit, inv.invoice_number, inv.type AS inv_type
         FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
         LEFT JOIN invoices inv ON j.source_type = 'INVOICE' AND inv.id = j.source_id
        WHERE jl.account_id = ? AND jl.contact_id = ? AND j.status = 'POSTED' AND j.date >= ? AND j.date <= ?
        ORDER BY j.date, j.id`
    ).all(arId, params.contact_id, from, to) as any[];
    let running = opening;
    const lines = txns.map((t) => {
      running += (t.debit - t.credit);
      const label = t.inv_type === 'ACCREC' ? 'Invoice' : t.inv_type === 'ACCRECCREDIT' ? 'Credit note'
        : t.source_type === 'PAYMENT' ? 'Payment' : (t.narration || 'Journal');
      return {
        date: t.date,
        type: label,
        reference: t.invoice_number || null,
        description: t.narration || null,
        debit: t.debit as number,
        credit: t.credit as number,
        balance: running,
      };
    });
    return { type, contact, org_name, from, to, opening_balance: opening, closing_balance: running, lines };
  }

  // OUTSTANDING (open-item)
  const asAt = params.as_at ?? today();
  // Balance as OF the statement date, reconstructed from payments/credits dated
  // on or before asAt (not the live amount_due column) so a back-dated statement
  // is correct and ties to the AR control.
  const docs = (db.prepare(
    `SELECT i.id, i.invoice_number, i.type, i.date, i.due_date, i.total,
            ( i.total
              - COALESCE((SELECT SUM(pa.amount) FROM payment_allocations pa JOIN payments p ON p.id = pa.payment_id
                          WHERE pa.invoice_id = i.id AND p.status = 'POSTED' AND p.date <= ?), 0)
              - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca WHERE ca.target_invoice_id = i.id AND ca.date <= ?), 0)
              - COALESCE((SELECT SUM(ca.amount) FROM credit_allocations ca WHERE ca.credit_invoice_id = i.id AND ca.date <= ?), 0)
            ) AS amount_due
       FROM invoices i
      WHERE i.contact_id = ? AND i.type IN ('ACCREC','ACCRECCREDIT') AND i.status IN ('AUTHORISED','PAID') AND i.date <= ?
      ORDER BY COALESCE(i.due_date, i.date), i.date`
  ).all(asAt, asAt, asAt, params.contact_id, asAt) as any[]).filter((d) => d.amount_due !== 0);
  const bucketOf = (days: number) => (days <= 0 ? 'current' : days <= 30 ? 'd1_30' : days <= 60 ? 'd31_60' : days <= 90 ? 'd61_90' : 'd90_plus');
  const aging = { current: 0, d1_30: 0, d31_60: 0, d61_90: 0, d90_plus: 0 } as Record<string, number>;
  let total = 0;
  const lines = docs.map((d) => {
    const signed = d.type === 'ACCRECCREDIT' ? -d.amount_due : d.amount_due;
    const due = d.due_date ?? d.date;
    const days = Math.floor((Date.parse(asAt) - Date.parse(due)) / 86400000);
    aging[bucketOf(days)] += signed;
    total += signed;
    return {
      id: d.id,
      type: d.type === 'ACCRECCREDIT' ? 'Credit note' : 'Invoice',
      reference: d.invoice_number,
      date: d.date,
      due_date: d.due_date,
      total: d.type === 'ACCRECCREDIT' ? -d.total : d.total,
      amount_due: signed,
      days_overdue: Math.max(0, days),
    };
  });
  return { type, contact, org_name, as_at: asAt, lines, total, aging };
}

/**
 * Custom summary ("build your own") report — a pivot of posted transaction
 * lines: a row per chosen dimension (account, account type, contact, source or
 * tracking option), optionally split into period columns (month/quarter/year),
 * with row totals, column totals and a grand total. Amounts use the natural
 * sign for each account's type (so income and expenses read positive), exactly
 * as the P&L and Balance Sheet do.
 *
 * Because every transaction has two or more legs, scope the report with the
 * account / type filters (e.g. income or expense accounts) for a meaningful
 * summary — it totals the lines that match the filters.
 */
export function transactionSummary(params: {
  from: string; to: string;
  group_by?: 'account' | 'account_type' | 'contact' | 'source' | 'tracking_1' | 'tracking_2';
  period?: 'none' | 'month' | 'quarter' | 'year';
  account_ids?: number[]; account_types?: string[]; contact_ids?: number[];
  source_types?: string[]; tracking_option_id?: number; search?: string;
}) {
  const db = getDb();
  const groupBy = params.group_by ?? 'account';
  const period = params.period ?? 'none';

  const cond: string[] = ["j.status = 'POSTED'", 'j.date >= ?', 'j.date <= ?'];
  const args: any[] = [params.from, params.to];
  const inClause = (col: string, vals?: any[]) => { if (vals && vals.length) { cond.push(`${col} IN (${vals.map(() => '?').join(',')})`); args.push(...vals); } };
  inClause('jl.account_id', params.account_ids);
  inClause('jl.contact_id', params.contact_ids);
  inClause('j.source_type', params.source_types);
  inClause('a.type', params.account_types);
  if (params.tracking_option_id) { cond.push('(jl.tracking_option_1 = ? OR jl.tracking_option_2 = ?)'); args.push(params.tracking_option_id, params.tracking_option_id); }
  if (params.search?.trim()) {
    cond.push('(jl.description LIKE ? OR j.narration LIKE ? OR c.name LIKE ?)');
    const q = `%${params.search.trim()}%`; args.push(q, q, q);
  }

  const lines = db.prepare(
    `SELECT j.date, jl.debit, jl.credit, a.type AS account_type, a.code AS account_code, a.name AS account_name,
            jl.contact_id, c.name AS contact_name, j.source_type, t1.name AS tracking_1, t2.name AS tracking_2
       FROM journal_lines jl
       JOIN journals j ON j.id = jl.journal_id
       JOIN accounts a ON a.id = jl.account_id
       LEFT JOIN contacts c ON c.id = jl.contact_id
       LEFT JOIN tracking_options t1 ON t1.id = jl.tracking_option_1
       LEFT JOIN tracking_options t2 ON t2.id = jl.tracking_option_2
      WHERE ${cond.join(' AND ')}`
  ).all(...args) as any[];

  const periodOf = (iso: string): { key: string; label: string } => {
    if (period === 'none') return { key: 'total', label: 'Total' };
    const y = iso.slice(0, 4); const m = Number(iso.slice(5, 7));
    if (period === 'year') return { key: y, label: y };
    if (period === 'quarter') { const q = Math.floor((m - 1) / 3) + 1; return { key: `${y}-Q${q}`, label: `${y} Q${q}` }; }
    const d = new Date(iso + 'T00:00:00');
    return { key: iso.slice(0, 7), label: isNaN(d.getTime()) ? iso.slice(0, 7) : d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' }) };
  };
  // Continuous period columns across the range.
  const periods: Array<{ key: string; label: string }> = [];
  if (period === 'none') periods.push({ key: 'total', label: 'Total' });
  else {
    const seen = new Set<string>();
    let d = new Date(params.from.slice(0, 7) + '-01T00:00:00');
    const end = new Date(params.to + 'T00:00:00');
    while (d <= end) {
      const pk = periodOf(d.toISOString().slice(0, 10));
      if (!seen.has(pk.key)) { seen.add(pk.key); periods.push(pk); }
      d.setMonth(d.getMonth() + 1);
    }
  }

  const SRC: Record<string, string> = { INVOICE: 'Invoice / bill', PAYMENT: 'Payment', BANKTXN: 'Bank transaction', MANUAL: 'Manual journal', CONVERSION: 'Opening balances', FX: 'FX revaluation', GST_PAYMENT: 'GST payment', EXPENSE_CLAIM: 'Expense claim', EXPENSE_CLAIM_PAYMENT: 'Expense reimbursement' };
  const rowKeyLabel = (l: any): { key: string; label: string } => {
    switch (groupBy) {
      case 'account_type': return { key: l.account_type, label: l.account_type };
      case 'contact': return { key: String(l.contact_id ?? 'none'), label: l.contact_name ?? '(no contact)' };
      case 'source': return { key: l.source_type, label: SRC[l.source_type] ?? l.source_type };
      case 'tracking_1': return { key: l.tracking_1 ?? '(untagged)', label: l.tracking_1 ?? '(untagged)' };
      case 'tracking_2': return { key: l.tracking_2 ?? '(untagged)', label: l.tracking_2 ?? '(untagged)' };
      default: return { key: `${l.account_code} ${l.account_name}`, label: `${l.account_code} ${l.account_name}` };
    }
  };

  const rowMap = new Map<string, { key: string; label: string; cells: Record<string, number>; total: number }>();
  const colTotals: Record<string, number> = {};
  let grand = 0;
  for (const p of periods) colTotals[p.key] = 0;
  for (const l of lines) {
    const amt = natural(l.account_type, l.debit, l.credit);
    if (amt === 0) continue;
    const rk = rowKeyLabel(l);
    const pk = periodOf(l.date).key;
    let row = rowMap.get(rk.key);
    if (!row) { row = { key: rk.key, label: rk.label, cells: {}, total: 0 }; for (const p of periods) row.cells[p.key] = 0; rowMap.set(rk.key, row); }
    row.cells[pk] = (row.cells[pk] ?? 0) + amt;
    row.total += amt;
    colTotals[pk] = (colTotals[pk] ?? 0) + amt;
    grand += amt;
  }
  const rows = [...rowMap.values()].sort((a, b) => a.label.localeCompare(b.label));
  return { from: params.from, to: params.to, group_by: groupBy, period, periods, rows, column_totals: colTotals, grand_total: grand };
}
