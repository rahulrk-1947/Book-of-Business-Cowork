/**
 * Expense claims — expenses someone pays out of their own pocket on behalf of
 * the business, then claims back. A claim is recorded against the operator
 * (user 1 on the single-user web edition) and posts, on approval:
 *
 *   Dr  expense accounts (net of tax)
 *   Dr  GST/Sales Tax control (recoverable input tax)
 *   Cr  Unpaid Expense Claims (account 830, a liability)
 *
 * Reimbursing the person later relieves the liability:
 *
 *   Dr  Unpaid Expense Claims
 *   Cr  bank
 *
 * Claims are kept in the base currency (receipts are normally local). All
 * posting goes through the engine's single chokepoint so the ledger always
 * balances and stays auditable.
 */
import { getDb } from '../db';
import {
  postJournal, systemAccount, today, baseCurrency,
  assertValidDate, assertDateUnlocked, voidJournalsForSource, PostingError,
} from '../engine';
import { calcDocument, LineAmountType } from '../tax';
import { syncProjectCostsFromDoc, removeProjectCostsForDoc } from './project-costing';
import { taxComponents } from '../engine';

const CLAIM_SOURCE = 'EXPENSE_CLAIM';
const PAY_SOURCE = 'EXPENSE_CLAIM_PAYMENT';

export interface ClaimLineInput {
  account_id: number;
  description?: string;
  quantity?: number;
  unit_amount: number; // cents, base currency
  tax_rate_id?: number | null;
  tracking_option_1?: number | null;
  tracking_option_2?: number | null;
}
export interface ClaimInput {
  id?: number;
  date: string;
  reference?: string;
  narration?: string;
  line_amount_type?: LineAmountType; // default INCLUSIVE — receipts usually include tax
  lines: ClaimLineInput[];
}

function totalsFor(input: ClaimInput) {
  const mode: LineAmountType = input.line_amount_type ?? 'INCLUSIVE';
  return calcDocument(
    input.lines.map((l) => ({
      quantity: l.quantity ?? 1,
      unit_amount: l.unit_amount,
      components: taxComponents(l.tax_rate_id),
    })),
    mode
  );
}

function assertEditable(id: number) {
  const row = getDb().prepare('SELECT status FROM expense_claims WHERE id = ?').get(id) as { status: string } | undefined;
  if (!row) throw new Error('Expense claim not found');
  if (row.status !== 'DRAFT') throw new Error(`This claim is ${row.status.toLowerCase()} and can no longer be edited. Void it first if you need to change it.`);
}

