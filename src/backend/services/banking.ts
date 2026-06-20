/**
 * Banking (spec §7): statement import (CSV/OFX) with hash dedupe, the
 * reconciliation loop (match / create / transfer), bank rules, and
 * spend/receive-money transactions.
 */
import { createHash } from 'node:crypto';
import { getDb } from '../db';
import { postJournal, voidJournalsForSource, audit, baseCurrency, systemAccount, taxComponents, assertValidDate, assertDateUnlocked } from '../engine';

const CONTROL_ACCOUNTS = ['AR', 'AP', 'GST', 'RETAINED_EARNINGS', 'ROUNDING', 'UNREALISED_FX', 'REALISED_FX', 'CUSTOMER_PREPAYMENT', 'SUPPLIER_PREPAYMENT'];
function assertNoControlAccounts(lines: Array<{ account_id: number }>) {
  const ids = lines.map((l) => l.account_id).filter(Boolean);
  if (!ids.length) return;
  const hit = getDb().prepare(
    `SELECT code, name FROM accounts WHERE id IN (${ids.map(() => '?').join(',')})
       AND system_account IN (${CONTROL_ACCOUNTS.map(() => '?').join(',')}) LIMIT 1`
  ).get(...ids, ...CONTROL_ACCOUNTS) as { code: string; name: string } | undefined;
  if (hit) throw new Error(`"${hit.code} ${hit.name}" is a control account and is posted automatically — it can't be used on a line.`);
}
import { calcDocument, LineAmountType } from '../tax';
import { parseCents } from '../money';
import * as invoices from './invoices';
import * as payments from './payments';

// ── Bank accounts overview ─────────────────────────────────────────────────

export function accounts() {
  const db = getDb();
  return db
    .prepare(
      `SELECT a.id, a.code, a.name, a.bank_currency, a.bank_account_number,
        COALESCE((SELECT SUM(l.debit) - SUM(l.credit) FROM journal_lines l JOIN journals j ON j.id=l.journal_id AND j.status='POSTED' WHERE l.account_id = a.id), 0) AS ledger_balance,
        (SELECT COUNT(*) FROM bank_statement_lines s WHERE s.bank_account_id = a.id AND s.status = 'UNRECONCILED') AS unreconciled,
        (SELECT MAX(date) FROM bank_statement_lines s WHERE s.bank_account_id = a.id) AS last_statement_date
       FROM accounts a WHERE a.is_bank_account = 1 AND a.status = 'ACTIVE' ORDER BY a.code`
    )
    .all();
}

// ── Statement import ───────────────────────────────────────────────────────

function lineHash(bankAccountId: number, date: string, amount: number, payee: string, ordinal: number): string {
  return createHash('sha256').update(`${bankAccountId}|${date}|${amount}|${payee}|${ordinal}`).digest('hex');
}

export interface ParsedStatementLine { date: string; amount: number; payee?: string; reference?: string; description?: string }

/** CSV: expects Date, Amount, Payee, Description (header row, flexible names). */
export function parseCsv(text: string): ParsedStatementLine[] {
  const rows = csvRows(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const col = (...names: string[]) => header.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = col('date');
  const iAmount = col('amount', 'value');
  const iDebit = col('debit', 'withdrawal', 'money out', 'paid out', 'spent', 'dr amount');
  const iCredit = col('credit', 'deposit', 'money in', 'paid in', 'received', 'cr amount');
  const iPayee = col('payee', 'name', 'merchant');
  const iDesc = col('description', 'memo', 'details', 'narrative', 'particulars');
  const iRef = col('reference', 'ref');
  const hasDebitCredit = iDebit >= 0 || iCredit >= 0;
  if (iDate < 0) throw new Error('CSV needs a Date column');
  if (iAmount < 0 && !hasDebitCredit) throw new Error('CSV needs either an Amount column, or Debit/Credit columns');

  // Disambiguate the date format from the whole column up front.
  const order = detectDateOrder(rows.slice(1).map((r) => r[iDate] ?? ''));

  const out: ParsedStatementLine[] = [];
  for (const r of rows.slice(1)) {
    if (!r[iDate]?.trim()) continue;
    let amount: number;
    if (iAmount >= 0 && r[iAmount]?.trim()) {
      amount = parseCents(r[iAmount]);
    } else {
      // Debit reduces the balance (negative); credit increases it (positive).
      const debit = iDebit >= 0 && r[iDebit]?.trim() ? Math.abs(parseCents(r[iDebit])) : 0;
      const credit = iCredit >= 0 && r[iCredit]?.trim() ? Math.abs(parseCents(r[iCredit])) : 0;
      if (!debit && !credit) continue; // blank row
      amount = credit - debit;
    }
    out.push({
      date: normaliseDate(r[iDate], order),
      amount,
      payee: iPayee >= 0 ? r[iPayee]?.trim() : undefined,
      description: iDesc >= 0 ? r[iDesc]?.trim() : undefined,
      reference: iRef >= 0 ? r[iRef]?.trim() : undefined,
    });
  }
  return out;
}

/** Parse without saving — used by the import preview. */
export function previewStatement(fileName: string, content: string) {
  const lines = /\.(ofx|qfx)$/i.test(fileName) || /<OFX>/i.test(content) ? parseOfx(content) : parseCsv(content);
  const credits = lines.filter((l) => l.amount > 0);
  const debits = lines.filter((l) => l.amount < 0);
  const sum = (a: ParsedStatementLine[]) => a.reduce((s, l) => s + l.amount, 0);
  const dates = lines.map((l) => l.date).filter(Boolean).sort();
  return {
    total: lines.length,
    money_in: sum(credits),
    money_out: sum(debits),
    net: sum(lines),
    from: dates[0] ?? null,
    to: dates[dates.length - 1] ?? null,
    sample: lines.slice(0, 12),
  };
}

function csvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') inQ = false;
      else cell += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x !== '')) rows.push(row);
  return rows;
}

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
};

