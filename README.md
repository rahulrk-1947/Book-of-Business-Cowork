# Book of Business

Local-first, double-entry accounting for small business — a desktop app in the spirit of Xero. Everything lives in one SQLite file on your computer; nothing leaves your machine.

![stack](https://img.shields.io/badge/stack-Electron%20%2B%20React%20%2B%20TypeScript%20%2B%20SQLite-0078c8)

## What's inside

- **A real double-entry ledger.** Every business event — invoice, bill, payment, bank transaction, depreciation run, manual journal — posts a balanced journal through one engine (`src/backend/engine.ts`). An unbalanced posting is impossible: the engine throws, and an on-open integrity check verifies every posted journal still sums to zero.
- **Sales**: quotes → invoices (DRAFT → AUTHORISED → PAID), credit notes with allocation, repeating invoice templates with a scheduler, customer statements, branded PDF export.
- **Purchases**: purchase orders → bills, supplier credits, batch payments.
- **Bank**: multiple accounts, CSV and OFX statement import (hash-deduplicated), a Xero-style reconcile screen (match / create / pay invoice / transfer), bank rules, reconciliation report.
- **Inventory**: tracked items at moving average cost — purchases capitalise to the inventory asset account, sales relieve stock and post COGS automatically; negative stock is blocked.
- **Multi-currency**: documents capture an exchange rate; settling at a different rate posts realised currency gains/losses automatically.
- **Fixed assets**: register, straight-line or diminishing-value depreciation runs, disposal with gain/loss.
- **Reports**: P&L, Balance Sheet, Trial Balance, General Ledger (with drill-down), Aged Receivables/Payables, Cash Flow, Tax Summary — all derived from journal lines so they agree with each other by construction. CSV and PDF export.
- **Controls**: period lock dates, append-only audit log, voids post dated reversals (history is never destroyed), soft deletes, configurable tax rates with multi-component/compound support, document numbering sequences, users & roles.
- **Backup/restore**: one-click backup of the SQLite file; restore replaces all data (with a pre-restore safety copy).

On first launch the app seeds a full demo company — contacts, tracked stock, paid/open/overdue invoices, a foreign-currency sale with a realised FX gain, partly-reconciled bank statements, a registered asset with a depreciation run — all created through the real services so every journal is genuine.

## Getting started

Requires Node 20+ (Node 22+ recommended) and npm.

```bash
npm install
npm run dev        # vite dev server + Electron with devtools
```

### Web edition (zero-install)

```bash
npm run build:web  # → dist-web/web.html
```

Produces **one self-contained HTML file** — UI, accounting engine, and SQLite (compiled to WebAssembly) all inlined. Open it in any modern browser; no server, no install, no admin rights. Data persists in the browser's IndexedDB for that file's location, and Settings → Backup & data downloads/restores the underlying `.db` file (the same format as the desktop edition, so books move freely between the two). PDF export uses the browser's print dialog; CSV exports download directly.

Production build & packaged installers:

```bash
npm run build      # bundle main process + renderer
npm start          # run the built app
npm run dist       # electron-builder → AppImage / dmg / nsis
```

Tests (the engine, tax maths, and golden end-to-end scenarios):

```bash
npm test
```

### SQLite driver

The app prefers `better-sqlite3` (an optional dependency with prebuilt binaries). If it can't load — unusual runtime, no prebuilt binary — it falls back transparently to Node's built-in `node:sqlite`, which needs no native compilation. Both are synchronous, which is exactly right for an accounting engine: a posting is one transaction that fully commits or fully rolls back.

## Architecture

```
electron/main.ts        window, single 'api' IPC channel, PDF/CSV export, backup
electron/preload.ts     contextBridge → window.bridge
src/backend/
  engine.ts             postJournal / reverseJournal / locks / numbering / audit
  money.ts, tax.ts      integer-cents maths; round-per-line tax policy
  db.ts, sqlite.ts      schema bootstrap, migrations, integrity check, driver adapter
  registry.ts           'service.method' → function (the whole IPC surface)
  services/             accounts, contacts, invoices, payments, banking, items,
                        assets, journals, reports, dashboard, settings
  seed/demo.ts          demo dataset built through the services
src/ui/                 React renderer: hash router, Xero-like design system
tests/                  vitest: unit + golden scenario suite
```

Key invariants, enforced in code and covered by tests:

1. **Σ debits = Σ credits**, to the cent, on every posted journal.
2. **Money is integer cents** everywhere it's stored. Rounding is half-away-from-zero, per line, then summed.
3. **No posting on or before the lock date** — including voids, which fall forward to today.
4. **Nothing posted is ever edited or deleted**: corrections are dated reversing journals.
5. **Reports derive from journal lines**, so the P&L, Balance Sheet and Trial Balance can't disagree.

## Posting rules (worked examples)

| Event | Journal |
|---|---|
| Invoice $100 + 10% tax | Dr Accounts Receivable 110 / Cr Sales 100 / Cr Sales Tax 10 |
| Customer pays | Dr Bank 110 / Cr Accounts Receivable 110 |
| Bill $50 + 10% tax | Dr Expense 50, Dr Sales Tax 5 / Cr Accounts Payable 55 |
| Sell tracked stock | …plus Dr COGS / Cr Inventory at moving average cost |
| €1,000 invoice @1.08 paid @1.12 | AR relieved at 1.08, bank at 1.12, $40 → Realised Currency Gains |

## Scope notes

The schema (73 tables) covers more than the UI exposes. Implemented end-to-end: everything listed above. Present in schema but deferred from this release (per the spec's phasing): live bank feeds, payroll, projects & budgets UI, receipt OCR/inbox, online payment services, expense claims UI. The data model is ready for them.

## License

MIT.
