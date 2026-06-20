/**
 * Bank feeds.
 *
 * A "feed" connects a bank account to a transaction provider and pulls new
 * transactions into the same de-duplicated statement-line pipeline that CSV/OFX
 * import uses — so once transactions arrive, reconciliation works exactly as
 * before.
 *
 * IMPORTANT — what's real here:
 *   • The pipeline (connect → sync → de-duplicated import → reconcile) is real
 *     and fully tested, via a built-in SANDBOX provider that generates
 *     simulated transactions. It's a demo/testing feed, clearly labelled.
 *   • A LIVE feed to an actual bank needs a paid aggregator (Plaid, Yodlee, a
 *     bank Open-Banking API, …) and the hosted server edition to hold the API
 *     secrets and run scheduled syncs. To add one, implement a Provider (see
 *     the interface below) and register it in PROVIDERS. Nothing else changes —
 *     connect()/sync() and the whole UI work unchanged.
 */
import { getDb } from '../db';
import { ingestStatementLines, ParsedStatementLine } from './banking';
import { today } from '../engine';

export interface BankFeedProvider {
  key: string;
  label: string;
  /** True for real money connections; the UI flags simulated ones. */
  live: boolean;
  /** Begin a connection; return an opaque reference to store (token, item id, …). */
  connect(bankAccountId: number): { connection_ref: string };
  /** Return transactions on/after `since` (ISO date) for this connection. */
  listTransactions(connectionRef: string, since: string | null): ParsedStatementLine[];
}

function addDays(dateIso: string, n: number): string {
  const [y, m, d] = dateIso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

/**
 * Sandbox provider — deterministic simulated transactions for trying the feed
 * and reconciliation workflow without a real bank. Produces a small, repeatable
 * set each sync dated within the last fortnight; re-syncing is a no-op because
 * the same lines de-duplicate.
 */
const sandbox: BankFeedProvider = {
  key: 'SANDBOX',
  label: 'Sandbox (simulated transactions)',
  live: false,
  connect() {
    return { connection_ref: `sandbox-${Math.random().toString(36).slice(2, 10)}` };
  },
  listTransactions(_ref, _since) {
    // Deterministic set relative to "today" so tests/reruns are stable.
    const base = today();
    return [
      { date: addDays(base, -10), amount: 250000, payee: 'Acme Customer', reference: 'INV settlement', description: 'Customer payment' },
      { date: addDays(base, -7), amount: -4200, payee: 'Cloud Hosting Ltd', reference: 'Monthly plan', description: 'Hosting subscription' },
      { date: addDays(base, -3), amount: -1599, payee: 'Coffee Roasters', reference: '', description: 'Office supplies' },
      { date: addDays(base, -1), amount: 88000, payee: 'Beta Customer', reference: 'Deposit', description: 'Customer payment' },
    ];
  },
};

const PROVIDERS: Record<string, BankFeedProvider> = { SANDBOX: sandbox };

export function availableProviders() {
  return Object.values(PROVIDERS).map((p) => ({ key: p.key, label: p.label, live: p.live }));
}

export function list() {
  return getDb().prepare(
    `SELECT f.*, a.name AS account_name, a.code AS account_code
       FROM bank_feeds f JOIN accounts a ON a.id = f.bank_account_id
      ORDER BY f.id DESC`
  ).all();
}

export function connect(input: { bank_account_id: number; provider: string }) {
  const db = getDb();
  const provider = PROVIDERS[input.provider];
  if (!provider) throw new Error('Unknown bank-feed provider');
  const acct: any = db.prepare('SELECT id, is_bank_account FROM accounts WHERE id = ?').get(input.bank_account_id);
  if (!acct || !acct.is_bank_account) throw new Error('Choose a bank account to connect the feed to');
  const existing = db.prepare("SELECT id FROM bank_feeds WHERE bank_account_id = ? AND status = 'ACTIVE'").get(input.bank_account_id);
  if (existing) throw new Error('This bank account already has an active feed');
  const { connection_ref } = provider.connect(input.bank_account_id);
  const id = Number(db.prepare(
    `INSERT INTO bank_feeds (bank_account_id, provider, connection_ref, status, last_refresh_at) VALUES (?, ?, ?, 'ACTIVE', NULL)`
  ).run(input.bank_account_id, provider.key, connection_ref).lastInsertRowid);
  return get(id);
}

export function get(id: number) {
  const f: any = getDb().prepare(
    `SELECT f.*, a.name AS account_name, a.code AS account_code FROM bank_feeds f JOIN accounts a ON a.id = f.bank_account_id WHERE f.id = ?`
  ).get(id);
  if (!f) throw new Error('Bank feed not found');
  const p = PROVIDERS[f.provider];
  f.provider_label = p?.label ?? f.provider;
  f.live = !!p?.live;
  return f;
}

/** Pull new transactions for a feed and import them (de-duplicated). */
export function sync(id: number, user_id = 1) {
  const db = getDb();
  const feed: any = db.prepare('SELECT * FROM bank_feeds WHERE id = ?').get(id);
  if (!feed) throw new Error('Bank feed not found');
  if (feed.status !== 'ACTIVE') throw new Error('This feed is not active');
  const provider = PROVIDERS[feed.provider];
  if (!provider) throw new Error(`No provider registered for "${feed.provider}"`);

  const since = feed.last_refresh_at ? String(feed.last_refresh_at).slice(0, 10) : null;
  const lines = provider.listTransactions(feed.connection_ref, since);
  const r = ingestStatementLines(feed.bank_account_id, lines);
  db.prepare("UPDATE bank_feeds SET last_refresh_at = datetime('now') WHERE id = ?").run(id);
  return { imported: r.imported, duplicates: r.duplicates, fetched: lines.length };
}

export function disconnect(id: number) {
  getDb().prepare("UPDATE bank_feeds SET status = 'DISCONNECTED' WHERE id = ?").run(id);
  return { ok: true };
}
