-- ============================================================================
-- Xero-style Accounting Application — SQLite Schema (v1)
-- Implements the main design document + Appendix 1 + Appendix 2.
-- Money is stored as INTEGER minor units (cents) to avoid float errors.
-- Run with:  sqlite3 accounting.db < schema.sql
-- ============================================================================
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

-- ---------------------------------------------------------------------------
-- 0. Meta
-- ---------------------------------------------------------------------------
CREATE TABLE schema_version ( version INTEGER NOT NULL, applied_at TEXT NOT NULL );

CREATE TABLE organisations (
  id INTEGER PRIMARY KEY,
  legal_name TEXT NOT NULL,
  trading_name TEXT,
  registration_number TEXT,
  tax_number TEXT,
  base_currency TEXT NOT NULL DEFAULT 'USD',
  financial_year_end_month INTEGER NOT NULL DEFAULT 12,
  financial_year_end_day INTEGER NOT NULL DEFAULT 31,
  tax_basis TEXT NOT NULL DEFAULT 'ACCRUAL',          -- ACCRUAL | CASH
  timezone TEXT NOT NULL DEFAULT 'UTC',
  lock_date TEXT,                                     -- all users
  adviser_lock_date TEXT,                             -- advisers only
  logo_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- 1. Security: users, roles, permissions
-- ---------------------------------------------------------------------------
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  totp_secret TEXT,
  status TEXT NOT NULL DEFAULT 'ACTIVE',              -- ACTIVE | INVITED | DISABLED
  last_login TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE roles ( id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE );
CREATE TABLE permissions ( id INTEGER PRIMARY KEY, code TEXT NOT NULL UNIQUE, description TEXT );
CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id),
  permission_id INTEGER NOT NULL REFERENCES permissions(id),
  PRIMARY KEY (role_id, permission_id)
);
CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id),
  role_id INTEGER NOT NULL REFERENCES roles(id),
  PRIMARY KEY (user_id, role_id)
);

