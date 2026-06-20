/**
 * Seeds a complete sample client: contacts, tracking categories, and a bit
 * over fifty transactions spread across the last six months — sales invoices
 * (paid, part-paid, outstanding), bills, a credit note, customer and supplier
 * payments, spend/receive money, and manual journals (one cash-flagged).
 *
 * Deterministic: the same profile always produces the same books, so tests
 * can pin exact counts and the ledger invariants.
 */
import { getDb } from '../db';
import * as contacts from '../services/contacts';
import * as invoices from '../services/invoices';
import * as journals from '../services/journals';
import * as settings from '../services/settings';
import * as banking from '../services/banking';
import { create as paymentsCreate } from '../services/payments';

const iso = (d: Date) => d.toISOString().slice(0, 10);
function monthDay(monthsAgo: number, dom: number): string {
  const now = new Date();
  return iso(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, Math.min(dom, 28))));
}

/** Small deterministic PRNG so every run builds identical books. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export type SampleProfile = {
  org: string;
  customers: string[];
  suppliers: string[];
  saleDescriptions: string[];
  billDescriptions: string[];
  cats: Array<{ name: string; options: [string, string] }>;
  /** Roughly the size of a typical sale, in cents. */
  scale: number;
  seed: number;
};

export const SAMPLE_PROFILES: SampleProfile[] = [
  {
    org: 'Northwind Traders Ltd',
    customers: ['Globex Retail Group', 'Pioneer Hardware', 'Summit Distributors', 'Cascade Outfitters', 'Beacon Supply Co'],
    suppliers: ['Pacific Freight Lines', 'Ironwood Manufacturing', 'Citywide Packaging', 'Atlas Insurance'],
    saleDescriptions: ['Wholesale order', 'Container consignment', 'Seasonal restock', 'Showroom order', 'Trade fair order'],
    billDescriptions: ['Freight & haulage', 'Raw materials', 'Packaging supplies', 'Warehouse insurance'],
    cats: [
      { name: 'Channel', options: ['Wholesale', 'Retail'] },
      { name: 'Region', options: ['East', 'West'] },
    ],
    scale: 240000,
    seed: 11,
  },
  {
    org: 'Harbour Café Pty Ltd',
    customers: ['Wharf Events Co', 'Bayside Offices', 'Marina Tours', 'Anchor Coworking', 'Seabreeze Weddings'],
    suppliers: ['Roastery Lane Coffee', 'Fresh Fields Produce', 'Sparkle Cleaning', 'Dockside Utilities'],
    saleDescriptions: ['Catering function', 'Coffee cart hire', 'Event package', 'Corporate morning tea', 'Private booking'],
    billDescriptions: ['Coffee beans', 'Produce delivery', 'Cleaning contract', 'Power & water'],
    cats: [
      { name: 'Location', options: ['Harbourside', 'CBD'] },
      { name: 'Daypart', options: ['Morning', 'Evening'] },
    ],
    scale: 60000,
    seed: 23,
  },
];