export type DateOrder = 'DMY' | 'MDY' | 'YMD';

/**
 * Detect whether a column of dd/mm/yy-style dates is day-first or month-first.
 * If any value has its first number > 12 it must be day-first (DMY); if any
 * has its *second* number > 12 it must be month-first (MDY). Banks are
 * regional and inconsistent, so we look across the whole column rather than
 * guessing from one row.
 */
export function detectDateOrder(samples: string[]): DateOrder {
  let dmy = false; let mdy = false; let iso = false;
  for (const s of samples) {
    const t = (s || '').trim();
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(t)) { iso = true; continue; }
    const m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(t);
    if (!m) continue;
    const a = +m[1]; const b = +m[2];
    if (a > 12) dmy = true;
    if (b > 12) mdy = true;
  }
  if (dmy && !mdy) return 'DMY';
  if (mdy && !dmy) return 'MDY';
  if (iso && !dmy && !mdy) return 'YMD';
  return 'DMY'; // ambiguous → most banks worldwide are day-first
}

function normaliseDate(s: string, order: DateOrder = 'DMY'): string {
  const t = s.trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  if (/^\d{4}\/\d{1,2}\/\d{1,2}$/.test(t)) {
    const [y, mo, d] = t.split('/');
    return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  // 12 Mar 2026 / 12-Mar-26 / Mar 12, 2026
  let m = /^(\d{1,2})[ \-]([A-Za-z]{3,})[ \-](\d{2,4})$/.exec(t);
  if (m) { const mo = MONTHS[m[2].slice(0, 3).toLowerCase()]; if (mo) return `${full(m[3])}-${mo}-${m[1].padStart(2, '0')}`; }
  m = /^([A-Za-z]{3,})[ \-](\d{1,2}),?[ \-](\d{2,4})$/.exec(t);
  if (m) { const mo = MONTHS[m[1].slice(0, 3).toLowerCase()]; if (mo) return `${full(m[3])}-${mo}-${m[2].padStart(2, '0')}`; }
  m = /^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/.exec(t);
  if (m) {
    const y = full(m[3]);
    const first = m[1].padStart(2, '0'); const second = m[2].padStart(2, '0');
    const [mo, d] = order === 'MDY' ? [first, second] : [second, first];
    return `${y}-${mo}-${d}`;
  }
  m = /^(\d{8})$/.exec(t); // YYYYMMDD (OFX)
  if (m) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  throw new Error(`Unrecognised date: "${s}"`);
}

function full(yr: string): string { return yr.length === 2 ? `20${yr}` : yr; }

/** Minimal OFX/QFX parser: <STMTTRN> blocks with DTPOSTED, TRNAMT, NAME/MEMO. */
export function parseOfx(text: string): ParsedStatementLine[] {
  const out: ParsedStatementLine[] = [];
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  for (const b of blocks) {
    const tag = (name: string) => {
      const m = new RegExp(`<${name}>([^<\\r\\n]*)`, 'i').exec(b);
      return m ? m[1].trim() : undefined;
    };
    const date = tag('DTPOSTED');
    const amt = tag('TRNAMT');
    if (!date || !amt) continue;
    out.push({
      date: normaliseDate(date.slice(0, 8)),
      amount: parseCents(amt),
      payee: tag('NAME'),
      description: tag('MEMO'),
      reference: tag('FITID'),
    });
  }
  return out;
}

/**
 * A downloadable CSV template for bank-statement import, showing the columns
 * and a couple of example rows. The importer is flexible: a single Amount
 * column (positive = money in, negative = money out) is simplest, but it also
 * accepts separate Debit/Credit (or Withdrawal/Deposit) columns that many banks
 * export — see statementTemplateDebitCredit(). Dates can be in most common
 * formats; the importer detects the order from the whole column.
 */
export function statementTemplate() {
  return [
    'Date,Amount,Payee,Description,Reference',
    '2026-06-01,2500.00,Acme Customer,Invoice payment received,INV-1001',
    '2026-06-03,-49.90,Cloud Hosting Ltd,Monthly subscription,',
    '2026-06-05,-1200.00,Property Co,June office rent,RENT-06',
  ].join('\n');
}

/** Alternative template using separate Debit/Credit columns (as many banks export). */
export function statementTemplateDebitCredit() {
  return [
    'Date,Description,Reference,Debit,Credit',
    '2026-06-01,Invoice payment received,INV-1001,,2500.00',
    '2026-06-03,Monthly subscription,,49.90,',
    '2026-06-05,June office rent,RENT-06,1200.00,',
  ].join('\n');
}

export function importStatement(bankAccountId: number, fileName: string, content: string, user_id = 1) {
  const lines = /\.(ofx|qfx)$/i.test(fileName) || /<OFX>/i.test(content) ? parseOfx(content) : parseCsv(content);
  const r = ingestStatementLines(bankAccountId, lines);
  audit('bank_account', bankAccountId, 'IMPORT', null, { file: fileName, imported: r.imported, duplicates: r.duplicates }, user_id);
  return { ...r, total: lines.length };
}

/**
 * Insert statement lines with de-duplication, shared by CSV/OFX import and by
 * live bank feeds so both behave identically. Duplicates (same account, date,
 * amount, payee and position) are skipped via a content hash.
 */
export function ingestStatementLines(bankAccountId: number, lines: ParsedStatementLine[]) {
  const db = getDb();
  let imported = 0;
  let duplicates = 0;
  db.transaction(() => {
    const seen = new Map<string, number>();
    const ins = db.prepare(
      `INSERT INTO bank_statement_lines (bank_account_id, date, amount, payee, reference, description, imported_hash) VALUES (?,?,?,?,?,?,?)`
    );
    for (const l of lines) {
      const key = `${l.date}|${l.amount}|${l.payee ?? ''}`;
      const ordinal = (seen.get(key) ?? 0) + 1; // allow identical same-day duplicates within one batch
      seen.set(key, ordinal);
      const hash = lineHash(bankAccountId, l.date, l.amount, l.payee ?? '', ordinal);
      const exists = db.prepare('SELECT 1 FROM bank_statement_lines WHERE imported_hash = ?').get(hash);
      if (exists) { duplicates++; continue; }
      ins.run(bankAccountId, l.date, l.amount, l.payee ?? null, l.reference ?? null, l.description ?? null, hash);
      imported++;
    }
  });
  return { imported, duplicates };
}

// ── Reconciliation ─────────────────────────────────────────────────────────

export function unreconciled(bankAccountId: number) {
  const db = getDb();
  const lines = db
    .prepare(`SELECT * FROM bank_statement_lines WHERE bank_account_id = ? AND status='UNRECONCILED' ORDER BY date, id`)
    .all(bankAccountId);
  return lines.map((l: any) => ({ ...l, suggestion: suggestFor(l), rule: matchRule(l) }));
}

/** Suggest unreconciled ledger candidates with the same amount. */
function suggestFor(line: any) {
  const db = getDb();
  const candidates: any[] = [];
  // Payments not yet reconciled to any line, same bank account, same signed amount
  const pays = db.prepare(
    `SELECT p.id, p.date, p.reference, p.amount, p.type, c.name AS contact_name FROM payments p
     LEFT JOIN contacts c ON c.id = p.contact_id
     WHERE p.bank_account_id = ? AND p.status='POSTED'
       AND p.id NOT IN (SELECT reconciled_source_id FROM bank_statement_lines WHERE reconciled_source_type='PAYMENT' AND reconciled_source_id IS NOT NULL)
       AND ((? > 0 AND p.type='RECEIVE' AND p.amount = ?) OR (? < 0 AND p.type='SPEND' AND p.amount = ?))`
  ).all(line.bank_account_id, line.amount, Math.abs(line.amount), line.amount, Math.abs(line.amount));
  for (const p of pays) candidates.push({ kind: 'PAYMENT', ...p });
  const txns = db.prepare(
    `SELECT b.id, b.date, b.reference, b.total AS amount, b.type, c.name AS contact_name FROM bank_transactions b
     LEFT JOIN contacts c ON c.id = b.contact_id
     WHERE b.bank_account_id = ? AND b.status='POSTED'
       AND b.id NOT IN (SELECT reconciled_source_id FROM bank_statement_lines WHERE reconciled_source_type='BANKTXN' AND reconciled_source_id IS NOT NULL)
       AND ((? > 0 AND b.type='RECEIVE' AND b.total = ?) OR (? < 0 AND b.type='SPEND' AND b.total = ?))`
  ).all(line.bank_account_id, line.amount, Math.abs(line.amount), line.amount, Math.abs(line.amount));
  for (const t of txns) candidates.push({ kind: 'BANKTXN', ...t });
  // Open invoices/bills with exactly this amount due (offer to create the payment)
  const open = db.prepare(
    `SELECT i.id, i.invoice_number, i.date, i.amount_due, i.type, c.name AS contact_name FROM invoices i JOIN contacts c ON c.id=i.contact_id
     WHERE i.status='AUTHORISED' AND ((? > 0 AND i.type='ACCREC' AND i.amount_due = ?) OR (? < 0 AND i.type='ACCPAY' AND i.amount_due = ?)) LIMIT 3`
  ).all(line.amount, Math.abs(line.amount), line.amount, Math.abs(line.amount));
  for (const i of open) candidates.push({ kind: 'INVOICE', ...i });
  return candidates.slice(0, 4);
}

function matchRule(line: any) {
  const db = getDb();
  const rules = db.prepare('SELECT * FROM bank_rules ORDER BY priority DESC, id').all();
  const dir = line.amount >= 0 ? 'RECEIVE' : 'SPEND';
  for (const r of rules) {
    if (r.direction && r.direction !== dir) continue;
    let conds: any = {};
    try { conds = JSON.parse(r.conditions_json ?? '{}'); } catch { /* ignore */ }
    const hay = `${line.payee ?? ''} ${line.description ?? ''} ${line.reference ?? ''}`.toLowerCase();
    if (conds.payee_contains && !hay.includes(String(conds.payee_contains).toLowerCase())) continue;
    if (conds.min_amount != null && Math.abs(line.amount) < conds.min_amount) continue;
    if (conds.max_amount != null && Math.abs(line.amount) > conds.max_amount) continue;
    return { id: r.id, name: r.name, set_contact_id: r.set_contact_id, set_account_id: r.set_account_id, set_tax_rate_id: r.set_tax_rate_id };
  }
  return null;
}

/** Option 1 — Match: link the statement line to an existing payment/bank transaction. */
export function reconcileMatch(statementLineId: number, sourceType: 'PAYMENT' | 'BANKTXN', sourceId: number, user_id = 1) {
  const db = getDb();
  const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(statementLineId);
  if (!line || line.status !== 'UNRECONCILED') throw new Error('Statement line not found or already reconciled');

  // The matched source must be POSTED, on the SAME bank account, and move the
  // SAME signed amount as the statement line. Without this, a line could be
  // reconciled to a source of any amount/account, silently diverging the ledger
  // from the bank statement.
  let srcSigned: number;
  let srcAccount: number;
  if (sourceType === 'PAYMENT') {
    const p = db.prepare('SELECT bank_account_id, amount, type, status FROM payments WHERE id = ?').get(sourceId) as any;
    if (!p || p.status !== 'POSTED') throw new Error('Payment not found or not posted');
    srcSigned = p.type === 'RECEIVE' ? p.amount : -p.amount;
    srcAccount = p.bank_account_id;
  } else {
    const b = db.prepare('SELECT bank_account_id, total, type, status FROM bank_transactions WHERE id = ?').get(sourceId) as any;
    if (!b || b.status !== 'POSTED') throw new Error('Bank transaction not found or not posted');
    srcSigned = b.type === 'RECEIVE' ? b.total : -b.total;
    srcAccount = b.bank_account_id;
  }
  if (srcAccount !== line.bank_account_id) throw new Error('That transaction belongs to a different bank account');
  if (srcSigned !== line.amount) {
    throw new Error(`Amount mismatch: the statement line is ${line.amount} but the selected ${sourceType.toLowerCase()} is ${srcSigned} (cents)`);
  }
  // A given source may be reconciled to at most one statement line (also
  // enforced by a partial unique index).
  const dup = db.prepare("SELECT id FROM bank_statement_lines WHERE reconciled_source_type=? AND reconciled_source_id=? AND status='RECONCILED'").get(sourceType, sourceId);
  if (dup) throw new Error('That transaction is already reconciled to another statement line');

  db.prepare(`UPDATE bank_statement_lines SET status='RECONCILED', reconciled_source_type=?, reconciled_source_id=?, reconciled_at=datetime('now') WHERE id=?`)
    .run(sourceType, sourceId, statementLineId);
  audit('bank_statement_line', statementLineId, 'RECONCILE_MATCH', null, { sourceType, sourceId }, user_id);
}

/** Option 2 — Create: spend/receive money posted and reconciled in one go. */
export function reconcileCreate(
  statementLineId: number,
  input: { contact_id?: number; account_id: number; tax_rate_id?: number | null; description?: string; line_amount_type?: LineAmountType; tracking_option_1?: number | null; tracking_option_2?: number | null },
  user_id = 1
) {
  const db = getDb();
  return db.transaction(() => {
    const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(statementLineId);
    if (!line || line.status !== 'UNRECONCILED') throw new Error('Statement line not found or already reconciled');
    const txn = createBankTransaction({
      type: line.amount >= 0 ? 'RECEIVE' : 'SPEND',
      bank_account_id: line.bank_account_id,
      contact_id: input.contact_id,
      date: line.date,
      reference: line.reference ?? line.payee,
      line_amount_type: input.line_amount_type ?? 'INCLUSIVE', // statement amounts are tax-inclusive by nature
      lines: [{
        description: input.description ?? line.description ?? line.payee ?? 'Bank transaction',
        quantity: 1, unit_amount: Math.abs(line.amount),
        account_id: input.account_id, tax_rate_id: input.tax_rate_id ?? null,
        tracking_option_1: input.tracking_option_1 ?? null, tracking_option_2: input.tracking_option_2 ?? null,
      }],
    }, user_id);
    reconcileMatch(statementLineId, 'BANKTXN', txn.id, user_id);
    return txn;
  });
}

/** Option 2b — Create a payment against an open invoice/bill and reconcile. */
export function reconcilePayInvoice(statementLineId: number, invoiceId: number, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(statementLineId);
    if (!line || line.status !== 'UNRECONCILED') throw new Error('Statement line not found or already reconciled');
    const inv = db.prepare('SELECT * FROM invoices WHERE id = ?').get(invoiceId);
    if (!inv) throw new Error('Invoice not found');
    const p = payments.create({
      type: line.amount >= 0 ? 'RECEIVE' : 'SPEND',
      date: line.date, bank_account_id: line.bank_account_id, contact_id: inv.contact_id,
      amount: Math.abs(line.amount), reference: line.payee ?? inv.invoice_number,
      allocations: [{ invoice_id: invoiceId, amount: Math.abs(line.amount) }],
    }, user_id);
    reconcileMatch(statementLineId, 'PAYMENT', p.id, user_id);
    return p;
  });
}

