import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { openDatabase, DB } from './sqlite';

let db: DB | null = null;

function findSchema(): string {
  const candidates = [
    join(__dirname, 'schema.sql'), // bundled next to main.cjs
    join(process.cwd(), 'src/backend/schema.sql'),
    join(dirname(process.execPath), 'resources', 'schema.sql'),
  ];
  for (const c of candidates) if (existsSync(c)) return readFileSync(c, 'utf8');
  throw new Error('schema.sql not found');
}

export function initDatabase(path: string): DB {
  const isNew = path === ':memory:' || !existsSync(path);
  db = openDatabase(path);
  if (isNew) {
    db.exec(findSchema());
  }
  runMigrations(db, path, isNew);
  integrityCheck(db);
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error('Database not initialised');
  return db;
}

export function setDb(d: DB) {
  db = d;
}

/** Forward-only versioned migrations (spec App.2 §12). v1 = base schema. */
const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 2,
    sql: `CREATE TABLE IF NOT EXISTS attachments (
      id INTEGER PRIMARY KEY,
      entity_type TEXT NOT NULL,          -- 'invoice' | 'manual_journal' | 'payment' | 'bank_transaction'
      entity_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER NOT NULL,              -- original bytes
      data TEXT NOT NULL,                 -- base64; keeps one storage path across sqlite drivers
      uploaded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id);`,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS recode_runs (
        id INTEGER PRIMARY KEY,
        run_at TEXT NOT NULL DEFAULT (datetime('now')),
        user_id INTEGER NOT NULL DEFAULT 1,
        criteria_json TEXT,
        changes_json TEXT,
        items_done INTEGER NOT NULL DEFAULT 0,
        items_skipped INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS recode_items (
        id INTEGER PRIMARY KEY,
        run_id INTEGER NOT NULL REFERENCES recode_runs(id),
        source TEXT NOT NULL,
        doc_id INTEGER NOT NULL,
        line_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        reason TEXT,
        before_json TEXT,
        after_json TEXT
      );
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS contact_merges (
        id INTEGER PRIMARY KEY,
        merged_at TEXT NOT NULL DEFAULT (datetime('now')),
        user_id INTEGER NOT NULL DEFAULT 1,
        from_id INTEGER NOT NULL,
        into_id INTEGER NOT NULL,
        from_name_before TEXT,
        moves_json TEXT,
        status TEXT NOT NULL DEFAULT 'MERGED'
      );
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS recurring_templates (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,                       -- ACCREC / ACCPAY
        contact_id INTEGER NOT NULL,
        line_amount_type TEXT NOT NULL DEFAULT 'EXCLUSIVE',
        reference TEXT,
        frequency TEXT NOT NULL,                  -- WEEKLY / MONTHLY / YEARLY
        every_n INTEGER NOT NULL DEFAULT 1,       -- interval, e.g. every 2 weeks
        anchor_day INTEGER,                       -- day-of-month for monthly schedules
        due_days INTEGER NOT NULL DEFAULT 14,     -- payment terms: due N days after issue
        start_date TEXT NOT NULL,
        next_date TEXT NOT NULL,                  -- next issue date (advances on generate)
        end_date TEXT,                            -- optional hard stop
        end_after INTEGER,                        -- optional: stop after N issues
        issued_count INTEGER NOT NULL DEFAULT 0,
        auto_approve INTEGER NOT NULL DEFAULT 0,  -- 0 = create as draft, 1 = approve on creation
        status TEXT NOT NULL DEFAULT 'ACTIVE',    -- ACTIVE / PAUSED / ENDED
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS recurring_template_lines (
        id INTEGER PRIMARY KEY,
        template_id INTEGER NOT NULL,
        line_order INTEGER NOT NULL DEFAULT 0,
        item_id INTEGER,
        description TEXT NOT NULL,
        quantity REAL NOT NULL DEFAULT 1,
        unit_amount INTEGER NOT NULL DEFAULT 0,
        discount_percent REAL NOT NULL DEFAULT 0,
        account_id INTEGER NOT NULL,
        tax_rate_id INTEGER,
        tracking_option_1 INTEGER,
        tracking_option_2 INTEGER
      );
      ALTER TABLE invoices ADD COLUMN recurring_template_id INTEGER;
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE organisations ADD COLUMN logo_data TEXT;
      ALTER TABLE organisations ADD COLUMN address_line1 TEXT;
      ALTER TABLE organisations ADD COLUMN address_line2 TEXT;
      ALTER TABLE organisations ADD COLUMN address_city TEXT;
      ALTER TABLE organisations ADD COLUMN address_region TEXT;
      ALTER TABLE organisations ADD COLUMN address_postcode TEXT;
      ALTER TABLE organisations ADD COLUMN address_country TEXT;
      ALTER TABLE organisations ADD COLUMN contact_email TEXT;
      ALTER TABLE organisations ADD COLUMN contact_phone TEXT;
      ALTER TABLE organisations ADD COLUMN website TEXT;
      ALTER TABLE organisations ADD COLUMN invoice_footer TEXT;
    `,
  },
  {
    version: 7,
    sql: `
      -- Operation-level idempotency: a keyed mutating call stores its result and
      -- replays it on a repeat, so a retried request can't run twice.
      CREATE TABLE IF NOT EXISTS idempotency_keys (
        key TEXT PRIMARY KEY,
        operation TEXT NOT NULL,
        result_json TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      -- Accounting-level idempotency on the posting chokepoint.
      ALTER TABLE journals ADD COLUMN idempotency_key TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_journals_idem ON journals(idempotency_key) WHERE idempotency_key IS NOT NULL;
    `,
  },
  {
    version: 8,
    sql: `
      -- Saved report views: a named snapshot of a report's type, date range,
      -- filters, chosen columns, comparison periods and basis, so the user can
      -- re-run a customised report in one click.
      CREATE TABLE IF NOT EXISTS saved_reports (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        report_type TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 9,
    sql: `
      -- The base schema already defines budgets / budget_lines; add a uniqueness
      -- index so each (budget, account, month) cell upserts cleanly.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_budget_line_cell ON budget_lines(budget_id, account_id, period_date);
    `,
  },
  {
    version: 10,
    sql: `
      -- The base schema already defines email_templates; add a uniqueness index
      -- on document_type so each type's template upserts cleanly.
      CREATE UNIQUE INDEX IF NOT EXISTS ux_email_tpl_type ON email_templates(document_type);
    `,
  },
  {
    version: 11,
    sql: `
      -- Money-on-account accounts for prepayments / overpayments.
      INSERT INTO accounts (code,name,type,subtype,is_bank_account,enable_payments,system_account,tax_rate_id_default)
        SELECT '805','Customer prepayments','LIABILITY','CURRENT_LIABILITY',0,0,'CUSTOMER_PREPAYMENT',2
        WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE system_account='CUSTOMER_PREPAYMENT');
      INSERT INTO accounts (code,name,type,subtype,is_bank_account,enable_payments,system_account,tax_rate_id_default)
        SELECT '625','Supplier prepayments','ASSET','CURRENT_ASSET',0,0,'SUPPLIER_PREPAYMENT',2
        WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE system_account='SUPPLIER_PREPAYMENT');
    `,
  },
  {
    version: 12,
    sql: `
      -- Filed tax (GST/VAT) returns: a permanent record of what was submitted
      -- for a period. Filing also locks the period (see the taxreturns service).
      CREATE TABLE IF NOT EXISTS tax_returns (
        id INTEGER PRIMARY KEY,
        period_from TEXT NOT NULL,
        period_to TEXT NOT NULL,
        basis TEXT NOT NULL DEFAULT 'ACCRUAL',
        collected INTEGER NOT NULL,          -- output tax (cents)
        paid INTEGER NOT NULL,               -- input tax (cents)
        net INTEGER NOT NULL,                -- collected - paid (payable if positive)
        note TEXT,
        filed_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 13,
    sql: `
      -- Expense claims: give the (scaffolded) header a date, reference and
      -- narration so a claim is self-contained before it's posted. The claimant
      -- is the owning user; on the single-user web edition that's the operator.
      ALTER TABLE expense_claims ADD COLUMN date TEXT;
      ALTER TABLE expense_claims ADD COLUMN reference TEXT;
      ALTER TABLE expense_claims ADD COLUMN narration TEXT;
      ALTER TABLE expense_claims ADD COLUMN line_amount_type TEXT NOT NULL DEFAULT 'INCLUSIVE';
    `,
  },
  {
    version: 14,
    sql: `
      -- A log of payment reminders sent to customers, so the reminders screen
      -- can show when each customer was last chased and avoid over-reminding.
      CREATE TABLE IF NOT EXISTS reminder_log (
        id INTEGER PRIMARY KEY,
        contact_id INTEGER NOT NULL REFERENCES contacts(id),
        sent_at TEXT NOT NULL DEFAULT (datetime('now')),
        level TEXT,
        amount INTEGER,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reminder_log_contact ON reminder_log(contact_id);
    `,
  },
  {
    version: 15,
    sql: `
      -- Progress invoicing: link an invoice back to the quote/estimate it bills
      -- a portion of, and record what percentage of that quote it represents.
      ALTER TABLE invoices ADD COLUMN from_quote_id INTEGER;
      ALTER TABLE invoices ADD COLUMN progress_pct REAL;
      CREATE INDEX IF NOT EXISTS idx_invoices_from_quote ON invoices(from_quote_id);
    `,
  },
  {
    version: 16,
    sql: `
      -- Accruals & deferrals: spread an amount in a holding account (deferred
      -- income / prepaid expense) into income or expense over several months.
      CREATE TABLE IF NOT EXISTS deferral_schedules (
        id INTEGER PRIMARY KEY,
        name TEXT,
        kind TEXT NOT NULL,                       -- 'INCOME' | 'EXPENSE'
        deferral_account_id INTEGER NOT NULL REFERENCES accounts(id),
        recognition_account_id INTEGER NOT NULL REFERENCES accounts(id),
        contact_id INTEGER REFERENCES contacts(id),
        total INTEGER NOT NULL,                    -- cents, base currency
        periods INTEGER NOT NULL,
        start_date TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'ACTIVE',     -- 'ACTIVE' | 'VOIDED'
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `,
  },
  {
    version: 17,
    sql: `
      -- Projects (jobs): track time and costs, see profitability, on-bill to the customer.
      -- These tables were reserved but unused; recreate them with the full shape
      -- (drop children before parents so foreign keys are satisfied).
      DROP TABLE IF EXISTS project_expenses;
      DROP TABLE IF EXISTS project_time;
      DROP TABLE IF EXISTS project_tasks;
      DROP TABLE IF EXISTS projects;
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY, contact_id INTEGER REFERENCES contacts(id), name TEXT NOT NULL, code TEXT,
        status TEXT NOT NULL DEFAULT 'IN_PROGRESS', estimate_amount INTEGER, deadline TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE project_tasks (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
        rate INTEGER, charge_type TEXT, estimated_minutes INTEGER, status TEXT DEFAULT 'ACTIVE'
      );
      CREATE TABLE project_time (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
        task_id INTEGER REFERENCES project_tasks(id), user_id INTEGER REFERENCES users(id),
        date TEXT NOT NULL, minutes INTEGER NOT NULL, description TEXT,
        billable INTEGER DEFAULT 1, invoiced INTEGER DEFAULT 0, invoice_id INTEGER
      );
      CREATE TABLE project_expenses (
        id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
        source_type TEXT, source_id INTEGER, date TEXT, description TEXT,
        cost_amount INTEGER, markup_percent REAL, charge_amount INTEGER,
        billable INTEGER DEFAULT 1, invoiced INTEGER DEFAULT 0, invoice_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_project_time_project ON project_time(project_id);
      CREATE INDEX IF NOT EXISTS idx_project_expenses_project ON project_expenses(project_id);
    `,
  },
  {
    version: 18,
    sql: `
      -- Approval workflows: rules say when sign-off is needed; docs are submitted then approved/rejected.
      CREATE TABLE IF NOT EXISTS approval_rules (
        id INTEGER PRIMARY KEY,
        doc_type TEXT NOT NULL,                 -- ACCREC | ACCPAY
        min_amount INTEGER NOT NULL DEFAULT 0,  -- cents; approval required at/above this total
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS approvals (
        id INTEGER PRIMARY KEY,
        doc_type TEXT NOT NULL,
        doc_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | APPROVED | REJECTED
        note TEXT,
        requested_by INTEGER, requested_at TEXT NOT NULL DEFAULT (datetime('now')),
        decided_by INTEGER, decided_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_approvals_doc ON approvals(doc_type, doc_id);
    `,
  },
  {
    version: 19,
    sql: `
      -- Reorder point for tracked items: flag low stock when quantity_on_hand falls below it.
      ALTER TABLE items ADD COLUMN reorder_point REAL;
    `,
  },
  {
    version: 20,
    sql: `
      -- Data-integrity hardening (audit fixes). All idempotent so re-running the
      -- newest migration (upgrade-safety path) is a no-op.
      -- 1) Document numbers must be unique. Duplicate invoice / journal / quote /
      --    PO numbers are an audit failure; the import path (caller-supplied
      --    invoice_number) and a manually rewound sequence could previously
      --    create them silently. Partial indexes skip NULLs (drafts).
      CREATE UNIQUE INDEX IF NOT EXISTS ux_invoices_number ON invoices(invoice_number) WHERE invoice_number IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_journals_number ON journals(journal_number) WHERE journal_number IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_quotes_number ON quotes(quote_number) WHERE quote_number IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS ux_po_number ON purchase_orders(order_number) WHERE order_number IS NOT NULL;
      -- 2) A given payment / bank transaction may be reconciled to at most ONE
      --    statement line (prevents double-counting in reconciliation).
      CREATE UNIQUE INDEX IF NOT EXISTS ux_reconciled_source
        ON bank_statement_lines(reconciled_source_type, reconciled_source_id)
        WHERE status = 'RECONCILED' AND reconciled_source_id IS NOT NULL;
      -- 3) Dedicated account for gains/losses on fixed-asset disposal. Disposal
      --    gains/losses were previously posted to Depreciation Expense, which
      --    buried gains as negative depreciation and misstated the P&L.
      INSERT INTO accounts (code,name,type,subtype,is_bank_account,enable_payments,system_account,tax_rate_id_default)
        SELECT '421','Gain/Loss on Asset Disposal','EXPENSE','EXPENSE',0,0,'DISPOSAL_GAINLOSS',2
        WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE system_account='DISPOSAL_GAINLOSS');
    `,
  },
];

/** The newest schema version this build of the app knows how to produce. */
export const APP_SCHEMA_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0);

function currentSchemaVersion(d: DB): number {
  const row = d.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

/**
 * Take a safety snapshot of the database file just before an upgrade, so a
 * problematic migration can be rolled back to. WAL is checkpointed first so the
 * copied file is self-contained. Best-effort: a failed backup is reported but
 * does not block the upgrade (each migration is itself atomic).
 */
function backupBeforeUpgrade(d: DB, path: string, fromVersion: number): string | null {
  try {
    try { d.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch { /* not WAL, fine */ }
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const dot = path.lastIndexOf('.');
    const stem = dot > 0 ? path.slice(0, dot) : path;
    const ext = dot > 0 ? path.slice(dot) : '.sqlite';
    const dest = `${stem}.pre-upgrade-v${fromVersion}-${ts}${ext}`;
    copyFileSync(path, dest);
    return dest;
  } catch (e) {
    console.warn('Pre-upgrade backup could not be created:', (e as Error).message);
    return null;
  }
}

/** Version details for display and diagnostics. */
export function databaseInfo(d: DB = getDb()) {
  const current = currentSchemaVersion(d);
  return {
    schema_version: current,
    app_schema_version: APP_SCHEMA_VERSION,
    up_to_date: current === APP_SCHEMA_VERSION,
    newer_than_app: current > APP_SCHEMA_VERSION,
  };
}

export function runMigrations(d: DB, path?: string, isFreshFile = false) {
  let current = currentSchemaVersion(d);

  // Refuse to open a file created by a NEWER version of the app — operating on
  // a schema we don't understand could corrupt the books. Tell the user plainly.
  if (current > APP_SCHEMA_VERSION) {
    throw new Error(
      `This data was created by a newer version of Book of Business (data format v${current}; this app supports up to v${APP_SCHEMA_VERSION}). Please update the app to open it.`
    );
  }

  // Snapshot before applying pending migrations to a real, pre-existing file.
  // A brand-new file (just created in this same open) has no prior data to protect.
  if (!isFreshFile && current < APP_SCHEMA_VERSION && path && path !== ':memory:' && existsSync(path)) {
    backupBeforeUpgrade(d, path, current);
  }

  for (const m of MIGRATIONS) {
    if (m.version > current) {
      try {
        d.transaction(() => {
          d.exec(m.sql);
          d.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))").run(m.version);
        });
      } catch (e: any) {
        // If a migration's column-add is replayed on a file that already has it
        // (e.g. a version row was cleared on a file that was in fact upgraded),
        // SQLite reports a duplicate column. The schema change is already in
        // place, so record the version as applied and carry on rather than fail.
        if (/duplicate column name/i.test(String(e?.message ?? e))) {
          d.prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, datetime('now'))").run(m.version);
        } else {
          throw e;
        }
      }
      current = m.version;
    }
  }
}

/**
 * On-open consistency check (spec App.2 §12): every posted journal balances.
 * Throws loudly rather than letting a corrupted ledger go unnoticed.
 */
export function integrityCheck(d: DB) {
  const bad = d
    .prepare(
      `SELECT j.id, SUM(l.debit) AS dr, SUM(l.credit) AS cr
       FROM journals j JOIN journal_lines l ON l.journal_id = j.id
       WHERE j.status = 'POSTED'
       GROUP BY j.id HAVING SUM(l.debit) <> SUM(l.credit)`
    )
    .all();
  if (bad.length) {
    throw new Error(`Ledger integrity failure: ${bad.length} unbalanced journal(s): ${bad.map((b: any) => b.id).join(', ')}`);
  }
}