export function seedClientSample(profile: SampleProfile): { transactions: number } {
  const db = getDb();
  const rand = rng(profile.seed);
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)];
  const cents = (mult: number) => Math.max(2500, Math.round((profile.scale * mult * (0.6 + rand())) / 500) * 500);

  // Accounts straight from this book's own chart — never guessed codes.
  const bank = db.prepare('SELECT id FROM accounts WHERE is_bank_account = 1 ORDER BY code LIMIT 1').get()?.id;
  const revenue = db.prepare("SELECT id FROM accounts WHERE type = 'REVENUE' AND status='ACTIVE' ORDER BY code LIMIT 1").get()?.id;
  const expenseRows = db.prepare("SELECT id FROM accounts WHERE type = 'EXPENSE' AND status='ACTIVE' AND is_bank_account = 0 ORDER BY code LIMIT 6").all();
  const liability =
    db.prepare("SELECT id FROM accounts WHERE code = '825'").get()?.id ??
    db.prepare("SELECT id FROM accounts WHERE type = 'LIABILITY' AND status='ACTIVE' AND is_bank_account = 0 AND name NOT LIKE 'Accounts %' AND name NOT LIKE '%Tax%' ORDER BY code LIMIT 1").get()?.id;
  if (!bank || !revenue || !expenseRows.length || !liability) throw new Error('Sample seed needs the standard chart of accounts');
  const expense = () => pick(expenseRows).id as number;
  const salesTax = db.prepare("SELECT id FROM tax_rates WHERE status='ACTIVE' AND name LIKE '%Sales%' LIMIT 1").get()?.id ?? null;
  const purchTax = db.prepare("SELECT id FROM tax_rates WHERE status='ACTIVE' AND name LIKE '%Purchase%' LIMIT 1").get()?.id ?? null;

  // Tracking categories with both options each.
  const optIds: number[][] = profile.cats.map((c) => {
    const id = settings.saveTrackingCategory({ name: c.name, options: c.options.map((name) => ({ name })) });
    const cat = settings.listTracking().find((x: any) => x.id === id);
    return cat.options.map((o: any) => o.id);
  });
  const t1 = () => optIds[0][Math.floor(rand() * optIds[0].length)];
  const t2 = () => optIds[1][Math.floor(rand() * optIds[1].length)];

  const customerIds = profile.customers.map((name) => contacts.save({ name, is_customer: true }).id as number);
  const supplierIds = profile.suppliers.map((name) => contacts.save({ name, is_supplier: true }).id as number);

  let txns = 0;

  // ── 16 sales invoices over six months ──────────────────────────────────
  const saleIds: number[] = [];
  for (let i = 0; i < 16; i++) {
    const m = i % 6; // months ago 0..5
    const date = monthDay(m, 3 + Math.floor(rand() * 22));
    const lines = [
      {
        description: pick(profile.saleDescriptions),
        quantity: 1,
        unit_amount: cents(1),
        account_id: revenue,
        tax_rate_id: salesTax,
        tracking_option_1: t1(),
        tracking_option_2: t2(),
      },
    ];
    if (rand() > 0.6) {
      lines.push({
        description: 'Delivery & setup',
        quantity: 1,
        unit_amount: cents(0.15),
        account_id: revenue,
        tax_rate_id: salesTax,
        tracking_option_1: t1(),
        tracking_option_2: t2(),
      });
    }
    const inv = invoices.saveDraft({
      type: 'ACCREC',
      contact_id: pick(customerIds),
      date,
      due_date: monthDay(m, 26),
      lines,
    });
    invoices.approve(inv.id);
    saleIds.push(inv.id);
    txns++;
  }

  // ── 10 bills ────────────────────────────────────────────────────────────
  const billIds: number[] = [];
  for (let i = 0; i < 10; i++) {
    const m = i % 6;
    const bill = invoices.saveDraft({
      type: 'ACCPAY',
      contact_id: pick(supplierIds),
      date: monthDay(m, 2 + Math.floor(rand() * 20)),
      due_date: monthDay(Math.max(0, m - 1), 10),
      lines: [
        {
          description: pick(profile.billDescriptions),
          quantity: 1,
          unit_amount: cents(0.4),
          account_id: expense(),
          tax_rate_id: purchTax,
          tracking_option_1: t1(),
        },
      ],
    });
    invoices.approve(bill.id);
    billIds.push(bill.id);
    txns++;
  }

  // ── 1 customer credit note (kept open) ─────────────────────────────────
  const credit = invoices.saveDraft({
    type: 'ACCRECCREDIT',
    contact_id: customerIds[0],
    date: monthDay(1, 18),
    lines: [
      { description: 'Returned goods', quantity: 1, unit_amount: cents(0.2), account_id: revenue, tax_rate_id: salesTax, tracking_option_1: t1() },
    ],
  });
  invoices.approve(credit.id);
  txns++;

  // ── Payments: 9 customer receipts (2 of them half-payments), 4 bill payments
  for (let i = 0; i < 9; i++) {
    const inv = invoices.get(saleIds[i]);
    const half = i < 2;
    const amount = half ? Math.round(inv.total / 2) : inv.amount_due;
    paymentsCreate({
      type: 'RECEIVE',
      date: monthDay(Math.max(0, (i % 6) - 1), 4 + Math.floor(rand() * 20)),
      bank_account_id: bank,
      contact_id: inv.contact_id,
      amount,
      allocations: [{ invoice_id: inv.id, amount }],
    });
    txns++;
  }
  for (let i = 0; i < 4; i++) {
    const bill = invoices.get(billIds[i]);
    paymentsCreate({
      type: 'SPEND',
      date: monthDay(Math.max(0, (i % 5) - 1), 6 + Math.floor(rand() * 18)),
      bank_account_id: bank,
      contact_id: bill.contact_id,
      amount: bill.amount_due,
      allocations: [{ invoice_id: bill.id, amount: bill.amount_due }],
    });
    txns++;
  }

  // ── 8 direct bank transactions: 5 spend, 3 receive ─────────────────────
  for (let i = 0; i < 5; i++) {
    banking.createBankTransaction({
      type: 'SPEND',
      bank_account_id: bank,
      contact_id: pick(supplierIds),
      date: monthDay(i % 6, 8 + Math.floor(rand() * 16)),
      line_amount_type: 'NOTAX',
      lines: [
        { description: pick(profile.billDescriptions), quantity: 1, unit_amount: cents(0.12), account_id: expense(), tax_rate_id: null, tracking_option_1: t1() },
      ],
    });
    txns++;
  }
  for (let i = 0; i < 3; i++) {
    banking.createBankTransaction({
      type: 'RECEIVE',
      bank_account_id: bank,
      contact_id: pick(customerIds),
      date: monthDay(i % 6, 10 + Math.floor(rand() * 14)),
      line_amount_type: 'NOTAX',
      lines: [
        { description: 'Counter sales', quantity: 1, unit_amount: cents(0.18), account_id: revenue, tax_rate_id: null, tracking_option_1: t1(), tracking_option_2: t2() },
      ],
    });
    txns++;
  }

  // ── 4 manual journals: accruals (one cash-flagged, one auto-reversing) ──
  const mkJournal = (monthsAgo: number, narration: string, amt: number, cashFlag: boolean) => {
    const id = journals.saveDraft({
      narration,
      date: monthDay(monthsAgo, 28),
      show_on_cash_basis: cashFlag,
      lines: [
        { description: narration, account_id: expense(), debit: amt, tracking_option_1: t1() },
        { description: 'Accrual', account_id: liability, credit: amt },
      ],
    });
    journals.post(id);
    txns++;
  };
  mkJournal(2, 'Accrued utilities — month end', cents(0.1), false);
  mkJournal(1, 'Accrued cleaning — month end', cents(0.08), false);
  mkJournal(1, 'Owner cash expense reimbursement', cents(0.05), true);
  mkJournal(0, 'Month-end wages accrual', cents(0.2), false);

  return { transactions: txns };
}