/** Option 3 — Transfer between two of the org's own bank accounts. */
/**
 * Record an internal transfer of money between two of your own bank accounts.
 * Posts a single balanced journal (debit the destination, credit the source),
 * so no income or expense is recognised — it's just money moving. Supports a
 * different received amount for cross-currency transfers (the difference is
 * booked to realised FX so the journal still balances).
 */
export function createTransfer(input: {
  date: string;
  from_account_id: number;
  to_account_id: number;
  amount: number;            // amount leaving the source account, in cents
  to_amount?: number;        // amount arriving (cross-currency); defaults to amount
  reference?: string;
}, user_id = 1): number {
  const db = getDb();

  // ── Validations ──
  assertValidDate(input.date, 'Transfer date');
  assertDateUnlocked(input.date);
  if (!input.from_account_id || !input.to_account_id) throw new Error('Choose both a "from" and a "to" account');
  if (input.from_account_id === input.to_account_id) throw new Error('The "from" and "to" accounts must be different');
  if (!Number.isFinite(input.amount) || input.amount <= 0) throw new Error('Enter an amount greater than zero');
  const toAmount = input.to_amount ?? input.amount;
  if (!Number.isFinite(toAmount) || toAmount <= 0) throw new Error('The received amount must be greater than zero');

  const from: any = db.prepare("SELECT id, name, is_bank_account FROM accounts WHERE id = ? AND status = 'ACTIVE'").get(input.from_account_id);
  const to: any = db.prepare("SELECT id, name, is_bank_account FROM accounts WHERE id = ? AND status = 'ACTIVE'").get(input.to_account_id);
  if (!from) throw new Error('The "from" bank account was not found');
  if (!to) throw new Error('The "to" bank account was not found');
  if (!from.is_bank_account) throw new Error(`"${from.name}" isn't a bank account`);
  if (!to.is_bank_account) throw new Error(`"${to.name}" isn't a bank account`);

  return db.transaction(() => {
    const tid = Number(db.prepare(
      'INSERT INTO bank_transfers (date, from_account_id, to_account_id, amount, to_amount, reference) VALUES (?,?,?,?,?,?)'
    ).run(input.date, from.id, to.id, input.amount, toAmount, input.reference ?? 'Transfer').lastInsertRowid);

    const lines: any[] = [
      { account_id: to.id, debit: toAmount, description: `Transfer from ${from.name}` },
      { account_id: from.id, credit: input.amount, description: `Transfer to ${to.name}` },
    ];
    // Cross-currency: balance any difference to realised FX gains/losses.
    if (toAmount !== input.amount) {
      const diff = input.amount - toAmount; // +ve: source gave more than arrived → a loss
      const fx = systemAccount('REALISED_FX');
      if (diff > 0) lines.push({ account_id: fx, debit: diff, description: 'FX on transfer' });
      else lines.push({ account_id: fx, credit: -diff, description: 'FX on transfer' });
    }
    const jid = postJournal({ date: input.date, narration: `Bank transfer — ${from.name} → ${to.name}`, source_type: 'TRANSFER', source_id: tid, lines, user_id });
    db.prepare('UPDATE bank_transfers SET journal_id = ? WHERE id = ?').run(jid, tid);
    audit('bank_transfer', tid, 'CREATE', null, { from: from.name, to: to.name, amount: input.amount, to_amount: toAmount }, user_id);
    return tid;
  });
}

