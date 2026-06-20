import * as reports from './reports';
/** Dashboard aggregates: bank balances, AR/AP totals, P&L snapshot, cashflow chart. */
import { getDb } from '../db';
import { baseCurrency, today } from '../engine';
import { profitAndLoss } from './reports';

export function summary() {
  const tb = reports.trialBalance({ as_at: '9999-12-31' });
  const ledger_balanced = tb.total_debit === tb.total_credit;
  const db = getDb();
  const asAt = today();

  const banks = db
    .prepare(
      `SELECT a.id, a.code, a.name, a.bank_currency,
              COALESCE((SELECT SUM(jl.debit - jl.credit) FROM journal_lines jl
                        JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
                        WHERE jl.account_id = a.id), 0) AS balance,
              (SELECT COUNT(*) FROM bank_statement_lines s WHERE s.bank_account_id = a.id AND s.status = 'UNRECONCILED') AS unreconciled
       FROM accounts a WHERE a.is_bank_account = 1 AND a.status = 'ACTIVE' ORDER BY a.code`
    )
    .all();

  const inv = (type: string) =>
    db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(amount_due),0) AS total,
                COALESCE(SUM(CASE WHEN due_date < ? THEN amount_due ELSE 0 END),0) AS overdue
         FROM invoices WHERE type = ? AND status = 'AUTHORISED' AND amount_due > 0`
      )
      .get(asAt, type);

  const ar = inv('ACCREC');
  const ap = inv('ACCPAY');

  const draftCounts = db
    .prepare(
      `SELECT type, COUNT(*) AS n FROM invoices WHERE status IN ('DRAFT','SUBMITTED') GROUP BY type`
    )
    .all();

  // P&L this month and financial-year-to-date
  const now = new Date();
  const monthStart = `${asAt.slice(0, 7)}-01`;
  const org = db.prepare('SELECT financial_year_end_month AS m, financial_year_end_day AS d FROM organisations WHERE id = 1').get();
  const fyEndMonth = org?.m ?? 12;
  // FY starts the day after FY end of previous cycle
  let fyStartYear = now.getFullYear();
  const fyStartMonth = (fyEndMonth % 12) + 1;
  if (now.getMonth() + 1 < fyStartMonth) fyStartYear -= 1;
  const fyStart = `${fyStartYear}-${String(fyStartMonth).padStart(2, '0')}-01`;

  const plMonth = profitAndLoss({ from: monthStart, to: asAt });
  const plFy = profitAndLoss({ from: fyStart, to: asAt });

  // Cash in/out per month, last 6 months
  const months: { month: string; cash_in: number; cash_out: number }[] = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const m = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const row = db
      .prepare(
        `SELECT COALESCE(SUM(jl.debit),0) AS cash_in, COALESCE(SUM(jl.credit),0) AS cash_out
         FROM journal_lines jl
         JOIN accounts a ON a.id = jl.account_id AND a.is_bank_account = 1
         JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
         WHERE substr(j.date, 1, 7) = ?`
      )
      .get(m);
    months.push({ month: m, cash_in: Number(row?.cash_in ?? 0), cash_out: Number(row?.cash_out ?? 0) });
  }

  const recentActivity = db
    .prepare(`SELECT a.*, u.name AS user_name FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 8`)
    .all();

  return {
    ledger_balanced,
    as_at: asAt,
    currency: baseCurrency(),
    banks,
    total_cash: banks.reduce((s: number, b: any) => s + b.balance, 0),
    receivables: ar,
    payables: ap,
    drafts: Object.fromEntries(draftCounts.map((d: any) => [d.type, d.n])),
    pl_month: { from: monthStart, income: plMonth.total_income, expenses: plMonth.total_cogs + plMonth.total_expenses, net: plMonth.net_profit },
    pl_fy: { from: fyStart, income: plFy.total_income, expenses: plFy.total_cogs + plFy.total_expenses, net: plFy.net_profit },
    cash_by_month: months,
    recent_activity: recentActivity,
  };
}


/**
 * First-run setup status. Each step reports whether it's done, derived from
 * actual data — so the onboarding checklist disappears naturally as the book
 * gets used, and never nags about something already handled.
 */
export function setupStatus() {
  const db = getDb();
  const org: any = db.prepare('SELECT legal_name, trading_name FROM organisations WHERE id = 1').get() ?? {};
  const orgNamed = !!(org.trading_name?.trim() || (org.legal_name?.trim() && org.legal_name.trim().toLowerCase() !== 'my company'));
  const taxRates = Number(db.prepare("SELECT COUNT(*) AS n FROM tax_rates WHERE status = 'ACTIVE'").get().n);
  const bankAccounts = Number(db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE is_bank_account = 1 AND status = 'ACTIVE'").get().n);
  const contacts = Number(db.prepare("SELECT COUNT(*) AS n FROM contacts WHERE status = 'ACTIVE'").get().n);
  const anyInvoice = Number(db.prepare("SELECT COUNT(*) AS n FROM invoices WHERE status != 'DELETED'").get().n);
  const conversionDone = Number(db.prepare("SELECT COUNT(*) AS n FROM manual_journals WHERE status = 'POSTED'").get().n) > 0 || anyInvoice > 0;

  const steps = [
    { id: 'org', label: 'Name your organisation', done: orgNamed, nav: 'settings', hint: 'Set your business name so it appears on invoices and reports.' },
    { id: 'tax', label: 'Check your tax rates', done: taxRates > 0, nav: 'settings', hint: 'Make sure the tax rates you charge are set up.' },
    { id: 'bank', label: 'Add a bank account', done: bankAccounts > 0, nav: 'coa', hint: 'Add the bank account(s) you transact through.' },
    { id: 'contact', label: 'Add your first contact', done: contacts > 0, nav: 'contacts', hint: 'Add a customer or supplier to bill or pay.' },
    { id: 'invoice', label: 'Create your first invoice or bill', done: anyInvoice > 0, nav: 'sales', hint: 'Raise an invoice or enter a bill to get going.' },
    { id: 'opening', label: 'Enter opening balances (optional)', done: conversionDone, optional: true, nav: 'journals', hint: 'If you’re switching from another system, bring in your opening balances with a manual journal.' },
  ];
  const required = steps.filter((s) => !s.optional);
  const doneCount = required.filter((s) => s.done).length;
  return {
    steps,
    done_count: doneCount,
    total: required.length,
    complete: doneCount === required.length,
  };
}
