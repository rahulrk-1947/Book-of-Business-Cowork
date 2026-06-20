/**
 * Demo dataset (spec App.2 §13). Everything is created THROUGH the services —
 * never by raw inserts — so all journals, totals, inventory values and FX
 * postings are produced by the same code paths a real user exercises.
 *
 * Dates are relative to "today" so the dashboard, aged reports and the
 * reconcile screen look alive on first launch, whenever that is.
 */
import { getDb } from '../db';
import * as contacts from '../services/contacts';
import * as items from '../services/items';
import * as invoices from '../services/invoices';
import * as payments from '../services/payments';
import * as banking from '../services/banking';
import * as assets from '../services/assets';
import * as journals from '../services/journals';
import * as settings from '../services/settings';

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/** today + offset days */
function day(offset: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offset);
  return iso(d);
}
/** first day of the month `offset` months ago, plus `dom-1` days */
function monthDay(monthsAgo: number, dom: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - monthsAgo, dom));
  return iso(d);
}

export function seedDemo() {
  const db = getDb();
  const already = db.prepare('SELECT COUNT(*) AS n FROM contacts').get();
  if (already.n > 0) return; // never seed twice

  const acc = (code: string): number => {
    const a = db.prepare('SELECT id FROM accounts WHERE code = ?').get(code);
    if (!a) throw new Error(`Demo seed: account ${code} missing`);
    return a.id;
  };

  settings.updateOrganisation({
    legal_name: 'Book of Business Demo Co',
    trading_name: 'Book of Business Demo',
    tax_number: '12-3456789',
  });

  // ── Currencies ──────────────────────────────────────────────────────────
  settings.setExchangeRate('EUR', monthDay(2, 1), 1.08);
  settings.setExchangeRate('EUR', day(-10), 1.12);
  settings.setExchangeRate('GBP', monthDay(2, 1), 1.27);

  // ── Contacts ────────────────────────────────────────────────────────────
  const c = (input: any) => contacts.save(input).id as number;
  const cityLimos = c({ name: 'City Limousines', is_customer: true, email: 'accounts@citylimos.example', phone: '555-0101', payment_terms_sales: 14 });
  const ridgeway = c({ name: 'Ridgeway University', is_customer: true, email: 'ap@ridgeway.example', phone: '555-0102', payment_terms_sales: 30 });
  const marine = c({ name: 'Marine Systems Ltd', is_customer: true, email: 'finance@marinesys.example', payment_terms_sales: 14 });
  const boomFm = c({ name: 'Boom FM', is_customer: true, email: 'billing@boomfm.example' });
  const berlin = c({ name: 'Berlin Digital GmbH', is_customer: true, email: 'rechnung@berlindigital.example', currency_code_default: 'EUR' });
  const powerDirect = c({ name: 'PowerDirect Energy', is_supplier: true, email: 'billing@powerdirect.example' });
  const netConnect = c({ name: 'Net Connect ISP', is_supplier: true, email: 'accounts@netconnect.example' });
  const truxton = c({ name: 'Truxton Office Supplies', is_supplier: true, email: 'sales@truxton.example' });
  const capitalIns = c({ name: 'Capital Insurance', is_supplier: true });
  const widgetWorks = c({ name: 'Widget Works Manufacturing', is_supplier: true, email: 'orders@widgetworks.example' });
  const landlord = c({ name: 'Harbourview Properties', is_supplier: true });

  // ── Items ───────────────────────────────────────────────────────────────
  const widgetA = items.save({
    code: 'WIDGET-A', name: 'Premium Widget', is_tracked: true, i_sell: true, i_purchase: true,
    sales_unit_price: 9500, sales_account_id: acc('200'), sales_tax_rate_id: 3, description_sales: 'Premium Widget',
    purchase_unit_price: 4500, purchase_tax_rate_id: 4, description_purchase: 'Premium Widget (wholesale)',
    inventory_asset_account_id: acc('630'), cogs_account_id: acc('310'),
  }).id as number;
  const widgetB = items.save({
    code: 'WIDGET-B', name: 'Standard Widget', is_tracked: true, i_sell: true, i_purchase: true,
    sales_unit_price: 5500, sales_account_id: acc('200'), sales_tax_rate_id: 3,
    purchase_unit_price: 2750, purchase_tax_rate_id: 4,
    inventory_asset_account_id: acc('630'), cogs_account_id: acc('310'),
  }).id as number;
  items.save({
    code: 'CONSULT', name: 'Consulting (hourly)', is_tracked: false, i_sell: true,
    sales_unit_price: 15000, sales_account_id: acc('200'), sales_tax_rate_id: 3,
  });
  items.save({
    code: 'SUPPORT', name: 'Monthly support retainer', is_tracked: false, i_sell: true,
    sales_unit_price: 50000, sales_account_id: acc('200'), sales_tax_rate_id: 3,
  });

  const TAX_SALES = 3;
  const TAX_PURCH = 4;
  const bank = acc('090');
  const savings = acc('091');

  // ── Stock purchases (bills) ─────────────────────────────────────────────
  const stockBill1 = invoices.saveDraft({
    type: 'ACCPAY', contact_id: widgetWorks, date: monthDay(2, 3), due_date: monthDay(2, 17), reference: 'WW-7841',
    lines: [
      { item_id: widgetA, description: 'Premium Widget (wholesale)', quantity: 40, unit_amount: 4500, account_id: acc('310'), tax_rate_id: TAX_PURCH },
      { item_id: widgetB, description: 'Standard Widget (wholesale)', quantity: 60, unit_amount: 2750, account_id: acc('310'), tax_rate_id: TAX_PURCH },
    ],
  });
  invoices.approve(stockBill1.id);
  const stockBill2 = invoices.saveDraft({
    type: 'ACCPAY', contact_id: widgetWorks, date: monthDay(0, 2), due_date: day(12), reference: 'WW-8102',
    lines: [{ item_id: widgetA, description: 'Premium Widget (wholesale) — price rise', quantity: 20, unit_amount: 4800, account_id: acc('310'), tax_rate_id: TAX_PURCH }],
  });
  invoices.approve(stockBill2.id); // awaiting payment → AP

  // ── Operating bills (monthly utilities/rent/insurance) ─────────────────
  const opBills: number[] = [];
  for (let m = 2; m >= 0; m--) {
    const power = invoices.saveDraft({
      type: 'ACCPAY', contact_id: powerDirect, date: monthDay(m, 5), due_date: monthDay(m, 19), reference: `PD-${m}`,
      lines: [{ description: 'Electricity', quantity: 1, unit_amount: 18650, account_id: acc('453'), tax_rate_id: TAX_PURCH }],
    });
    invoices.approve(power.id);
    const net = invoices.saveDraft({
      type: 'ACCPAY', contact_id: netConnect, date: monthDay(m, 8), due_date: monthDay(m, 22), reference: `NC-${m}`,
      lines: [{ description: 'Fibre internet 1Gb', quantity: 1, unit_amount: 9900, account_id: acc('493'), tax_rate_id: TAX_PURCH }],
    });
    invoices.approve(net.id);
    const rent = invoices.saveDraft({
      type: 'ACCPAY', contact_id: landlord, date: monthDay(m, 1), due_date: monthDay(m, 7), reference: `Rent ${monthDay(m, 1).slice(0, 7)}`,
      lines: [{ description: 'Office rent', quantity: 1, unit_amount: 250000, account_id: acc('489'), tax_rate_id: TAX_PURCH }],
    });
    invoices.approve(rent.id);
    opBills.push(power.id, net.id, rent.id);
  }
  const insurance = invoices.saveDraft({
    type: 'ACCPAY', contact_id: capitalIns, date: monthDay(1, 12), due_date: day(-25), reference: 'POL-99231',
    lines: [{ description: 'Business insurance — annual premium instalment', quantity: 1, unit_amount: 64500, account_id: acc('433'), tax_rate_id: TAX_PURCH }],
  });
  invoices.approve(insurance.id); // left unpaid + overdue → aged payables
  const officeSupplies = invoices.saveDraft({
    type: 'ACCPAY', contact_id: truxton, date: day(-4), due_date: day(10),
    lines: [{ description: 'Stationery & toner', quantity: 1, unit_amount: 12340, account_id: acc('453'), tax_rate_id: TAX_PURCH }],
  }); // stays DRAFT

  // Pay bills for months 2 and 1 (singly or batch), each as bank SPEND payments.
  const paidBillPayments: Array<{ id: number; date: string; amount: number; payee: string }> = [];
  const payBill = (billId: number, date: string) => {
    const b = invoices.get(billId);
    const p = payments.create({
      type: 'SPEND', date, bank_account_id: bank, contact_id: b.contact_id,
      amount: b.amount_due, reference: b.reference ?? b.invoice_number,
      allocations: [{ invoice_id: billId, amount: b.amount_due }],
    });
    paidBillPayments.push({ id: p.id, date, amount: p.amount, payee: b.contact_name ?? '' });
    return p;
  };
  payBill(stockBill1.id, monthDay(2, 16));
  for (let i = 0; i < 6; i++) {
    // months 2 and 1 operating bills (3 each)
    const billId = opBills[i];
    const b = invoices.get(billId);
    payBill(billId, b.due_date);
  }

  // ── Sales invoices ──────────────────────────────────────────────────────
  const mkInvoice = (contact: number, date: string, dueDays: number, lines: any[]) => {
    const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: contact, date, due_date: day(dueDays), lines });
    invoices.approve(inv.id);
    return invoices.get(inv.id);
  };
  // Months 2 & 1: paid invoices
  const paidInvoicePayments: Array<{ id: number; date: string; amount: number; payee: string }> = [];
  const payInvoice = (invId: number, date: string) => {
    const i = invoices.get(invId);
    const p = payments.create({
      type: 'RECEIVE', date, bank_account_id: bank, contact_id: i.contact_id,
      amount: i.amount_due, reference: i.invoice_number,
      allocations: [{ invoice_id: invId, amount: i.amount_due }],
    });
    paidInvoicePayments.push({ id: p.id, date, amount: p.amount, payee: i.contact_name ?? '' });
  };

  for (let m = 2; m >= 1; m--) {
    const inv1 = invoices.saveDraft({
      type: 'ACCREC', contact_id: cityLimos, date: monthDay(m, 6), due_date: monthDay(m, 20),
      lines: [
        { item_id: widgetA, description: 'Premium Widget', quantity: 8, unit_amount: 9500, account_id: acc('200'), tax_rate_id: TAX_SALES },
        { description: 'Installation & consulting', quantity: 4, unit_amount: 15000, account_id: acc('200'), tax_rate_id: TAX_SALES },
      ],
    });
    invoices.approve(inv1.id);
    payInvoice(inv1.id, monthDay(m, 18));

    const inv2 = invoices.saveDraft({
      type: 'ACCREC', contact_id: ridgeway, date: monthDay(m, 12), due_date: monthDay(m, 26),
      lines: [
        { item_id: widgetB, description: 'Standard Widget', quantity: 15, unit_amount: 5500, account_id: acc('200'), tax_rate_id: TAX_SALES },
        { description: 'Monthly support retainer', quantity: 1, unit_amount: 50000, account_id: acc('200'), tax_rate_id: TAX_SALES },
      ],
    });
    invoices.approve(inv2.id);
    payInvoice(inv2.id, monthDay(m, 25));
  }

  // This month: a mix of open/overdue/draft
  const open1 = mkInvoice(marine, day(-9), 5, [
    { item_id: widgetA, description: 'Premium Widget', quantity: 12, unit_amount: 9500, account_id: acc('200'), tax_rate_id: TAX_SALES },
  ]);
  const overdue1 = mkInvoice(boomFm, day(-40), -26, [
    { description: 'Sponsorship package production', quantity: 1, unit_amount: 185000, account_id: acc('200'), tax_rate_id: TAX_SALES },
  ]);
  const open2 = mkInvoice(cityLimos, day(-3), 11, [
    { item_id: widgetB, description: 'Standard Widget', quantity: 20, unit_amount: 5500, account_id: acc('200'), tax_rate_id: TAX_SALES },
    { description: 'Consulting (hourly)', quantity: 6, unit_amount: 15000, account_id: acc('200'), tax_rate_id: TAX_SALES },
  ]);
  invoices.saveDraft({
    type: 'ACCREC', contact_id: ridgeway, date: day(0), due_date: day(14),
    lines: [{ description: 'Consulting (hourly)', quantity: 10, unit_amount: 15000, account_id: acc('200'), tax_rate_id: TAX_SALES }],
  }); // DRAFT

  // ── Credit note allocated against an open invoice ───────────────────────
  const cn = invoices.saveDraft({
    type: 'ACCRECCREDIT', contact_id: marine, date: day(-6), reference: `Credit re ${open1.invoice_number}`,
    lines: [{ item_id: widgetA, description: 'Returned: 2 × Premium Widget (damaged in transit)', quantity: 2, unit_amount: 9500, account_id: acc('200'), tax_rate_id: TAX_SALES }],
  });
  invoices.approve(cn.id);
  const cnDoc = invoices.get(cn.id);
  invoices.allocateCredit(cn.id, open1.id, cnDoc.total);

  // ── Foreign-currency invoice: raised @1.08, paid @1.12 → realised gain ──
  const fx = invoices.saveDraft({
    type: 'ACCREC', contact_id: berlin, date: monthDay(1, 9), due_date: monthDay(0, 9),
    currency_code: 'EUR', exchange_rate: 1.08,
    lines: [{ description: 'Software licence — EU annual', quantity: 1, unit_amount: 500000, account_id: acc('200'), tax_rate_id: 5 }],
  });
  invoices.approve(fx.id);
  const fxDoc = invoices.get(fx.id);
  payments.create({
    type: 'RECEIVE', date: day(-10), bank_account_id: bank, contact_id: berlin,
    amount: fxDoc.amount_due, currency_code: 'EUR', exchange_rate: 1.12, reference: fxDoc.invoice_number,
    allocations: [{ invoice_id: fx.id, amount: fxDoc.amount_due }],
  });

  // ── Quote & purchase order ──────────────────────────────────────────────
  const q = invoices.saveQuote({
    contact_id: ridgeway, date: day(-2), expiry_date: day(28), title: 'Campus widget rollout — Phase 2',
    lines: [
      { item_id: widgetA, description: 'Premium Widget', quantity: 30, unit_amount: 9000, account_id: acc('200'), tax_rate_id: TAX_SALES },
      { description: 'Installation & consulting', quantity: 16, unit_amount: 15000, account_id: acc('200'), tax_rate_id: TAX_SALES },
    ],
  });
  invoices.setQuoteStatus(q.id, 'SENT');
  invoices.savePO({
    contact_id: widgetWorks, date: day(-1), delivery_date: day(13), reference: 'Restock Q3',
    lines: [{ item_id: widgetB, description: 'Standard Widget (wholesale)', quantity: 80, unit_amount: 2750, account_id: acc('310'), tax_rate_id: TAX_PURCH }],
  });

  // ── Repeating invoice template (monthly retainer) ───────────────────────
  invoices.saveRepeating({
    type: 'ACCREC', contact_id: boomFm, unit: 'MONTH', interval_n: 1,
    start_date: monthDay(0, 28), next_run_date: monthDay(-1, 28), due_rule: 'NET14', save_as: 'DRAFT',
    reference: 'Monthly support retainer',
    lines: [{ description: 'Monthly support retainer', quantity: 1, unit_amount: 50000, account_id: acc('200'), tax_rate_id: TAX_SALES }],
  });

  // ── Spend money directly (bank fee + a transfer to savings) ────────────
  const fee = banking.createBankTransaction({
    type: 'SPEND', bank_account_id: bank, date: monthDay(0, 4), reference: 'Monthly account fee',
    line_amount_type: 'NOTAX',
    lines: [{ description: 'Bank account fee', quantity: 1, unit_amount: 1500, account_id: acc('404'), tax_rate_id: 2 }],
  });

  // Owner funds in (receive money to equity)
  banking.createBankTransaction({
    type: 'RECEIVE', bank_account_id: bank, date: monthDay(2, 1), reference: 'Owner funds introduced',
    line_amount_type: 'NOTAX',
    lines: [{ description: 'Opening capital', quantity: 1, unit_amount: 2000000, account_id: acc('970'), tax_rate_id: 2 }],
  });

  // ── Fixed asset: register + depreciate last month ───────────────────────
  const typeId = assets.saveType({ name: 'Computer Equipment', asset_account_id: acc('710'), accumulated_dep_account_id: acc('711'), expense_account_id: acc('420'), default_method: 'STRAIGHT_LINE', default_effective_life: 3 });
  const laptop = assets.save({
    name: 'MacBook Pro 16"', asset_number: 'FA-0001', asset_type_id: typeId, purchase_date: monthDay(2, 1),
    purchase_price: 320000, depreciation_method: 'STRAIGHT_LINE', effective_life: 3, residual_value: 20000,
    depreciation_start_date: monthDay(2, 1), serial_number: 'C02XL0AAJGH5',
  });
  assets.register(laptop.id);
  // depreciate through the end of last month
  const lastMonthEnd = (() => {
    const now = new Date();
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
    return iso(d);
  })();
  assets.runDepreciation(lastMonthEnd);

  // ── Manual journal: accrued wages ───────────────────────────────────────
  const mj = journals.saveDraft({
    narration: 'Accrued wages — month end', date: lastMonthEnd,
    lines: [
      { account_id: acc('477'), debit: 184000, description: 'Wages expense accrual' },
      { account_id: acc('825'), credit: 184000, description: 'Wages payable' },
    ],
  });
  journals.post(mj);

  // ── Bank rule ───────────────────────────────────────────────────────────
  banking.saveRule({
    name: 'PowerDirect → Office Expenses', direction: 'SPEND',
    conditions_json: JSON.stringify({ payee_contains: 'powerdirect' }),
    set_contact_id: powerDirect, set_account_id: acc('453'), set_tax_rate_id: TAX_PURCH,
  });

  // ── Bank statement import: real movements + a few extras ───────────────
  const fmt = (cents: number) => (cents / 100).toFixed(2);
  const rows: string[] = ['Date,Amount,Payee,Description'];
  for (const p of paidInvoicePayments) rows.push(`${p.date},${fmt(p.amount)},${p.payee},Customer payment`);
  for (const p of paidBillPayments) rows.push(`${p.date},${fmt(-p.amount)},${p.payee},Supplier payment`);
  rows.push(`${monthDay(0, 4)},${fmt(-1500)},Bank,Monthly account fee`);
  rows.push(`${day(-7)},${fmt(-50000)},Transfer to savings,Internal transfer`);
  rows.push(`${day(-5)},${fmt(-18650)},PowerDirect Energy,Direct debit — electricity`); // rule will suggest coding
  rows.push(`${day(-2)},${fmt(4210)},Interest,Monthly interest`);
  banking.importStatement(bank, 'demo-statement.csv', rows.join('\n'));

  // Reconcile most lines, leave the last few for the user to play with.
  const lines = banking.unreconciled(bank);
  const usedPayments = new Set<number>();
  for (const l of lines) {
    // Match each line to a DISTINCT payment: suggestions are by amount, so two
    // equal-value lines would otherwise both grab the first matching payment
    // (a payment can only settle one statement line).
    const s = (l.suggestion ?? []).find((x: any) => x.kind === 'PAYMENT' && !usedPayments.has(x.id));
    if (s) { banking.reconcileMatch(l.id, 'PAYMENT', s.id); usedPayments.add(s.id); }
    else if ((l.suggestion ?? []).find((x: any) => x.kind === 'BANKTXN' && l.reference === 'Monthly account fee')) {
      banking.reconcileMatch(l.id, 'BANKTXN', fee.id);
    }
    // transfer, direct debit and interest stay unreconciled → demo material
  }

  // A second profile so the user switcher means something from day one.
  settings.saveUser({ name: 'Sam Bookkeeper', email: 'sam@example.com' });

  // ── Tracking categories + tracked activity across recent months ────────
  // Gives the P&L/BS comparisons and the tracking filter real data to show.
  const regionId = settings.saveTrackingCategory({ name: 'Region', options: [{ name: 'North' }, { name: 'South' }] });
  const deptId = settings.saveTrackingCategory({ name: 'Department', options: [{ name: 'Consulting' }, { name: 'Workshop' }] });
  const cats = settings.listTracking();
  const opt = (cid: number, name: string) => cats.find((c: any) => c.id === cid).options.find((o: any) => o.name === name).id;
  const north = opt(regionId, 'North');
  const south = opt(regionId, 'South');
  const consulting = opt(deptId, 'Consulting');
  const workshop = opt(deptId, 'Workshop');

  const harbour = contacts.save({ name: 'Harbourview Hotels', is_customer: true }).id;
  const meridian = contacts.save({ name: 'Meridian Logistics', is_customer: true, is_supplier: true }).id;

  const trackedSale = (monthsAgo: number, dom: number, amt: number, desc: string, t1: number, t2: number) => {
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: monthsAgo % 2 === 0 ? harbour : meridian,
      date: monthDay(monthsAgo, dom), due_date: monthDay(monthsAgo, Math.min(dom + 14, 28)),
      lines: [{ description: desc, quantity: 1, unit_amount: amt, account_id: acc('200'), tax_rate_id: 3, tracking_option_1: t1, tracking_option_2: t2 }],
    });
    invoices.approve(inv.id);
  };
  trackedSale(4, 8, 180000, 'Consulting retainer', north, consulting);
  trackedSale(3, 12, 240000, 'Workshop series', south, workshop);
  trackedSale(2, 6, 150000, 'Consulting retainer', north, consulting);
  trackedSale(2, 20, 95000, 'Workshop day', south, workshop);
  trackedSale(1, 9, 210000, 'Consulting retainer', north, consulting);
  trackedSale(0, 5, 132000, 'Workshop day', south, workshop);

  const trackedBill = (monthsAgo: number, dom: number, amt: number, desc: string, t1: number) => {
    const bill = invoices.saveDraft({
      type: 'ACCPAY', contact_id: meridian, date: monthDay(monthsAgo, dom), due_date: monthDay(monthsAgo, Math.min(dom + 20, 28)),
      lines: [{ description: desc, quantity: 1, unit_amount: amt, account_id: acc('310'), tax_rate_id: 4, tracking_option_1: t1 }],
    });
    invoices.approve(bill.id);
  };
  trackedBill(3, 4, 60000, 'Venue hire', south);
  trackedBill(1, 15, 45000, 'Freight & materials', north);

  // A tracked accrual, posted, so manual journals carry tags too.
  const accrual = journals.saveDraft({
    narration: 'Accrued workshop facilitation fees', date: monthDay(0, 2),
    lines: [
      { description: 'Facilitation fees', account_id: acc('310'), debit: 38000, tax_rate_id: 2, tracking_option_1: south, tracking_option_2: workshop },
      { description: 'Accrual', account_id: acc('825'), credit: 38000, tax_rate_id: 2 },
    ],
  });
  journals.post(accrual);

  // savings account opening balance via transfer? keep simple: receive money into savings
  banking.createBankTransaction({
    type: 'RECEIVE', bank_account_id: savings, date: monthDay(2, 1), reference: 'Savings opening deposit',
    line_amount_type: 'NOTAX',
    lines: [{ description: 'Opening deposit', quantity: 1, unit_amount: 500000, account_id: acc('970'), tax_rate_id: 2 }],
  });
}