export function getTransfer(id: number) {
  const db = getDb();
  const t: any = db.prepare(
    `SELECT bt.*, af.name AS from_name, af.code AS from_code, at2.name AS to_name, at2.code AS to_code
     FROM bank_transfers bt JOIN accounts af ON af.id = bt.from_account_id JOIN accounts at2 ON at2.id = bt.to_account_id
     WHERE bt.id = ?`
  ).get(id);
  if (!t) throw new Error('Transfer not found');
  return t;
}

export function listTransfers(filter: { from?: string; to?: string } = {}) {
  const db = getDb();
  const where: string[] = [];
  const args: any[] = [];
  if (filter.from) { where.push('bt.date >= ?'); args.push(filter.from); }
  if (filter.to) { where.push('bt.date <= ?'); args.push(filter.to); }
  const sql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.prepare(
    `SELECT bt.id, bt.date, bt.amount, bt.to_amount, bt.reference,
            af.name AS from_name, at2.name AS to_name
     FROM bank_transfers bt JOIN accounts af ON af.id = bt.from_account_id JOIN accounts at2 ON at2.id = bt.to_account_id
     ${sql} ORDER BY bt.date DESC, bt.id DESC`
  ).all(...args);
}

/** Void a transfer: reverse its journal. Refused if a statement line is
 *  reconciled against it (unreconcile first). */