/** Create or update a DRAFT claim (nothing is posted to the ledger yet). */
export function save(input: ClaimInput, userId = 1): { id: number } {
  const db = getDb();
  if (!input.date) throw new Error('A claim date is required');
  assertValidDate(input.date, 'Claim date');
  const lines = (input.lines ?? []).filter((l) => l.account_id && (l.unit_amount ?? 0) !== 0);
  if (lines.length === 0) throw new Error('Add at least one expense line with an account and an amount');

  const totals = totalsFor({ ...input, lines });
  const mode: LineAmountType = input.line_amount_type ?? 'INCLUSIVE';

  return db.transaction(() => {
    let id = input.id ?? 0;
    if (id) {
      assertEditable(id);
      db.prepare('UPDATE expense_claims SET total = ?, date = ?, reference = ?, narration = ?, line_amount_type = ? WHERE id = ?')
        .run(totals.total, input.date, input.reference ?? null, input.narration ?? null, mode, id);
      db.prepare('DELETE FROM expense_claim_lines WHERE claim_id = ?').run(id);
    } else {
      id = Number(
        db.prepare(
          "INSERT INTO expense_claims (user_id, status, total, date, reference, narration, line_amount_type) VALUES (?, 'DRAFT', ?, ?, ?, ?, ?)"
        ).run(userId, totals.total, input.date, input.reference ?? null, input.narration ?? null, mode).lastInsertRowid
      );
    }
    const ins = db.prepare(
      `INSERT INTO expense_claim_lines (claim_id, date, description, account_id, tax_rate_id, amount, quantity, unit_rate, tracking_option_1, tracking_option_2, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const l of lines) {
      const qty = l.quantity ?? 1;
      ins.run(id, input.date, l.description ?? null, l.account_id, l.tax_rate_id ?? null, Math.round(qty * l.unit_amount), qty, l.unit_amount, l.tracking_option_1 ?? null, l.tracking_option_2 ?? null, (l as any).project_id ?? null);
    }
    return { id };
  });
}

/** Approve a DRAFT claim: post the journal and mark it APPROVED (awaiting reimbursement). */
export function approve(id: number, userId = 1): { id: number; journal_id: number } {
  const db = getDb();
  const claim = db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(id) as any;
  if (!claim) throw new Error('Expense claim not found');
  if (claim.status !== 'DRAFT') throw new Error(`Only draft claims can be approved (this one is ${claim.status.toLowerCase()}).`);
  const date = claim.date ?? today();
  assertValidDate(date, 'Claim date');
  assertDateUnlocked(date);

  const lineRows = db.prepare('SELECT * FROM expense_claim_lines WHERE claim_id = ? ORDER BY id').all(id) as any[];
  if (lineRows.length === 0) throw new Error('This claim has no lines to approve');

  const mode: LineAmountType = (claim.line_amount_type as LineAmountType) ?? 'INCLUSIVE';
  const calc = calcDocument(
    lineRows.map((l) => ({ quantity: 1, unit_amount: l.amount, components: taxComponents(l.tax_rate_id) })),
    mode
  );

  const claimsCtl = systemAccount('EXPENSE_CLAIMS');
  const gstCtl = (() => { try { return systemAccount('GST'); } catch { return 0; } })();

  const jLines: any[] = [];
  let totalTax = 0;
  let total = 0;
  lineRows.forEach((l, i) => {
    const r = calc.lines[i];
    totalTax += r.tax;
    total += r.gross;
    jLines.push({
      account_id: l.account_id,
      debit: r.net,
      description: l.description ?? claim.narration ?? 'Expense claim',
      tax_rate_id: l.tax_rate_id ?? null,
      tracking_option_1: l.tracking_option_1 ?? null,
      tracking_option_2: l.tracking_option_2 ?? null,
    });
  });
  if (totalTax !== 0 && gstCtl) {
    jLines.push({ account_id: gstCtl, debit: totalTax, description: 'Expense claim tax' });
  }
  jLines.push({ account_id: claimsCtl, credit: total, description: claim.reference ? `Expense claim ${claim.reference}` : 'Expense claim' });

  return db.transaction(() => {
    const journalId = postJournal({
      date,
      narration: claim.narration ?? (claim.reference ? `Expense claim ${claim.reference}` : 'Expense claim'),
      source_type: CLAIM_SOURCE,
      source_id: id,
      lines: jLines,
      user_id: userId,
    });
    db.prepare("UPDATE expense_claims SET status = 'APPROVED', total = ?, journal_id = ?, submitted_at = COALESCE(submitted_at, datetime('now')), approved_by = ? WHERE id = ?")
      .run(total, journalId, userId, id);
    // Project-tagged claim lines become costs on those projects.
    const costLines = db.prepare('SELECT project_id, description, amount, date FROM expense_claim_lines WHERE claim_id = ? AND project_id IS NOT NULL').all(id) as any[];
    if (costLines.length) syncProjectCostsFromDoc(db, { source_type: 'EXPENSECLAIM', source_id: id, date, lines: costLines });
    return { id, journal_id: journalId };
  });
}

/** Convenience: save a new claim and approve it in one step. */
export function create(input: ClaimInput, userId = 1): { id: number; journal_id: number } {
  const { id } = save(input, userId);
  return approve(id, userId);
}

/** Reimburse an APPROVED claim from a bank account, relieving the liability. */
export function reimburse(input: { claim_id: number; bank_account_id: number; date?: string }, userId = 1): { id: number; journal_id: number } {
  const db = getDb();
  const claim = db.prepare('SELECT * FROM expense_claims WHERE id = ?').get(input.claim_id) as any;
  if (!claim) throw new Error('Expense claim not found');
  if (claim.status !== 'APPROVED') throw new Error(`Only approved claims can be reimbursed (this one is ${claim.status.toLowerCase()}).`);
  if (!input.bank_account_id) throw new Error('Choose a bank account to pay from');
  const bank = db.prepare('SELECT id, is_bank_account FROM accounts WHERE id = ?').get(input.bank_account_id) as any;
  if (!bank || !bank.is_bank_account) throw new Error('That account is not a bank account');

  const date = input.date ?? today();
  assertValidDate(date, 'Payment date');
  assertDateUnlocked(date);
  const claimsCtl = systemAccount('EXPENSE_CLAIMS');
  const amount = claim.total as number;

  return db.transaction(() => {
    const journalId = postJournal({
      date,
      narration: claim.reference ? `Reimburse expense claim ${claim.reference}` : 'Reimburse expense claim',
      source_type: PAY_SOURCE,
      source_id: input.claim_id,
      lines: [
        { account_id: claimsCtl, debit: amount, description: 'Reimburse expense claim' },
        { account_id: input.bank_account_id, credit: amount, description: 'Reimburse expense claim' },
      ],
      user_id: userId,
    });
    db.prepare("UPDATE expense_claims SET status = 'PAID', paid_at = ? WHERE id = ?").run(date, input.claim_id);
    return { id: input.claim_id, journal_id: journalId };
  });
}

/** Delete a DRAFT claim outright. */
export function remove(id: number): { id: number; removed: boolean } {
  const db = getDb();
  const claim = db.prepare('SELECT status FROM expense_claims WHERE id = ?').get(id) as any;
  if (!claim) throw new Error('Expense claim not found');
  if (claim.status !== 'DRAFT') throw new Error('Only draft claims can be deleted. Void an approved claim instead.');
  return db.transaction(() => {
    db.prepare('DELETE FROM expense_claim_lines WHERE claim_id = ?').run(id);
    db.prepare('DELETE FROM expense_claims WHERE id = ?').run(id);
    return { id, removed: true };
  });
}

/** Void an APPROVED or PAID claim: reverse its journal(s) and mark it declined. */
export function voidClaim(id: number, userId = 1): { id: number; status: string } {
  const db = getDb();
  const claim = db.prepare('SELECT status FROM expense_claims WHERE id = ?').get(id) as any;
  if (!claim) throw new Error('Expense claim not found');
  if (claim.status === 'DRAFT') throw new Error('A draft claim has nothing to void — delete it instead.');
  if (claim.status === 'DECLINED') throw new Error('This claim is already voided.');
  return db.transaction(() => {
    if (claim.status === 'PAID') voidJournalsForSource(PAY_SOURCE, id, userId);
    voidJournalsForSource(CLAIM_SOURCE, id, userId);
    db.prepare("UPDATE expense_claims SET status = 'DECLINED', journal_id = NULL, paid_at = NULL WHERE id = ?").run(id);
    removeProjectCostsForDoc(db, 'EXPENSECLAIM', id);
    return { id, status: 'DECLINED' };
  });
}

export function list(): any[] {
  const db = getDb();
  return db.prepare(
    `SELECT c.id, c.date, c.reference, c.narration, c.status, c.total, c.paid_at, u.name AS claimant
       FROM expense_claims c LEFT JOIN users u ON u.id = c.user_id
      WHERE c.status <> 'DECLINED'
      ORDER BY COALESCE(c.date, '') DESC, c.id DESC`
  ).all();
}

export function get(id: number): any {
  const db = getDb();
  const claim = db.prepare('SELECT c.*, u.name AS claimant FROM expense_claims c LEFT JOIN users u ON u.id = c.user_id WHERE c.id = ?').get(id) as any;
  if (!claim) throw new Error('Expense claim not found');
  claim.lines = db.prepare('SELECT * FROM expense_claim_lines WHERE claim_id = ? ORDER BY id').all(id);
  return claim;
}

/** Total currently owed to claimants (approved but not yet reimbursed), base currency. */
export function outstanding(): { total: number; currency: string } {
  const db = getDb();
  const r = db.prepare("SELECT COALESCE(SUM(total), 0) AS t FROM expense_claims WHERE status = 'APPROVED'").get() as any;
  return { total: r.t as number, currency: baseCurrency() };
}
