/**
 * Service registry: maps 'service.method' paths to backend functions.
 * The Electron main process exposes a single 'api' IPC channel that routes
 * through here; the renderer calls window.api('accounts.list', ...args).
 *
 * Arguments are positional and must be JSON-serialisable.
 */
import * as accounts from './services/accounts';
import * as assets from './services/assets';
import * as attachments from './services/attachments';
import * as imports from './services/imports';
import * as findRecode from './services/find_recode';
import * as history from './services/history';
import * as search from './services/search';
import * as recurring from './services/recurring';
import * as forecast from './services/forecast';
import * as fxrevalue from './services/fxrevalue';
import * as savedreports from './services/savedreports';
import * as budgets from './services/budgets';
import * as email from './services/email';
import * as bankfeeds from './services/bankfeeds';
import * as conversions from './services/conversions';
import * as taxreturns from './services/taxreturns';
import * as expenseclaims from './services/expenseclaims';
import * as reminders from './services/reminders';
import * as deferrals from './services/deferrals';
import * as projects from './services/projects';
import * as approvals from './services/approvals';
import * as banking from './services/banking';
import * as contacts from './services/contacts';
import * as dashboard from './services/dashboard';
import * as invoices from './services/invoices';
import * as items from './services/items';
import * as journals from './services/journals';
import * as payments from './services/payments';
import * as reports from './services/reports';
import * as settings from './services/settings';

const services: Record<string, Record<string, Function>> = {
  accounts: accounts as any,
  assets: assets as any,
  attachments: attachments as any,
  imports: imports as any,
  recode: findRecode as any,
  history: history as any,
  search: search as any,
  recurring: recurring as any,
  forecast: forecast as any,
  fxrevalue: fxrevalue as any,
  savedreports: savedreports as any,
  budgets: budgets as any,
  email: email as any,
  bankfeeds: bankfeeds as any,
  conversions: conversions as any,
  taxreturns: taxreturns as any,
  expenseclaims: expenseclaims as any,
  reminders: reminders as any,
  deferrals: deferrals as any,
  projects: projects as any,
  approvals: approvals as any,
  banking: banking as any,
  contacts: contacts as any,
  dashboard: dashboard as any,
  invoices: invoices as any,
  items: items as any,
  journals: journals as any,
  payments: payments as any,
  reports: reports as any,
  settings: settings as any,
};

import { getDb } from './db';
import { can } from './session';

/**
 * Permission required to run a given API method. Anything not listed is a
 * read/query and needs no permission. The active profile's roles decide what
 * it may do — a Read-Only profile, for instance, can open everything but
 * can't post, void, reconcile, recode, or change settings. This is workflow
 * gating, not security: anyone who can open the file can still switch to a
 * more powerful profile in the top bar.
 */
const PERMISSION_FOR: Record<string, string> = {
  // Sales / purchases / credit notes (all flow through invoices.*)
  'invoices.saveDraft': 'invoices.manage',
  'invoices.approve': 'invoices.manage',
  'invoices.bulkApprove': 'invoices.manage',
  'invoices.bulkVoid': 'invoices.manage',
  'recurring.save': 'invoices.manage',
  'recurring.setStatus': 'invoices.manage',
  'recurring.remove': 'invoices.manage',
  'recurring.runNow': 'invoices.manage',
  'recurring.generateDue': 'invoices.manage',
  'fxrevalue.revalue': 'journals.manage',
  'invoices.savePO': 'invoices.manage',
  'invoices.setPOStatus': 'invoices.manage',
  'invoices.poToBill': 'invoices.manage',
  'invoices.saveQuote': 'invoices.manage',
  'invoices.setQuoteStatus': 'invoices.manage',
  'invoices.quoteToInvoice': 'invoices.manage',
  'invoices.invoiceQuoteProgress': 'invoices.manage',
  'budgets.create': 'journals.manage',
  'budgets.rename': 'journals.manage',
  'budgets.remove': 'journals.manage',
  'budgets.setLines': 'journals.manage',
  'conversions.save': 'journals.manage',
  'conversions.clear': 'journals.manage',
  'taxreturns.file': 'journals.manage',
  'taxreturns.unfile': 'journals.manage',
  'taxreturns.recordPayment': 'journals.manage',
  'expenseclaims.save': 'journals.manage',
  'expenseclaims.approve': 'journals.manage',
  'expenseclaims.create': 'journals.manage',
  'expenseclaims.reimburse': 'journals.manage',
  'expenseclaims.remove': 'journals.manage',
  'expenseclaims.voidClaim': 'journals.manage',
  'reminders.recordSent': 'invoices.manage',
  'deferrals.create': 'journals.manage',
  'deferrals.voidSchedule': 'journals.manage',
  'projects.createProject': 'invoices.manage',
  'projects.updateProject': 'invoices.manage',
  'projects.setProjectStatus': 'invoices.manage',
  'projects.deleteProject': 'settings.manage',
  'projects.saveTask': 'invoices.manage',
  'projects.removeTask': 'invoices.manage',
  'projects.logTime': 'invoices.manage',
  'projects.removeTime': 'invoices.manage',
  'projects.addCost': 'invoices.manage',
  'projects.removeCost': 'invoices.manage',
  'projects.updateCostBilling': 'invoices.manage',
  'projects.invoiceUnbilled': 'invoices.manage',
  'approvals.saveRule': 'settings.manage',
  'approvals.setRuleEnabled': 'settings.manage',
  'approvals.removeRule': 'settings.manage',
  'approvals.submit': 'invoices.manage',
  'approvals.approve': 'invoices.manage',
  'approvals.reject': 'invoices.manage',
  'email.saveTemplate': 'journals.manage',
  'email.resetTemplate': 'journals.manage',
  'bankfeeds.connect': 'bank.reconcile',
  'bankfeeds.sync': 'bank.reconcile',
  'bankfeeds.disconnect': 'bank.reconcile',
  'invoices.void': 'invoices.manage',
  'invoices.delete': 'invoices.manage',
  'invoices.revertToDraft': 'invoices.manage',
  'invoices.copy': 'invoices.manage',
  // Manual journals
  'journals.saveDraft': 'journals.manage',
  'journals.post': 'journals.manage',
  'journals.void': 'journals.manage',
  'journals.delete': 'journals.manage',
  'journals.revertToDraft': 'journals.manage',
  'journals.copy': 'journals.manage',
  // Payments
  'payments.create': 'invoices.manage',
  'payments.applyPrepayment': 'invoices.manage',
  'payments.delete': 'invoices.manage',
  // Banking
  'banking.createBankTransaction': 'bank.reconcile',
  'banking.voidBankTransaction': 'bank.reconcile',
  'banking.reconcileMatch': 'bank.reconcile',
  'banking.reconcileCreate': 'bank.reconcile',
  'banking.unreconcile': 'bank.reconcile',
  'banking.saveRule': 'bank.reconcile',
  'banking.deleteRule': 'bank.reconcile',
  'banking.importStatement': 'bank.reconcile',
  'banking.createTransfer': 'bank.reconcile',
  'banking.voidTransfer': 'bank.reconcile',
  // Chart of accounts
  'accounts.create': 'accounts.manage',
  'accounts.update': 'accounts.manage',
  'accounts.archive': 'accounts.manage',
  'accounts.delete': 'accounts.manage',
  // Find & recode
  'recode.recode': 'findrecode.use',
  // CSV imports create documents/journals
  'imports.importDocuments': 'invoices.manage',
  'imports.importJournals': 'journals.manage',
  // Settings, users, tax, tracking, contacts maintenance, assets
  'settings.updateOrganisation': 'settings.manage',
  'settings.saveTaxRate': 'settings.manage',
  'settings.archiveTaxRate': 'settings.manage',
  'settings.saveTrackingCategory': 'settings.manage',
  'settings.archiveTrackingCategory': 'settings.manage',
  'settings.saveUser': 'settings.manage',
  'settings.setExchangeRate': 'settings.manage',
  'settings.setLockDate': 'settings.manage',
  'assets.create': 'accounts.manage',
  'assets.runDepreciation': 'journals.manage',
  // Contact & item maintenance is operational data entry — guard it too.
  'contacts.save': 'invoices.manage',
  'contacts.archive': 'invoices.manage',
  'contacts.restore': 'invoices.manage',
  'contacts.merge': 'settings.manage',
  'contacts.unmerge': 'settings.manage',
  'items.save': 'invoices.manage',
  'items.archive': 'invoices.manage',
  'items.adjustStock': 'invoices.manage',
};