-- ---------------------------------------------------------------------------
-- 2. Currencies & exchange rates
-- ---------------------------------------------------------------------------
CREATE TABLE currencies (
  code TEXT PRIMARY KEY,                               -- ISO 4217, e.g. 'USD'
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE exchange_rates (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  currency_code TEXT NOT NULL REFERENCES currencies(code),
  rate REAL NOT NULL,                                 -- base units per 1 foreign unit
  UNIQUE (date, currency_code)
);

-- ---------------------------------------------------------------------------
-- 3. Tax rates & components
-- ---------------------------------------------------------------------------
CREATE TABLE tax_rates (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  tax_type TEXT NOT NULL DEFAULT 'NONE',              -- OUTPUT|INPUT|ZERORATED|EXEMPT|NONE|CAPITAL
  display_rate REAL NOT NULL DEFAULT 0,               -- total %, derived from components
  can_apply_to_sales INTEGER NOT NULL DEFAULT 1,
  can_apply_to_purchases INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE tax_components (
  id INTEGER PRIMARY KEY,
  tax_rate_id INTEGER NOT NULL REFERENCES tax_rates(id),
  name TEXT NOT NULL,
  percent REAL NOT NULL,
  is_compound INTEGER NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 4. Chart of accounts
-- ---------------------------------------------------------------------------
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                                 -- ASSET|LIABILITY|EQUITY|REVENUE|EXPENSE
  subtype TEXT,                                       -- BANK|AR|AP|CURRENT_ASSET|FIXED_ASSET|COGS...
  tax_rate_id_default INTEGER REFERENCES tax_rates(id),
  description TEXT,
  is_bank_account INTEGER NOT NULL DEFAULT 0,
  bank_currency TEXT REFERENCES currencies(code),
  bank_account_number TEXT,
  enable_payments INTEGER NOT NULL DEFAULT 0,
  system_account TEXT,                                -- AR|AP|BANK|GST|RETAINED_EARNINGS|ROUNDING...
  status TEXT NOT NULL DEFAULT 'ACTIVE'               -- ACTIVE | ARCHIVED
);

-- ---------------------------------------------------------------------------
-- 5. Tracking categories
-- ---------------------------------------------------------------------------
CREATE TABLE tracking_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE tracking_options (
  id INTEGER PRIMARY KEY,
  category_id INTEGER NOT NULL REFERENCES tracking_categories(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);

-- ---------------------------------------------------------------------------
-- 6. Contacts
-- ---------------------------------------------------------------------------
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  account_number TEXT,
  is_customer INTEGER NOT NULL DEFAULT 0,
  is_supplier INTEGER NOT NULL DEFAULT 0,
  email TEXT, phone TEXT, website TEXT,
  tax_number TEXT,
  currency_code_default TEXT REFERENCES currencies(code),
  payment_terms_sales TEXT,
  payment_terms_bills TEXT,
  sales_account_default INTEGER REFERENCES accounts(id),
  purchases_account_default INTEGER REFERENCES accounts(id),
  tax_rate_default INTEGER REFERENCES tax_rates(id),
  discount_percent_default REAL DEFAULT 0,
  credit_limit INTEGER,                               -- cents; NULL = none
  credit_limit_block INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE contact_addresses (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  type TEXT NOT NULL DEFAULT 'BILLING',               -- BILLING | DELIVERY
  line1 TEXT, line2 TEXT, city TEXT, region TEXT, postcode TEXT, country TEXT
);
CREATE TABLE contact_persons (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  first_name TEXT, last_name TEXT, email TEXT, phone TEXT,
  is_primary INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE contact_groups ( id INTEGER PRIMARY KEY, name TEXT NOT NULL );
CREATE TABLE contact_group_members (
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  group_id INTEGER NOT NULL REFERENCES contact_groups(id),
  PRIMARY KEY (contact_id, group_id)
);
CREATE TABLE smart_lists ( id INTEGER PRIMARY KEY, name TEXT NOT NULL, criteria_json TEXT, owner INTEGER REFERENCES users(id) );

-- ---------------------------------------------------------------------------
-- 7. General Ledger (the accounting engine)
-- ---------------------------------------------------------------------------
CREATE TABLE journals (
  id INTEGER PRIMARY KEY,
  journal_number TEXT,
  date TEXT NOT NULL,
  narration TEXT,
  source_type TEXT NOT NULL,                          -- INVOICE|BILL|PAYMENT|BANKTXN|MANUAL|DEPRN|FINDRECODE|FX...
  source_id INTEGER,
  status TEXT NOT NULL DEFAULT 'POSTED',              -- DRAFT|POSTED|VOID
  currency_code TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
  exchange_rate REAL NOT NULL DEFAULT 1,
  is_cash_basis INTEGER NOT NULL DEFAULT 0,
  reverses_journal_id INTEGER REFERENCES journals(id),
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  posted_at TEXT
);
CREATE TABLE journal_lines (
  id INTEGER PRIMARY KEY,
  journal_id INTEGER NOT NULL REFERENCES journals(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  description TEXT,
  debit INTEGER NOT NULL DEFAULT 0,                   -- cents, base currency
  credit INTEGER NOT NULL DEFAULT 0,                  -- cents, base currency
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  contact_id INTEGER REFERENCES contacts(id),
  tracking_option_1 INTEGER REFERENCES tracking_options(id),
  tracking_option_2 INTEGER REFERENCES tracking_options(id),
  CHECK (debit >= 0 AND credit >= 0),
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX ix_jl_account ON journal_lines(account_id);
CREATE INDEX ix_jl_journal ON journal_lines(journal_id);
CREATE INDEX ix_j_date ON journals(date);
CREATE INDEX ix_j_source ON journals(source_type, source_id);

-- ---------------------------------------------------------------------------
-- 8. Sales/Purchases documents (invoices, bills, credit notes share this)
-- ---------------------------------------------------------------------------
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                                 -- ACCREC|ACCPAY|ACCRECCREDIT|ACCPAYCREDIT
  invoice_number TEXT,
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  date TEXT NOT NULL,
  due_date TEXT,
  reference TEXT,
  currency_code TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
  exchange_rate REAL NOT NULL DEFAULT 1,
  line_amount_type TEXT NOT NULL DEFAULT 'EXCLUSIVE', -- EXCLUSIVE|INCLUSIVE|NOTAX
  branding_theme_id INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT',               -- DRAFT|SUBMITTED|AUTHORISED|PAID|VOIDED|DELETED
  sent_status TEXT,
  subtotal INTEGER NOT NULL DEFAULT 0,                -- cents
  total_tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  amount_paid INTEGER NOT NULL DEFAULT 0,
  amount_due INTEGER NOT NULL DEFAULT 0,
  expected_payment_date TEXT,
  fully_paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT
);
CREATE TABLE invoice_lines (
  id INTEGER PRIMARY KEY,
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  line_order INTEGER NOT NULL DEFAULT 0,
  item_id INTEGER,
  description TEXT NOT NULL,
  quantity REAL NOT NULL DEFAULT 1,
  unit_amount INTEGER NOT NULL DEFAULT 0,             -- cents
  discount_percent REAL NOT NULL DEFAULT 0,
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id),
  tracking_option_1 INTEGER REFERENCES tracking_options(id),
  tracking_option_2 INTEGER REFERENCES tracking_options(id),
  line_amount INTEGER NOT NULL DEFAULT 0,             -- net, cents
  tax_amount INTEGER NOT NULL DEFAULT 0,
  project_id INTEGER
);
CREATE INDEX ix_inv_contact ON invoices(contact_id, status);
CREATE INDEX ix_inv_due ON invoices(due_date);

-- 8b. Allocations of credit notes / prepayments / overpayments to invoices
CREATE TABLE credit_allocations (
  id INTEGER PRIMARY KEY,
  credit_invoice_id INTEGER NOT NULL REFERENCES invoices(id),   -- the credit note/overpayment
  target_invoice_id INTEGER NOT NULL REFERENCES invoices(id),   -- the invoice/bill it offsets
  date TEXT NOT NULL,
  amount INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 9. Quotes & Purchase Orders (no GL impact)
-- ---------------------------------------------------------------------------
CREATE TABLE quotes (
  id INTEGER PRIMARY KEY, quote_number TEXT, contact_id INTEGER NOT NULL REFERENCES contacts(id),
  title TEXT, summary TEXT, terms TEXT, date TEXT NOT NULL, expiry_date TEXT,
  currency_code TEXT REFERENCES currencies(code), line_amount_type TEXT DEFAULT 'EXCLUSIVE',
  status TEXT NOT NULL DEFAULT 'DRAFT',               -- DRAFT|SENT|ACCEPTED|DECLINED|INVOICED|EXPIRED
  subtotal INTEGER, total_tax INTEGER, total INTEGER
);
CREATE TABLE quote_lines (
  id INTEGER PRIMARY KEY, quote_id INTEGER NOT NULL REFERENCES quotes(id), line_order INTEGER,
  item_id INTEGER, description TEXT, quantity REAL, unit_amount INTEGER, discount_percent REAL,
  account_id INTEGER REFERENCES accounts(id), tax_rate_id INTEGER REFERENCES tax_rates(id),
  tracking_option_1 INTEGER, tracking_option_2 INTEGER, line_amount INTEGER
);
CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY, order_number TEXT, contact_id INTEGER NOT NULL REFERENCES contacts(id),
  date TEXT NOT NULL, delivery_date TEXT, reference TEXT,
  delivery_address TEXT, attention TEXT, delivery_instructions TEXT, telephone TEXT,
  currency_code TEXT REFERENCES currencies(code), line_amount_type TEXT DEFAULT 'EXCLUSIVE',
  status TEXT NOT NULL DEFAULT 'DRAFT',               -- DRAFT|SUBMITTED|APPROVED|BILLED
  subtotal INTEGER, total_tax INTEGER, total INTEGER
);
CREATE TABLE purchase_order_lines (
  id INTEGER PRIMARY KEY, purchase_order_id INTEGER NOT NULL REFERENCES purchase_orders(id), line_order INTEGER,
  item_id INTEGER, description TEXT, quantity REAL, unit_amount INTEGER, discount_percent REAL,
  account_id INTEGER REFERENCES accounts(id), tax_rate_id INTEGER REFERENCES tax_rates(id),
  tracking_option_1 INTEGER, tracking_option_2 INTEGER, line_amount INTEGER
);

-- ---------------------------------------------------------------------------
-- 10. Payments & allocations
-- ---------------------------------------------------------------------------
CREATE TABLE payments (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                                 -- RECEIVE | SPEND
  date TEXT NOT NULL,
  bank_account_id INTEGER NOT NULL REFERENCES accounts(id),
  contact_id INTEGER REFERENCES contacts(id),
  amount INTEGER NOT NULL,                            -- cents, in payment currency
  currency_code TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
  exchange_rate REAL NOT NULL DEFAULT 1,
  reference TEXT,
  payment_method TEXT,                                -- CASH|CHEQUE|CARD|TRANSFER|ONLINE
  cheque_number TEXT,
  batch_id INTEGER,
  status TEXT NOT NULL DEFAULT 'POSTED',
  journal_id INTEGER REFERENCES journals(id)
);
CREATE TABLE payment_allocations (
  id INTEGER PRIMARY KEY,
  payment_id INTEGER NOT NULL REFERENCES payments(id),
  invoice_id INTEGER NOT NULL REFERENCES invoices(id),
  amount INTEGER NOT NULL
);
CREATE TABLE payment_batches (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, bank_account_id INTEGER REFERENCES accounts(id),
  reference TEXT, total INTEGER, type TEXT                     -- BATCH_PAY | BATCH_DEPOSIT
);

-- ---------------------------------------------------------------------------
-- 11. Bank: statement lines, transactions, transfers, rules, feeds
-- ---------------------------------------------------------------------------
CREATE TABLE bank_transactions (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,                                 -- SPEND | RECEIVE
  bank_account_id INTEGER NOT NULL REFERENCES accounts(id),
  contact_id INTEGER REFERENCES contacts(id),
  date TEXT NOT NULL,
  reference TEXT,
  currency_code TEXT NOT NULL DEFAULT 'USD' REFERENCES currencies(code),
  exchange_rate REAL NOT NULL DEFAULT 1,
  line_amount_type TEXT NOT NULL DEFAULT 'EXCLUSIVE',
  subtotal INTEGER, total_tax INTEGER, total INTEGER,
  payment_method TEXT, cheque_number TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED',
  journal_id INTEGER REFERENCES journals(id)
);
CREATE TABLE bank_transaction_lines (
  id INTEGER PRIMARY KEY, bank_transaction_id INTEGER NOT NULL REFERENCES bank_transactions(id),
  line_order INTEGER, description TEXT, quantity REAL DEFAULT 1, unit_amount INTEGER,
  account_id INTEGER NOT NULL REFERENCES accounts(id), tax_rate_id INTEGER REFERENCES tax_rates(id),
  tracking_option_1 INTEGER, tracking_option_2 INTEGER, line_amount INTEGER, tax_amount INTEGER,
  project_id INTEGER
);
CREATE TABLE bank_transfers (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL,
  from_account_id INTEGER NOT NULL REFERENCES accounts(id),
  to_account_id INTEGER NOT NULL REFERENCES accounts(id),
  amount INTEGER NOT NULL, to_amount INTEGER, reference TEXT,
  journal_id INTEGER REFERENCES journals(id)
);
CREATE TABLE bank_statement_lines (
  id INTEGER PRIMARY KEY,
  bank_account_id INTEGER NOT NULL REFERENCES accounts(id),
  date TEXT NOT NULL,
  amount INTEGER NOT NULL,                            -- signed cents: + in, - out
  payee TEXT, reference TEXT, description TEXT,
  imported_hash TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'UNRECONCILED',        -- UNRECONCILED | RECONCILED
  reconciled_source_type TEXT, reconciled_source_id INTEGER,
  reconciled_at TEXT
);
CREATE INDEX ix_bsl_acct ON bank_statement_lines(bank_account_id, status);
CREATE TABLE bank_rules (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, direction TEXT,    -- SPEND | RECEIVE
  conditions_json TEXT, set_contact_id INTEGER REFERENCES contacts(id),
  set_account_id INTEGER REFERENCES accounts(id), set_tax_rate_id INTEGER REFERENCES tax_rates(id),
  set_tracking_option_1 INTEGER, set_tracking_option_2 INTEGER, priority INTEGER DEFAULT 0
);
CREATE TABLE bank_feeds (
  id INTEGER PRIMARY KEY, bank_account_id INTEGER NOT NULL REFERENCES accounts(id),
  provider TEXT, connection_ref TEXT, status TEXT, last_refresh_at TEXT, consent_expiry TEXT
);

-- ---------------------------------------------------------------------------
-- 12. Inventory items & movements
-- ---------------------------------------------------------------------------
CREATE TABLE items (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  is_tracked INTEGER NOT NULL DEFAULT 0,
  i_sell INTEGER NOT NULL DEFAULT 1,
  i_purchase INTEGER NOT NULL DEFAULT 0,
  sales_unit_price INTEGER, sales_account_id INTEGER REFERENCES accounts(id),
  sales_tax_rate_id INTEGER REFERENCES tax_rates(id), description_sales TEXT,
  purchase_unit_price INTEGER, purchase_account_id INTEGER REFERENCES accounts(id),
  purchase_tax_rate_id INTEGER REFERENCES tax_rates(id), description_purchase TEXT,
  inventory_asset_account_id INTEGER REFERENCES accounts(id),
  cogs_account_id INTEGER REFERENCES accounts(id),
  quantity_on_hand REAL NOT NULL DEFAULT 0,
  total_value INTEGER NOT NULL DEFAULT 0,             -- cents
  average_cost INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'ACTIVE'
);
CREATE TABLE inventory_movements (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id),
  date TEXT NOT NULL, source_type TEXT, source_id INTEGER,
  qty_delta REAL NOT NULL, unit_cost INTEGER, value_delta INTEGER,
  balance_qty REAL, balance_value INTEGER
);

-- ---------------------------------------------------------------------------
-- 13. Fixed assets
-- ---------------------------------------------------------------------------
CREATE TABLE asset_types (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL,
  asset_account_id INTEGER REFERENCES accounts(id),
  accumulated_dep_account_id INTEGER REFERENCES accounts(id),
  expense_account_id INTEGER REFERENCES accounts(id),
  default_method TEXT, default_rate REAL, default_effective_life REAL
);
CREATE TABLE fixed_assets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, asset_number TEXT,
  asset_type_id INTEGER REFERENCES asset_types(id),
  purchase_date TEXT NOT NULL, purchase_price INTEGER NOT NULL,
  serial_number TEXT, warranty_expiry TEXT, description TEXT,
  depreciation_method TEXT NOT NULL DEFAULT 'STRAIGHT_LINE', -- STRAIGHT_LINE|DIMINISHING|NONE|FULL
  rate REAL, effective_life REAL, averaging_method TEXT,
  depreciation_start_date TEXT, cost_limit INTEGER, residual_value INTEGER DEFAULT 0,
  accumulated_depreciation INTEGER NOT NULL DEFAULT 0,
  book_value INTEGER,
  status TEXT NOT NULL DEFAULT 'DRAFT',               -- DRAFT|REGISTERED|DISPOSED
  disposal_date TEXT, disposal_proceeds INTEGER
);
CREATE TABLE depreciation_runs ( id INTEGER PRIMARY KEY, period_end TEXT NOT NULL, status TEXT, created_at TEXT );
CREATE TABLE depreciation_entries (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES depreciation_runs(id),
  asset_id INTEGER NOT NULL REFERENCES fixed_assets(id), amount INTEGER NOT NULL,
  journal_id INTEGER REFERENCES journals(id)
);

-- ---------------------------------------------------------------------------
-- 14. Expense claims
-- ---------------------------------------------------------------------------
CREATE TABLE expense_claims (
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'DRAFT',               -- DRAFT|SUBMITTED|APPROVED|PAID|DECLINED
  total INTEGER NOT NULL DEFAULT 0, submitted_at TEXT, approved_by INTEGER REFERENCES users(id),
  paid_at TEXT, journal_id INTEGER REFERENCES journals(id)
);
CREATE TABLE expense_claim_lines (
  id INTEGER PRIMARY KEY, claim_id INTEGER NOT NULL REFERENCES expense_claims(id),
  date TEXT NOT NULL, description TEXT, account_id INTEGER REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id), amount INTEGER NOT NULL,
  quantity REAL, unit_rate INTEGER, tracking_option_1 INTEGER, tracking_option_2 INTEGER,
  receipt_file_id INTEGER, contact_id INTEGER, project_id INTEGER, billable INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 15. Manual journals (document layer; posts to journals)
-- ---------------------------------------------------------------------------
CREATE TABLE manual_journals (
  id INTEGER PRIMARY KEY, narration TEXT NOT NULL, date TEXT NOT NULL,
  auto_reversing_date TEXT, show_on_cash_basis INTEGER NOT NULL DEFAULT 1,
  default_tax_type TEXT DEFAULT 'NOTAX', status TEXT NOT NULL DEFAULT 'DRAFT',
  journal_id INTEGER REFERENCES journals(id)
);
CREATE TABLE manual_journal_lines (
  id INTEGER PRIMARY KEY, manual_journal_id INTEGER NOT NULL REFERENCES manual_journals(id),
  description TEXT, account_id INTEGER NOT NULL REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id), debit INTEGER NOT NULL DEFAULT 0,
  credit INTEGER NOT NULL DEFAULT 0, contact_id INTEGER, tracking_option_1 INTEGER, tracking_option_2 INTEGER
);

-- ---------------------------------------------------------------------------
-- 16. Repeating / recurring templates
-- ---------------------------------------------------------------------------
CREATE TABLE repeating_invoices (
  id INTEGER PRIMARY KEY, type TEXT NOT NULL,         -- ACCREC | ACCPAY
  contact_id INTEGER NOT NULL REFERENCES contacts(id),
  unit TEXT NOT NULL, interval_n INTEGER NOT NULL,    -- DAY|WEEK|MONTH ; every N
  start_date TEXT NOT NULL, end_date TEXT, due_rule TEXT,
  save_as TEXT NOT NULL DEFAULT 'DRAFT',              -- DRAFT|APPROVED|APPROVED_EMAIL
  reference TEXT, currency_code TEXT, branding_theme_id INTEGER,
  line_amount_type TEXT DEFAULT 'EXCLUSIVE', next_run_date TEXT, status TEXT DEFAULT 'ACTIVE'
);
CREATE TABLE repeating_invoice_lines (
  id INTEGER PRIMARY KEY, repeating_invoice_id INTEGER NOT NULL REFERENCES repeating_invoices(id),
  line_order INTEGER, item_id INTEGER, description TEXT, quantity REAL, unit_amount INTEGER,
  discount_percent REAL, account_id INTEGER REFERENCES accounts(id),
  tax_rate_id INTEGER REFERENCES tax_rates(id), tracking_option_1 INTEGER, tracking_option_2 INTEGER
);

-- ---------------------------------------------------------------------------
-- 17. Budgets
-- ---------------------------------------------------------------------------
CREATE TABLE budgets ( id INTEGER PRIMARY KEY, name TEXT NOT NULL, period_start TEXT, period_end TEXT, notes TEXT );
CREATE TABLE budget_lines (
  id INTEGER PRIMARY KEY, budget_id INTEGER NOT NULL REFERENCES budgets(id),
  account_id INTEGER NOT NULL REFERENCES accounts(id),
  tracking_option_1 INTEGER, tracking_option_2 INTEGER,
  period_date TEXT NOT NULL, amount INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- 18. Projects
-- ---------------------------------------------------------------------------
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
  billable INTEGER DEFAULT 1, invoiced INTEGER DEFAULT 0
);
CREATE TABLE project_expenses (
  id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES projects(id),
  source_type TEXT, source_id INTEGER, date TEXT, description TEXT,
  cost_amount INTEGER, markup_percent REAL, charge_amount INTEGER,
  billable INTEGER DEFAULT 1, invoiced INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 19. Files & document inbox
-- ---------------------------------------------------------------------------
CREATE TABLE files (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, mime_type TEXT, size_bytes INTEGER,
  storage_path TEXT NOT NULL, uploaded_by INTEGER REFERENCES users(id),
  uploaded_at TEXT NOT NULL DEFAULT (datetime('now')), folder TEXT
);
CREATE TABLE file_links (
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id),
  entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL
);
CREATE TABLE inbox_documents (
  id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL REFERENCES files(id),
  status TEXT NOT NULL DEFAULT 'NEW', ocr_json TEXT,
  suggested_contact_id INTEGER, suggested_total INTEGER, suggested_date TEXT,
  created_transaction_type TEXT, created_transaction_id INTEGER
);

-- ---------------------------------------------------------------------------
-- 20. Payment services & online payments
-- ---------------------------------------------------------------------------
CREATE TABLE payment_services (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, provider TEXT, config_json TEXT,
  fee_account_id INTEGER REFERENCES accounts(id), status TEXT DEFAULT 'ACTIVE'
);
CREATE TABLE online_payments (
  id INTEGER PRIMARY KEY, invoice_id INTEGER REFERENCES invoices(id),
  service_id INTEGER REFERENCES payment_services(id), provider_ref TEXT,
  amount INTEGER, fee_amount INTEGER, status TEXT, paid_at TEXT
);

-- ---------------------------------------------------------------------------
-- 21. Branding, email, number sequences, reminders
-- ---------------------------------------------------------------------------
CREATE TABLE branding_themes (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, logo_path TEXT, colors_json TEXT,
  terms TEXT, payment_advice TEXT, footer TEXT, applies_to TEXT
);
CREATE TABLE email_templates (
  id INTEGER PRIMARY KEY, document_type TEXT NOT NULL, subject TEXT, body TEXT,
  include_pdf INTEGER DEFAULT 1, include_payment_link INTEGER DEFAULT 0
);
CREATE TABLE number_sequences (
  id INTEGER PRIMARY KEY, document_type TEXT NOT NULL UNIQUE,   -- INVOICE|QUOTE|PO|CREDITNOTE|BILL|CHEQUE
  prefix TEXT, next_number INTEGER NOT NULL DEFAULT 1, padding INTEGER NOT NULL DEFAULT 4
);
CREATE TABLE invoice_reminders (
  id INTEGER PRIMARY KEY, days_offset INTEGER NOT NULL,         -- negative=before due, positive=after
  enabled INTEGER NOT NULL DEFAULT 1, min_amount INTEGER DEFAULT 0
);

-- ---------------------------------------------------------------------------
-- 22. Conversion balances
-- ---------------------------------------------------------------------------
CREATE TABLE conversion_balances (
  id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
  debit INTEGER NOT NULL DEFAULT 0, credit INTEGER NOT NULL DEFAULT 0, conversion_date TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 23. Find & Recode
-- ---------------------------------------------------------------------------
CREATE TABLE recode_batches (
  id INTEGER PRIMARY KEY, created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')), criteria_json TEXT,
  status TEXT NOT NULL DEFAULT 'POSTED', reversal_of INTEGER REFERENCES recode_batches(id),
  journal_id INTEGER REFERENCES journals(id)
);
CREATE TABLE recode_lines (
  id INTEGER PRIMARY KEY, batch_id INTEGER NOT NULL REFERENCES recode_batches(id),
  journal_line_id INTEGER, old_account INTEGER, new_account INTEGER,
  old_tax INTEGER, new_tax INTEGER, old_tracking INTEGER, new_tracking INTEGER,
  old_contact INTEGER, new_contact INTEGER
);

-- ---------------------------------------------------------------------------
-- 24. Custom reports
-- ---------------------------------------------------------------------------
CREATE TABLE report_definitions (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, base_report TEXT,
  layout_json TEXT, filters_json TEXT, owner INTEGER REFERENCES users(id),
  visibility TEXT DEFAULT 'ORG', status TEXT DEFAULT 'DRAFT'
);
CREATE TABLE report_publishes (
  id INTEGER PRIMARY KEY, definition_id INTEGER REFERENCES report_definitions(id),
  period TEXT, generated_at TEXT, author INTEGER REFERENCES users(id), snapshot_json TEXT
);
CREATE TABLE report_schedules (
  id INTEGER PRIMARY KEY, definition_id INTEGER REFERENCES report_definitions(id),
  frequency TEXT, recipients TEXT, next_run TEXT
);

-- ---------------------------------------------------------------------------
-- 25. Audit log (polymorphic) + History & Notes
-- ---------------------------------------------------------------------------
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
  action TEXT NOT NULL, before_json TEXT, after_json TEXT,
  user_id INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE notes (
  id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL,
  note TEXT NOT NULL, user_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX ix_audit_entity ON audit_log(entity_type, entity_id);

-- ============================================================================
-- SEED DATA (minimal — enough to start a real org)
-- ============================================================================
INSERT INTO schema_version (version, applied_at) VALUES (1, datetime('now'));

INSERT INTO currencies (code, name) VALUES
 ('USD','US Dollar'), ('EUR','Euro'), ('GBP','Pound Sterling'), ('AUD','Australian Dollar');

INSERT INTO organisations (id, legal_name, base_currency) VALUES (1, 'My Company Ltd', 'USD');

-- Tax rates
INSERT INTO tax_rates (id, name, tax_type, display_rate, status) VALUES
 (1,'Tax Exempt','EXEMPT',0,'ACTIVE'),
 (2,'No Tax','NONE',0,'ACTIVE'),
 (3,'Tax on Sales','OUTPUT',10,'ACTIVE'),
 (4,'Tax on Purchases','INPUT',10,'ACTIVE'),
 (5,'Zero Rated','ZERORATED',0,'ACTIVE');
INSERT INTO tax_components (tax_rate_id, name, percent, is_compound) VALUES
 (3,'Sales Tax',10,0), (4,'Purchase Tax',10,0);

-- Roles & permissions
INSERT INTO roles (id, name) VALUES (1,'Adviser'),(2,'Standard'),(3,'Read Only'),(4,'Invoice Only'),(5,'Payroll Admin');
INSERT INTO permissions (id, code, description) VALUES
 (1,'accounts.manage','Manage chart of accounts'),
 (2,'invoices.manage','Create/edit/approve invoices'),
 (3,'bills.manage','Create/edit/approve bills'),
 (4,'bank.reconcile','Reconcile bank accounts'),
 (5,'reports.view','View reports'),
 (6,'reports.publish','Publish reports'),
 (7,'journals.manage','Post manual journals'),
 (8,'findrecode.use','Use Find & Recode'),
 (9,'settings.manage','Manage org settings & users'),
 (10,'payroll.manage','Manage payroll');
-- Adviser gets everything
INSERT INTO role_permissions (role_id, permission_id)
 SELECT 1, id FROM permissions;
-- Standard: most operational permissions
INSERT INTO role_permissions (role_id, permission_id) VALUES
 (2,2),(2,3),(2,4),(2,5),(2,7);
-- Read only
INSERT INTO role_permissions (role_id, permission_id) VALUES (3,5);
-- Invoice only
INSERT INTO role_permissions (role_id, permission_id) VALUES (4,2);

-- Admin user (replace password_hash in app with a real Argon2/bcrypt hash)
INSERT INTO users (id, name, email, password_hash) VALUES
 (1,'Administrator','admin@example.com','REPLACE_WITH_HASH');
INSERT INTO user_roles (user_id, role_id) VALUES (1,1);

-- Default chart of accounts (codes follow a common convention)
INSERT INTO accounts (code,name,type,subtype,is_bank_account,enable_payments,system_account,tax_rate_id_default) VALUES
 ('090','Business Bank Account','ASSET','BANK',1,1,'BANK',2),
 ('091','Business Savings Account','ASSET','BANK',1,0,NULL,2),
 ('610','Accounts Receivable','ASSET','AR',0,0,'AR',2),
 ('620','Prepayments','ASSET','CURRENT_ASSET',0,0,NULL,2),
 ('630','Inventory','ASSET','CURRENT_ASSET',0,0,'INVENTORY',2),
 ('710','Office Equipment','ASSET','FIXED_ASSET',0,0,NULL,2),
 ('711','Less Accumulated Depreciation on Office Equipment','ASSET','FIXED_ASSET',0,0,NULL,2),
 ('800','Accounts Payable','LIABILITY','AP',0,0,'AP',2),
 ('820','Sales Tax','LIABILITY','CURRENT_LIABILITY',0,0,'GST',2),
 ('825','Wages Payable','LIABILITY','CURRENT_LIABILITY',0,0,'WAGES_PAYABLE',2),
 ('830','Unpaid Expense Claims','LIABILITY','CURRENT_LIABILITY',0,0,'EXPENSE_CLAIMS',2),
 ('960','Retained Earnings','EQUITY','EQUITY',0,0,'RETAINED_EARNINGS',2),
 ('970','Owner Funds Introduced','EQUITY','EQUITY',0,0,NULL,2),
 ('200','Sales','REVENUE','REVENUE',0,0,NULL,3),
 ('260','Other Revenue','REVENUE','REVENUE',0,0,NULL,3),
 ('270','Interest Income','REVENUE','REVENUE',0,0,NULL,2),
 ('310','Cost of Goods Sold','EXPENSE','COGS',0,0,'COGS',4),
 ('400','Advertising','EXPENSE','EXPENSE',0,0,NULL,4),
 ('404','Bank Fees','EXPENSE','EXPENSE',0,0,NULL,2),
 ('408','Cleaning','EXPENSE','EXPENSE',0,0,NULL,4),
 ('412','Consulting & Accounting','EXPENSE','EXPENSE',0,0,NULL,4),
 ('420','Depreciation','EXPENSE','EXPENSE',0,0,'DEPRECIATION',2),
 ('429','General Expenses','EXPENSE','EXPENSE',0,0,NULL,4),
 ('433','Insurance','EXPENSE','EXPENSE',0,0,NULL,4),
 ('449','Motor Vehicle Expenses','EXPENSE','EXPENSE',0,0,NULL,4),
 ('453','Office Expenses','EXPENSE','EXPENSE',0,0,NULL,4),
 ('477','Wages and Salaries','EXPENSE','EXPENSE',0,0,NULL,2),
 ('489','Rent','EXPENSE','EXPENSE',0,0,NULL,4),
 ('493','Telephone & Internet','EXPENSE','EXPENSE',0,0,NULL,4),
 ('497','Bank Revaluations','EXPENSE','EXPENSE',0,0,NULL,2),
 ('498','Unrealised Currency Gains','EXPENSE','EXPENSE',0,0,'UNREALISED_FX',2),
 ('499','Realised Currency Gains','EXPENSE','EXPENSE',0,0,'REALISED_FX',2),
 ('421','Gain/Loss on Asset Disposal','EXPENSE','EXPENSE',0,0,'DISPOSAL_GAINLOSS',2),
 ('860','Rounding','LIABILITY','CURRENT_LIABILITY',0,0,'ROUNDING',2),
 ('840','Historical Adjustment','EQUITY','EQUITY',0,0,'HISTORICAL',2);

-- Number sequences
INSERT INTO number_sequences (document_type, prefix, next_number, padding) VALUES
 ('INVOICE','INV-',1,4), ('QUOTE','QU-',1,4), ('PO','PO-',1,4),
 ('CREDITNOTE','CN-',1,4), ('BILL','BILL-',1,4), ('CHEQUE','CHQ-',1,4);

-- A default branding theme + email templates
INSERT INTO branding_themes (id,name,applies_to) VALUES (1,'Standard','ALL');
INSERT INTO email_templates (document_type, subject, body) VALUES
 ('INVOICE','Invoice {number} from {org}','Hi {contact},\n\nPlease find invoice {number} for {total} attached, due {due_date}.\n\nThanks.'),
 ('QUOTE','Quote {number} from {org}','Hi {contact},\n\nPlease find quote {number} attached.\n\nThanks.');

-- Default invoice reminders
INSERT INTO invoice_reminders (days_offset, enabled) VALUES (-7,1),(0,1),(7,1),(14,1),(28,1);

-- ============================================================================
-- HELPER VIEW: general ledger balances (posted only)
-- ============================================================================
CREATE VIEW v_account_balances AS
SELECT a.id AS account_id, a.code, a.name, a.type,
       COALESCE(SUM(jl.debit),0)  AS total_debit,
       COALESCE(SUM(jl.credit),0) AS total_credit,
       COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0) AS balance_dr_cr
FROM accounts a
LEFT JOIN journal_lines jl ON jl.account_id = a.id
LEFT JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED'
GROUP BY a.id, a.code, a.name, a.type;

-- Trial balance sanity view (debits should equal credits across all posted journals)
CREATE VIEW v_trial_balance_check AS
SELECT COALESCE(SUM(jl.debit),0) AS total_debit, COALESCE(SUM(jl.credit),0) AS total_credit
FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id AND j.status = 'POSTED';
