import { getDb } from '../db';
import { assertUniqueName } from './uniqueness';
import { audit } from '../engine';

export function list(opts: { includeArchived?: boolean } = {}) {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.*, t.name AS tax_rate_name,
        COALESCE((SELECT SUM(l.debit) - SUM(l.credit) FROM journal_lines l
          JOIN journals j ON j.id = l.journal_id AND j.status = 'POSTED'
          WHERE l.account_id = a.id), 0) AS balance_drcr,
        EXISTS(SELECT 1 FROM journal_lines l WHERE l.account_id = a.id) AS has_postings
       FROM accounts a LEFT JOIN tax_rates t ON t.id = a.tax_rate_id_default
       ${opts.includeArchived ? '' : "WHERE a.status = 'ACTIVE'"}
       ORDER BY a.type, a.code`
    )
    .all();
  // Display balance in the account's natural sign
  return rows.map((a: any) => ({
    ...a,
    balance: ['ASSET', 'EXPENSE'].includes(a.type) ? a.balance_drcr : -a.balance_drcr,
  }));
}

export function get(id: number) {
  return getDb().prepare('SELECT * FROM accounts WHERE id = ?').get(id);
}

export interface AccountInput {
  code: string;
  name: string;
  type: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  subtype?: string;
  description?: string;
  tax_rate_id_default?: number | null;
  is_bank_account?: boolean;
  bank_currency?: string | null;
  bank_account_number?: string | null;
  enable_payments?: boolean;
}

export function create(input: AccountInput, user_id = 1) {
  const db = getDb();
  if (!input.code) throw new Error('Account code is required');
  if (!input.name) throw new Error('Account name is required');
  assertUniqueName({ table: 'accounts', column: 'code', value: input.code, statuses: ['ACTIVE'], label: 'An account with code' });
  assertUniqueName({ table: 'accounts', column: 'name', value: input.name, statuses: ['ACTIVE'], label: 'An account named' });
  const id = Number(
    db
      .prepare(
        `INSERT INTO accounts (code, name, type, subtype, description, tax_rate_id_default, is_bank_account, bank_currency, bank_account_number, enable_payments)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.code,
        input.name,
        input.type,
        input.subtype ?? (input.is_bank_account ? 'BANK' : null),
        input.description ?? null,
        input.tax_rate_id_default ?? null,
        input.is_bank_account ? 1 : 0,
        input.bank_currency ?? null,
        input.bank_account_number ?? null,
        input.enable_payments ? 1 : 0
      ).lastInsertRowid
  );
  audit('account', id, 'CREATE', null, input, user_id);
  return get(id);
}

export function update(id: number, input: Partial<AccountInput>, user_id = 1) {
  const db = getDb();
  const before = get(id);
  if (!before) throw new Error('Account not found');
  if (input.code) assertUniqueName({ table: 'accounts', column: 'code', value: input.code, excludeId: id, statuses: ['ACTIVE'], label: 'An account with code' });
  if (input.name) assertUniqueName({ table: 'accounts', column: 'name', value: input.name, excludeId: id, statuses: ['ACTIVE'], label: 'An account named' });
  if (before.system_account && input.type && input.type !== before.type) {
    throw new Error('Cannot change the type of a system account');
  }
  const hasPostings = db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(id);
  if (hasPostings && input.type && input.type !== before.type) {
    throw new Error('Cannot change account type once transactions are posted (it would scramble reports)');
  }
  const fields: Record<string, unknown> = {
    code: input.code ?? before.code,
    name: input.name ?? before.name,
    type: input.type ?? before.type,
    subtype: input.subtype ?? before.subtype,
    description: input.description ?? before.description,
    tax_rate_id_default: input.tax_rate_id_default === undefined ? before.tax_rate_id_default : input.tax_rate_id_default,
    enable_payments: input.enable_payments === undefined ? before.enable_payments : input.enable_payments ? 1 : 0,
  };
  db.prepare(
    `UPDATE accounts SET code=?, name=?, type=?, subtype=?, description=?, tax_rate_id_default=?, enable_payments=? WHERE id=?`
  ).run(fields.code, fields.name, fields.type, fields.subtype, fields.description, fields.tax_rate_id_default, fields.enable_payments, id);
  audit('account', id, 'UPDATE', before, fields, user_id);
  return get(id);
}

/** Accounts with postings are never deleted — only archived (spec §3.4). */
export function archive(id: number, user_id = 1) {
  const db = getDb();
  const a = get(id);
  if (!a) throw new Error('Account not found');
  if (a.system_account) throw new Error('System accounts cannot be archived');
  db.prepare("UPDATE accounts SET status = 'ARCHIVED' WHERE id = ?").run(id);
  audit('account', id, 'ARCHIVE', a, null, user_id);
}

export function restore(id: number, user_id = 1) {
  getDb().prepare("UPDATE accounts SET status = 'ACTIVE' WHERE id = ?").run(id);
  audit('account', id, 'RESTORE', null, null, user_id);
}

export function remove(id: number, user_id = 1) {
  const db = getDb();
  const a = get(id);
  if (!a) throw new Error('Account not found');
  if (a.system_account) throw new Error('System accounts cannot be deleted');
  const used =
    db.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(id) ||
    db.prepare('SELECT 1 FROM invoice_lines WHERE account_id = ? LIMIT 1').get(id);
  if (used) throw new Error('Account has transactions — archive it instead');
  db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
  audit('account', id, 'DELETE', a, null, user_id);
}

export function exportCsv(): string {
  const rows = list({ includeArchived: true });
  const head = 'Code,Name,Type,Subtype,Status,Balance';
  return [head, ...rows.map((r: any) => `${r.code},"${r.name.replace(/"/g, '""')}",${r.type},${r.subtype ?? ''},${r.status},${(r.balance / 100).toFixed(2)}`)].join('\n');
}


/** The control accounts the UI should hide from coding pickers — same set the
 *  invoice guard enforces. */
export function lockedSystemAccounts() {
  const db = getDb();
  const TAGS = ['AR', 'AP', 'GST', 'RETAINED_EARNINGS', 'ROUNDING', 'UNREALISED_FX', 'REALISED_FX', 'CUSTOMER_PREPAYMENT', 'SUPPLIER_PREPAYMENT'];
  return db.prepare(
    `SELECT id FROM accounts WHERE system_account IN (${TAGS.map(() => '?').join(',')})`
  ).all(...TAGS).map((r: any) => r.id as number);
}