const FRIENDLY_PERM: Record<string, string> = {
  'invoices.manage': 'create or change invoices, bills and payments',
  'journals.manage': 'post manual journals',
  'bank.reconcile': 'record or reconcile bank transactions',
  'accounts.manage': 'change the chart of accounts',
  'findrecode.use': 'use Find & recode',
  'settings.manage': 'change settings, tax rates, tracking or users',
};

// A call is "mutating" if it changes data — only those get idempotency replay.
// Reads pass through untouched even if a key is supplied.
const MUTATING = /\.(save|saveDraft|create|createTransfer|createBankTransaction|approve|void|voidDoc|voidTransfer|voidBankTransaction|delete|deleteDraft|remove|post|update|updateOrganisation|merge|unmerge|recode|importStatement|importDocuments|importJournals|allocateCredit|reconcileMatch|reconcileTransfer|setStatus|runNow|generateDue|bulkApprove|bulkVoid|setActiveUser|saveTaxRate|setLockDate|pause|resume|transfer|pay)$/i;

export function isMutating(path: string): boolean {
  return MUTATING.test(path);
}

/**
 * Run an engine method.
 *
 * If an idempotency key is supplied and the method mutates data, the whole
 * operation is deduped: the first call runs and stores its result under the
 * key; any repeat with the same key returns that stored result without
 * executing again. This protects against retried requests and double submits
 * posting twice — and because it dedupes the entire operation (not just the
 * journal), it also prevents duplicate subledger records.
 */
export function call(path: string, args: unknown[], opts?: { idempotencyKey?: string }): unknown {
  const [svc, method] = path.split('.');
  const fn = services[svc]?.[method];
  if (typeof fn !== 'function') throw new Error(`Unknown API method: ${path}`);
  const need = PERMISSION_FOR[path];
  if (need && !can(need)) {
    const what = FRIENDLY_PERM[need] ?? 'perform this action';
    throw new Error(`Your current profile doesn't have permission to ${what}. Switch to a profile with the right role (top right), or ask an adviser to grant it in Settings → Users.`);
  }

  const key = opts?.idempotencyKey;
  if (!key || !isMutating(path)) return fn(...args);

  const db = getDb();
  // Replay a previously-stored result for this key.
  const seen = db.prepare('SELECT result_json FROM idempotency_keys WHERE key = ?').get(key) as { result_json: string | null } | undefined;
  if (seen) return seen.result_json == null ? undefined : JSON.parse(seen.result_json);

  // Execute and record atomically (nested as a savepoint inside any service txn).
  return db.transaction(() => {
    const result = fn(...args);
    db.prepare('INSERT INTO idempotency_keys (key, operation, result_json) VALUES (?, ?, ?)')
      .run(key, path, result === undefined ? null : JSON.stringify(result));
    return result;
  });
}