export function voidTransfer(id: number, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const t: any = db.prepare('SELECT * FROM bank_transfers WHERE id = ?').get(id);
    if (!t) throw new Error('Transfer not found');
    const recon = db.prepare("SELECT COUNT(*) AS n FROM bank_statement_lines WHERE reconciled_source_type='TRANSFER' AND reconciled_source_id = ? AND status='RECONCILED'").get(id).n;
    if (recon > 0) throw new Error('This transfer is reconciled to a statement line — unreconcile it first.');
    assertDateUnlocked(t.date);
    voidJournalsForSource('TRANSFER', id, user_id);
    db.prepare('DELETE FROM bank_transfers WHERE id = ?').run(id);
    audit('bank_transfer', id, 'VOID', null, null, user_id);
  });
}

export function reconcileTransfer(statementLineId: number, otherBankAccountId: number, user_id = 1) {
  const db = getDb();
  return db.transaction(() => {
    const line = db.prepare('SELECT * FROM bank_statement_lines WHERE id = ?').get(statementLineId);
    if (!line || line.status !== 'UNRECONCILED') throw new Error('Statement line not found or already reconciled');
    const incoming = line.amount >= 0;
    const from = incoming ? otherBankAccountId : line.bank_account_id;
    const to = incoming ? line.bank_account_id : otherBankAccountId;
    const amount = Math.abs(line.amount);
    const tid = Number(db.prepare('INSERT INTO bank_transfers (date, from_account_id, to_account_id, amount, reference) VALUES (?,?,?,?,?)')
      .run(line.date, from, to, amount, line.reference ?? 'Transfer').lastInsertRowid);
    const jid = postJournal({
      date: line.date, narration: 'Bank transfer', source_type: 'TRANSFER', source_id: tid,
      lines: [
        { account_id: to, debit: amount, description: 'Transfer in' },
        { account_id: from, credit: amount, description: 'Transfer out' },
      ],
      user_id,
    });
    db.prepare('UPDATE bank_transfers SET journal_id = ? WHERE id = ?').run(jid, tid);
    reconcileMatch(statementLineId, 'BANKTXN' as any, tid, user_id);
    db.prepare(`UPDATE bank_statement_lines SET reconciled_source_type='TRANSFER' WHERE id = ?`).run(statementLineId);
    return tid;
  });
}

export function unreconcile(statementLineId: number, user_id = 1) {
  getDb().prepare(`UPDATE bank_statement_lines SET status='UNRECONCILED', reconciled_source_type=NULL, reconciled_source_id=NULL, reconciled_at=NULL WHERE id=?`).run(statementLineId);
  audit('bank_statement_line', statementLineId, 'UNRECONCILE', null, null, user_id);
}

// ── Spend / receive money (a bank transaction is its own journal) ──────────

export interface BankTxnInput {
  type: 'SPEND' | 'RECEIVE';
  bank_account_id: number;
  contact_id?: number;
  date: string;
  reference?: string;
  line_amount_type?: LineAmountType;
  payment_method?: string;
  cheque_number?: string;
  lines: Array<{ description: string; quantity: number; unit_amount: number; account_id: number; tax_rate_id?: number | null; tracking_option_1?: number | null; tracking_option_2?: number | null }>;
}

export function createBankTransaction(input: BankTxnInput, user_id = 1) {
  const db = getDb();
  // A real, unlocked date; positive quantities; and never a control account on a line.
  assertValidDate(input.date, 'Date');
  assertDateUnlocked(input.date);
  if (!input.lines?.length) throw new Error('Add at least one line');
  input.lines.forEach((l, i) => {
    if (l.quantity == null || !(l.quantity > 0)) throw new Error(`Line ${i + 1}: quantity must be greater than zero`);
  });
  assertNoControlAccounts(input.lines);
  return db.transaction(() => {
    const mode = input.line_amount_type ?? 'EXCLUSIVE';
    const totals = calcDocument(
      input.lines.map((l) => ({ quantity: l.quantity, unit_amount: l.unit_amount, components: taxComponents(l.tax_rate_id) })),
      mode
    );
    const id = Number(db.prepare(
      `INSERT INTO bank_transactions (type, bank_account_id, contact_id, date, reference, line_amount_type, subtotal, total_tax, total, payment_method, cheque_number, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'POSTED')`
    ).run(input.type, input.bank_account_id, input.contact_id ?? null, input.date, input.reference ?? null, mode,
      totals.subtotal, totals.total_tax, totals.total, input.payment_method ?? null, input.cheque_number ?? null).lastInsertRowid);

    const insLine = db.prepare(`INSERT INTO bank_transaction_lines (bank_transaction_id, line_order, description, quantity, unit_amount, account_id, tax_rate_id, tracking_option_1, tracking_option_2, line_amount, tax_amount) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    input.lines.forEach((l, i) => insLine.run(id, i, l.description, l.quantity, l.unit_amount, l.account_id, l.tax_rate_id ?? null, l.tracking_option_1 ?? null, l.tracking_option_2 ?? null, totals.lines[i].net, totals.lines[i].tax));

    const isSpend = input.type === 'SPEND';
    const gst = systemAccount('GST');
    const jl: any[] = [];
    // Bank gross
    jl.push(isSpend
      ? { account_id: input.bank_account_id, credit: totals.total, description: input.reference, contact_id: input.contact_id }
      : { account_id: input.bank_account_id, debit: totals.total, description: input.reference, contact_id: input.contact_id });
    input.lines.forEach((l, i) => {
      const net = totals.lines[i].net;
      const tax = totals.lines[i].tax;
      jl.push(isSpend
        ? { account_id: l.account_id, debit: net, description: l.description, tax_rate_id: l.tax_rate_id, contact_id: input.contact_id, tracking_option_1: l.tracking_option_1, tracking_option_2: l.tracking_option_2 }
        : { account_id: l.account_id, credit: net, description: l.description, tax_rate_id: l.tax_rate_id, contact_id: input.contact_id, tracking_option_1: l.tracking_option_1, tracking_option_2: l.tracking_option_2 });
      if (tax !== 0) jl.push(isSpend ? { account_id: gst, debit: tax, tax_rate_id: l.tax_rate_id } : { account_id: gst, credit: tax, tax_rate_id: l.tax_rate_id });
    });
    const jid = postJournal({
      date: input.date,
      narration: `${isSpend ? 'Spend' : 'Receive'} money — ${input.reference ?? ''}`,
      source_type: 'BANKTXN', source_id: id, lines: jl, user_id,
    });
    db.prepare('UPDATE bank_transactions SET journal_id = ? WHERE id = ?').run(jid, id);
    audit('bank_transaction', id, 'CREATE', null, { total: totals.total }, user_id);
    return db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id);
  });
}

export function voidBankTransaction(id: number, user_id = 1) {
  const db = getDb();
  db.transaction(() => {
    const t = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id);
    if (!t || t.status !== 'POSTED') throw new Error('Bank transaction not found');
    // Reversing posts into the period — respect the lock.
    assertDateUnlocked(t.date);
    db.prepare(`UPDATE bank_statement_lines SET status='UNRECONCILED', reconciled_source_type=NULL, reconciled_source_id=NULL WHERE reconciled_source_type='BANKTXN' AND reconciled_source_id=?`).run(id);
    voidJournalsForSource('BANKTXN', id, user_id);
    db.prepare("UPDATE bank_transactions SET status='VOIDED' WHERE id = ?").run(id);
    audit('bank_transaction', id, 'VOID', null, null, user_id);
  });
}

export function listTransactions(bankAccountId: number) {
  return getDb().prepare(
    `SELECT b.*, c.name AS contact_name FROM bank_transactions b LEFT JOIN contacts c ON c.id=b.contact_id
     WHERE b.bank_account_id = ? AND b.status='POSTED' ORDER BY b.date DESC, b.id DESC LIMIT 300`
  ).all(bankAccountId);
}

// ── Bank rules ─────────────────────────────────────────────────────────────

export function listRules() {
  const db = getDb();
  return db.prepare(`SELECT r.*, a.name AS account_name, c.name AS contact_name FROM bank_rules r
    LEFT JOIN accounts a ON a.id = r.set_account_id LEFT JOIN contacts c ON c.id = r.set_contact_id ORDER BY r.priority DESC, r.id`).all();
}

export function saveRule(input: any, user_id = 1) {
  const db = getDb();
  const vals = [input.name, input.direction ?? null, JSON.stringify(input.conditions ?? {}),
    input.set_contact_id ?? null, input.set_account_id ?? null, input.set_tax_rate_id ?? null, input.priority ?? 0];
  if (input.id) {
    db.prepare(`UPDATE bank_rules SET name=?, direction=?, conditions_json=?, set_contact_id=?, set_account_id=?, set_tax_rate_id=?, priority=? WHERE id=?`).run(...vals, input.id);
  } else {
    input.id = Number(db.prepare(`INSERT INTO bank_rules (name, direction, conditions_json, set_contact_id, set_account_id, set_tax_rate_id, priority) VALUES (?,?,?,?,?,?,?)`).run(...vals).lastInsertRowid);
  }
  audit('bank_rule', input.id, 'SAVE', null, input, user_id);
  return input.id;
}

export function deleteRule(id: number, user_id = 1) {
  getDb().prepare('DELETE FROM bank_rules WHERE id = ?').run(id);
  audit('bank_rule', id, 'DELETE', null, null, user_id);
}

/** Reconciliation report: ledger balance vs statement balance at a date. */
export function reconciliationReport(bankAccountId: number, asAt: string) {
  const db = getDb();
  const ledger = db.prepare(
    `SELECT COALESCE(SUM(l.debit)-SUM(l.credit),0) AS bal FROM journal_lines l JOIN journals j ON j.id=l.journal_id AND j.status='POSTED'
     WHERE l.account_id = ? AND j.date <= ?`).get(bankAccountId, asAt).bal;
  const statement = db.prepare(`SELECT COALESCE(SUM(amount),0) AS bal FROM bank_statement_lines WHERE bank_account_id = ? AND date <= ?`).get(bankAccountId, asAt).bal;
  const outstanding = db.prepare(`SELECT * FROM bank_statement_lines WHERE bank_account_id = ? AND status='UNRECONCILED' AND date <= ? ORDER BY date`).all(bankAccountId, asAt);
  return { asAt, ledger_balance: ledger, statement_balance: statement, difference: ledger - statement, unreconciled: outstanding };
}

export function getTransaction(id: number) {
  const db = getDb();
  const t = db
    .prepare(
      `SELECT b.*, c.name AS contact_name, a.name AS bank_name, a.code AS bank_code
       FROM bank_transactions b LEFT JOIN contacts c ON c.id = b.contact_id
       JOIN accounts a ON a.id = b.bank_account_id WHERE b.id = ?`
    )
    .get(id);
  if (t) {
    t.lines = db
      .prepare(
        `SELECT l.*, a.code AS account_code, a.name AS account_name FROM bank_transaction_lines l
         JOIN accounts a ON a.id = l.account_id WHERE l.bank_transaction_id = ? ORDER BY l.id`
      )
      .all(id);
  }
  return t;
}


/** Rebuild a posted spend/receive-money journal IN PLACE after a recode —
 *  same journal id/number/date; the bank movement is regenerated identically
 *  because amounts never change in a recode. */
export function rebuildBankTxnJournal(id: number) {
  const db = getDb();
  const t = db.prepare('SELECT * FROM bank_transactions WHERE id = ?').get(id);
  if (!t || t.status !== 'POSTED') throw new Error('bank transaction is not posted');
  if (!t.journal_id) throw new Error('bank transaction has no journal to rebuild');
  const lines = db.prepare('SELECT * FROM bank_transaction_lines WHERE bank_transaction_id = ? ORDER BY line_order').all(id);
  const isSpend = t.type === 'SPEND';
  const gst = systemAccount('GST');
  const jl: any[] = [];
  jl.push(isSpend
    ? { account_id: t.bank_account_id, credit: t.total, description: t.reference, contact_id: t.contact_id }
    : { account_id: t.bank_account_id, debit: t.total, description: t.reference, contact_id: t.contact_id });
  for (const l of lines) {
    const net = l.line_amount;
    const tax = l.tax_amount ?? 0;
    jl.push(isSpend
      ? { account_id: l.account_id, debit: net, description: l.description, tax_rate_id: l.tax_rate_id, contact_id: t.contact_id, tracking_option_1: l.tracking_option_1, tracking_option_2: l.tracking_option_2 }
      : { account_id: l.account_id, credit: net, description: l.description, tax_rate_id: l.tax_rate_id, contact_id: t.contact_id, tracking_option_1: l.tracking_option_1, tracking_option_2: l.tracking_option_2 });
    if (tax !== 0) jl.push(isSpend ? { account_id: gst, debit: tax, tax_rate_id: l.tax_rate_id } : { account_id: gst, credit: tax, tax_rate_id: l.tax_rate_id });
  }
  let dr = 0; let cr = 0;
  for (const l of jl) { dr += l.debit ?? 0; cr += l.credit ?? 0; }
  if (dr !== cr) throw new Error(`rebuild would unbalance the journal (${dr} vs ${cr})`);
  db.prepare('DELETE FROM journal_lines WHERE journal_id = ?').run(t.journal_id);
  const ins = db.prepare(
    `INSERT INTO journal_lines (journal_id, account_id, description, debit, credit, tax_rate_id, contact_id, tracking_option_1, tracking_option_2)
     VALUES (?,?,?,?,?,?,?,?,?)`
  );
  for (const l of jl) ins.run(t.journal_id, l.account_id, l.description ?? null, l.debit ?? 0, l.credit ?? 0, l.tax_rate_id ?? null, l.contact_id ?? null, l.tracking_option_1 ?? null, l.tracking_option_2 ?? null);
}
