import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as itemsSvc from '../src/backend/services/items';
import * as invoices from '../src/backend/services/invoices';
import * as journals from '../src/backend/services/journals';
import * as reports from '../src/backend/services/reports';
import * as settings from '../src/backend/services/settings';
import { create as paymentsCreate } from '../src/backend/services/payments';
import * as attachmentsSvc from '../src/backend/services/attachments';

let acc: (code: string) => number;
beforeEach(() => {
  initDatabase(':memory:');
  const db = getDb();
  acc = (code: string) => db.prepare('SELECT id FROM accounts WHERE code = ?').get(code).id;
});

function bal(code: string): number {
  return Number(
    getDb()
      .prepare(
        `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS b FROM journal_lines jl
         JOIN journals j ON j.id = jl.journal_id AND j.status='POSTED'
         WHERE jl.account_id = (SELECT id FROM accounts WHERE code = ?)`
      )
      .get(code).b
  );
}

describe('copy documents', () => {
  it('copies an invoice into a fresh draft with the same lines', () => {
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-01', due_date: '2026-03-15',
      lines: [{ description: 'Thing', quantity: 3, unit_amount: 4000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(inv.id);
    const dup = invoices.copy(inv.id);
    expect(dup.id).not.toBe(inv.id);
    expect(dup.status).toBe('DRAFT');
    expect(dup.total).toBe(inv.total);
    expect(dup.lines).toHaveLength(1);
    expect(dup.lines[0].quantity).toBe(3);
    // copying never touches the ledger
    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
  });

  it('copies a manual journal', () => {
    const mj = journals.saveDraft({
      narration: 'Accrual', date: '2026-03-31',
      lines: [
        { account_id: acc('477'), debit: 1000 },
        { account_id: acc('825'), credit: 1000 },
      ],
    });
    journals.post(mj);
    const dup = journals.copy(mj);
    expect(dup.status).toBe('DRAFT');
    expect(dup.lines).toHaveLength(2);
    expect(dup.narration).toBe('Accrual');
  });
});

describe('edit approved (revert to draft)', () => {
  it('reverses postings and stock, then re-approval posts cleanly', () => {
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    const sup = contacts.save({ name: 'S', is_supplier: true }).id;
    const item = itemsSvc.save({
      code: 'W', name: 'Widget', is_tracked: true, i_sell: true, i_purchase: true,
      sales_unit_price: 9000, sales_account_id: acc('200'), sales_tax_rate_id: 3,
      purchase_unit_price: 4000, purchase_tax_rate_id: 4,
      inventory_asset_account_id: acc('630'), cogs_account_id: acc('310'),
    }).id;
    const buy = invoices.saveDraft({
      type: 'ACCPAY', contact_id: sup, date: '2026-03-01',
      lines: [{ item_id: item, description: 'W', quantity: 10, unit_amount: 4000, account_id: acc('310'), tax_rate_id: 4 }],
    });
    invoices.approve(buy.id);
    const sell = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-05',
      lines: [{ item_id: item, description: 'W', quantity: 4, unit_amount: 9000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(sell.id);
    expect(itemsSvc.get(item).quantity_on_hand).toBe(6);
    expect(bal('310')).toBe(16000);

    const back = invoices.revertToDraft(sell.id);
    expect(back.status).toBe('DRAFT');
    expect(itemsSvc.get(item).quantity_on_hand).toBe(10); // stock restored
    expect(bal('310')).toBe(0);
    expect(bal('610')).toBe(0);

    // edit quantity and re-approve
    invoices.saveDraft({
      id: sell.id, type: 'ACCREC', contact_id: cust, date: '2026-03-05',
      lines: [{ item_id: item, description: 'W', quantity: 2, unit_amount: 9000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(sell.id);
    expect(itemsSvc.get(item).quantity_on_hand).toBe(8);
    expect(invoices.get(sell.id).invoice_number).toBe(sell.invoice_number ?? invoices.get(sell.id).invoice_number);
    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
  });

  it('blocks revert once paid', () => {
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-01',
      lines: [{ description: 'X', quantity: 1, unit_amount: 5000, account_id: acc('200'), tax_rate_id: 2 }],
    });
    invoices.approve(inv.id);
    
    paymentsCreate({
      type: 'RECEIVE', date: '2026-03-02', bank_account_id: acc('090'), contact_id: cust,
      amount: 5000, allocations: [{ invoice_id: inv.id, amount: 5000 }],
    });
    expect(() => invoices.revertToDraft(inv.id)).toThrow(/payment/i);
  });

  it('reverts a posted manual journal to draft', () => {
    const mj = journals.saveDraft({
      narration: 'Adj', date: '2026-03-31',
      lines: [
        { account_id: acc('477'), debit: 2500 },
        { account_id: acc('825'), credit: 2500 },
      ],
    });
    journals.post(mj);
    expect(bal('825')).toBe(-2500);
    const back = journals.revertToDraft(mj);
    expect(back.status).toBe('DRAFT');
    expect(bal('825')).toBe(0);
    journals.post(mj); // edits then reposts fine
    expect(bal('825')).toBe(-2500);
  });
});

describe('multi-period P&L comparison', () => {
  it('returns one column per requested period', () => {
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    for (const [date, amt] of [
      ['2026-01-10', 10000], ['2026-02-10', 20000], ['2026-03-10', 30000],
    ] as const) {
      const inv = invoices.saveDraft({
        type: 'ACCREC', contact_id: cust, date,
        lines: [{ description: 'Work', quantity: 1, unit_amount: amt, account_id: acc('200'), tax_rate_id: 2 }],
      });
      invoices.approve(inv.id);
    }
    const r = reports.profitAndLoss({
      from: '2026-03-01', to: '2026-03-31',
      compare: [
        { from: '2026-02-01', to: '2026-02-28', label: 'Feb' },
        { from: '2026-01-01', to: '2026-01-31', label: 'Jan' },
      ],
    });
    expect(r.total_income).toBe(30000);
    expect(r.comparisons).toHaveLength(2);
    expect(r.comparisons[0].total_income).toBe(20000);
    expect(r.comparisons[1].total_income).toBe(10000);
    const csv = reports.exportCsv({ report: 'profit_and_loss', from: '2026-03-01', to: '2026-03-31', compare: r.comparisons.map((c: any) => ({ from: c.from, to: c.to, label: c.label })) });
    expect(csv.csv.split('\n')[0]).toContain('Feb');
  });
});

describe('tracking categories on the P&L', () => {
  it('filters revenue by tracking option', () => {
    const catId = settings.saveTrackingCategory({ name: 'Region', options: [{ name: 'North' }, { name: 'South' }] });
    const opts = settings.listTracking().find((c: any) => c.id === catId).options;
    const north = opts[0].id;
    const south = opts[1].id;
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    const mk = (amt: number, opt: number) => {
      const inv = invoices.saveDraft({
        type: 'ACCREC', contact_id: cust, date: '2026-03-10',
        lines: [{ description: 'Work', quantity: 1, unit_amount: amt, account_id: acc('200'), tax_rate_id: 2, tracking_option_1: opt }],
      });
      invoices.approve(inv.id);
    };
    mk(10000, north);
    mk(25000, south);
    const all = reports.profitAndLoss({ from: '2026-03-01', to: '2026-03-31' });
    expect(all.total_income).toBe(35000);
    const n = reports.profitAndLoss({ from: '2026-03-01', to: '2026-03-31', tracking_option_id: north });
    expect(n.total_income).toBe(10000);
    const s = reports.profitAndLoss({ from: '2026-03-01', to: '2026-03-31', tracking_option_id: south });
    expect(s.total_income).toBe(25000);
    // drill respects the same filter
    const drill = reports.accountTransactions({ account_id: acc('200'), from: '2026-03-01', to: '2026-03-31', tracking_option_id: north });
    expect(drill.lines).toHaveLength(1);
    expect(drill.total).toBe(-10000);
  });
});

describe('drill-down queries', () => {
  it('accountTransactions matches the report number; sources resolve', () => {
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-10',
      lines: [{ description: 'Work', quantity: 1, unit_amount: 50000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(inv.id);
    const pl = reports.profitAndLoss({ from: '2026-03-01', to: '2026-03-31' });
    const salesRow = pl.income.find((r: any) => r.code === '200')!;
    const drill = reports.accountTransactions({ account_id: salesRow.account_id, from: '2026-03-01', to: '2026-03-31' });
    expect(-drill.total).toBe(salesRow.amount); // credit-natural account
    expect(drill.lines[0].source_type).toBe('INVOICE');
    expect(drill.lines[0].source_id).toBe(inv.id);
    const js = journals.forSource('INVOICE', inv.id);
    expect(js).toHaveLength(1);
    expect(js[0].lines.length).toBeGreaterThanOrEqual(3);
    const taxLines = reports.taxRateLines({ tax_rate_id: 3, from: '2026-03-01', to: '2026-03-31' });
    expect(taxLines).toHaveLength(1);
    expect(taxLines[0].invoice_id).toBe(inv.id);
  });

  it('cash_only restricts to journals that touch the bank', () => {
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-10',
      lines: [{ description: 'Work', quantity: 1, unit_amount: 50000, account_id: acc('200'), tax_rate_id: 2 }],
    });
    invoices.approve(inv.id); // no cash yet
    let drill = reports.accountTransactions({ account_id: acc('200'), from: '2026-03-01', to: '2026-03-31', cash_only: true });
    expect(drill.lines).toHaveLength(0);
    
    paymentsCreate({
      type: 'RECEIVE', date: '2026-03-12', bank_account_id: acc('090'), contact_id: cust,
      amount: 50000, allocations: [{ invoice_id: inv.id, amount: 50000 }],
    });
    drill = reports.accountTransactions({ account_id: acc('610'), from: '2026-03-01', to: '2026-03-31', cash_only: true });
    expect(drill.lines).toHaveLength(1); // only the payment journal touches the bank
  });
});

describe('attachments', () => {
  it('stores, lists, fetches and deletes files on a transaction', async () => {
    const attachments = await import('../src/backend/services/attachments');
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-01',
      lines: [{ description: 'X', quantity: 1, unit_amount: 1000, account_id: acc('200'), tax_rate_id: 2 }],
    });
    const b64 = Buffer.from('hello receipt').toString('base64');
    const a = attachments.add({ entity_type: 'invoice', entity_id: inv.id, filename: 'receipt.txt', mime_type: 'text/plain', data_base64: b64 });
    expect(a.size).toBe(13);
    const metas = attachments.list('invoice', inv.id);
    expect(metas).toHaveLength(1);
    expect(metas[0]).not.toHaveProperty('data'); // listing stays light
    const full = attachments.get(a.id);
    expect(Buffer.from(full.data, 'base64').toString()).toBe('hello receipt');
    expect(() => attachments.add({ entity_type: 'invoice', entity_id: inv.id, filename: 'big.bin', data_base64: 'A'.repeat(4.5 * 1024 * 1024) })).toThrow(/3 MB/);
    attachments.remove(a.id);
    expect(attachments.list('invoice', inv.id)).toHaveLength(0);
  });
});

describe('account statement', () => {
  it('filters by accounts, contacts, sources and search; single-account opening', () => {
    const a = contacts.save({ name: 'Alpha Ltd', is_customer: true }).id;
    const b = contacts.save({ name: 'Beta Co', is_customer: true }).id;
    const mk = (cid: number, date: string, amt: number, desc: string) => {
      const inv = invoices.saveDraft({
        type: 'ACCREC', contact_id: cid, date,
        lines: [{ description: desc, quantity: 1, unit_amount: amt, account_id: acc('200'), tax_rate_id: 2 }],
      });
      invoices.approve(inv.id);
      return inv.id;
    };
    mk(a, '2026-02-10', 10000, 'widgets');
    mk(a, '2026-03-05', 20000, 'gadgets');
    mk(b, '2026-03-08', 40000, 'widgets deluxe');
    const mj = journals.saveDraft({
      narration: 'Adj', date: '2026-03-09',
      lines: [{ account_id: acc('200'), debit: 500 }, { account_id: acc('825'), credit: 500 }],
    });
    journals.post(mj);

    const all = reports.accountStatement({ from: '2026-03-01', to: '2026-03-31', account_ids: [acc('200')] });
    expect(all.lines).toHaveLength(3); // two invoices + manual line
    expect(all.opening).toBe(-10000); // Feb revenue sits before the window
    expect(all.lines[0].account_type).toBe('REVENUE');

    const onlyAlpha = reports.accountStatement({ from: '2026-03-01', to: '2026-03-31', account_ids: [acc('200')], contact_ids: [a] });
    expect(onlyAlpha.lines).toHaveLength(1);
    expect(onlyAlpha.opening).toBeNull(); // filtered → no running balance

    const manualOnly = reports.accountStatement({ from: '2026-03-01', to: '2026-03-31', source_types: ['MANUAL'] });
    expect(manualOnly.lines.filter((l: any) => l.account_code === '200')).toHaveLength(1);

    const search = reports.accountStatement({ from: '2026-03-01', to: '2026-03-31', search: 'deluxe' });
    expect(search.lines).toHaveLength(1);
    expect(search.lines[0].contact_name).toBe('Beta Co');

    const typed = reports.accountStatement({ from: '2026-03-01', to: '2026-03-31', account_types: ['REVENUE'] });
    expect(typed.lines.every((l: any) => l.account_type === 'REVENUE')).toBe(true);

    const csv = reports.exportCsv({ report: 'account_statement', from: '2026-03-01', to: '2026-03-31', account_ids: [acc('200')] });
    expect(csv.csv.split('\n')[0]).toContain('Account type');
    expect(csv.csv.split('\n')[0]).toContain('Document #');
  });

  it('carries document number, reference and tracking names onto lines', () => {
    const catId = settings.saveTrackingCategory({ name: 'Dept', options: [{ name: 'Ops' }] });
    const ops = settings.listTracking().find((c: any) => c.id === catId).options[0].id;
    const cust = contacts.save({ name: 'Gamma', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-12', reference: 'PO-778',
      lines: [{ description: 'Consulting', quantity: 1, unit_amount: 9900, account_id: acc('200'), tax_rate_id: 2, tracking_option_1: ops }],
    });
    invoices.approve(inv.id);
    const st = reports.accountStatement({ from: '2026-03-01', to: '2026-03-31', search: 'PO-778' });
    expect(st.lines.length).toBeGreaterThan(0);
    const l = st.lines.find((x: any) => x.account_code === '200');
    expect(l.doc_number).toBe(invoices.get(inv.id).invoice_number);
    expect(l.doc_reference).toBe('PO-778');
    expect(l.tracking_1).toBe('Ops');
    const drill = reports.accountTransactions({ account_id: acc('200'), from: '2026-03-01', to: '2026-03-31' });
    expect(drill.lines.some((x: any) => x.doc_number === l.doc_number)).toBe(true);
  });
});

describe('balance sheet comparison snapshots', () => {
  it('returns one full balance sheet per requested date and stays balanced', () => {
    const cust = contacts.save({ name: 'C', is_customer: true }).id;
    for (const [date, amt] of [['2026-01-15', 10000], ['2026-02-15', 20000], ['2026-03-15', 40000]] as const) {
      const inv = invoices.saveDraft({
        type: 'ACCREC', contact_id: cust, date,
        lines: [{ description: 'W', quantity: 1, unit_amount: amt, account_id: acc('200'), tax_rate_id: 2 }],
      });
      invoices.approve(inv.id);
    }
    const r = reports.balanceSheet({
      as_at: '2026-03-31',
      compare: [
        { as_at: '2026-02-28', label: 'Feb 2026' },
        { as_at: '2026-01-31', label: 'Jan 2026' },
      ],
    });
    expect(r.comparisons).toHaveLength(2);
    expect(r.total_assets).toBe(70000);
    expect(r.comparisons[0].total_assets).toBe(30000);
    expect(r.comparisons[1].total_assets).toBe(10000);
    for (const c of [r, ...r.comparisons]) expect(c.balances).toBe(true);
    const csv = reports.exportCsv({ report: 'balance_sheet', as_at: '2026-03-31', compare: [{ as_at: '2026-01-31', label: 'Jan 2026' }] });
    expect(csv.csv.split('\n')[0]).toContain('Jan 2026');
  });
});

describe('contact activity stream', () => {
  it('unifies invoices, payments and bank transactions for one contact', async () => {
    const banking = await import('../src/backend/services/banking');
    const cid = contacts.save({ name: 'Omni Trade', is_customer: true, is_supplier: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cid, date: '2026-03-01',
      lines: [{ description: 'X', quantity: 1, unit_amount: 30000, account_id: acc('200'), tax_rate_id: 2 }],
    });
    invoices.approve(inv.id);
    paymentsCreate({
      type: 'RECEIVE', date: '2026-03-05', bank_account_id: acc('090'), contact_id: cid,
      amount: 30000, allocations: [{ invoice_id: inv.id, amount: 30000 }],
    });
    banking.createBankTransaction({
      type: 'SPEND', bank_account_id: acc('090'), contact_id: cid, date: '2026-03-07', line_amount_type: 'NOTAX',
      lines: [{ description: 'Stationery', quantity: 1, unit_amount: 2500, account_id: acc('453'), tax_rate_id: 2 }],
    });
    const act = contacts.activity(cid);
    const kinds = act.rows.map((r: any) => r.kind);
    expect(kinds).toContain('ACCREC');
    expect(kinds).toContain('PAYMENT_IN');
    expect(kinds).toContain('SPEND_MONEY');
    expect(act.rows[0].date >= act.rows[act.rows.length - 1].date).toBe(true); // newest first
    expect(act.outstanding_receivable).toBe(0); // paid
    const csv = reports.exportCsv({ report: 'contact_activity', contact_id: cid });
    expect(csv.csv.split('\n')[0]).toContain('Outstanding');
    expect(csv.csv).toContain('SPEND_MONEY');
  });
});

describe('aged detail CSV', () => {
  it('lists each invoice in its bucket with contact subtotals', () => {
    const cid = contacts.save({ name: 'Slowpay Ltd', is_customer: true }).id;
    const mk = (date: string, due: string, amt: number) => {
      const inv = invoices.saveDraft({
        type: 'ACCREC', contact_id: cid, date, due_date: due,
        lines: [{ description: 'X', quantity: 1, unit_amount: amt, account_id: acc('200'), tax_rate_id: 2 }],
      });
      invoices.approve(inv.id);
    };
    mk('2026-01-01', '2026-01-10', 10000); // long overdue at as_at
    mk('2026-03-20', '2026-04-20', 5000);  // current at as_at
    const csv = reports.exportCsv({ report: 'aged_receivables_detail', as_at: '2026-03-31' });
    const lines = csv.csv.split('\n');
    expect(lines[0]).toContain('Days overdue');
    expect(csv.csv).toContain('Slowpay Ltd subtotal');
    expect(csv.csv.split('\n').some((l) => l.includes('80') && l.includes('100.00'))).toBe(true); // 80 days overdue bucket line
  });
});

describe('CSV import', () => {
  it('imports grouped invoice rows as drafts with tracking, creating contacts', async () => {
    const imports = await import('../src/backend/services/imports');
    const settings2 = await import('../src/backend/services/settings');
    const catId = settings2.saveTrackingCategory({ name: 'Region', options: [{ name: 'North' }] });
    void catId;
    const csv = [
      'ContactName,Number,Date,DueDate,Description,Quantity,UnitAmount,AccountCode,TaxRate,Tracking1',
      'Fresh Foods,INV-9001,2026-04-01,2026-04-15,Consulting day,1,1500.00,200,Tax on Sales,North',
      'Fresh Foods,INV-9001,2026-04-01,2026-04-15,Travel,2,80.00,200,Tax on Sales,North',
      'Fresh Foods,INV-9002,2026-04-03,,Workshop,1,950.00,200,,',
      'Bad Co,INV-9003,2026-04-04,,Mystery,1,10.00,9999,,',
    ].join('\n');
    const r = imports.importDocuments({ type: 'ACCREC', csv });
    expect(r.created).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/9999/);
    expect(r.contacts_created).toBeGreaterThanOrEqual(1);
    const doc = invoices.get(r.created[0].id);
    expect(doc.status).toBe('DRAFT');
    expect(doc.invoice_number).toBe('INV-9001');
    expect(doc.lines).toHaveLength(2);
    expect(doc.lines[0].tracking_option_1).toBeTruthy();
    expect(doc.total).toBeGreaterThan(166000); // 1660.00 net plus sales tax
    invoices.approve(doc.id); // imported drafts approve cleanly
    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
  });

  it('imports balanced journals and rejects unbalanced ones', async () => {
    const imports = await import('../src/backend/services/imports');
    const csv = [
      'Narration,Date,Description,AccountCode,Debit,Credit',
      'June accrual,2026-06-30,Fees,477,380.00,',
      'June accrual,2026-06-30,Accrued,825,,380.00',
      'Broken,2026-06-30,Oops,477,100.00,',
    ].join('\n');
    const r = imports.importJournals({ csv });
    expect(r.created).toHaveLength(1);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/balance/i);
    const j = journals.get(r.created[0].id);
    expect(j.status).toBe('DRAFT');
    journals.post(r.created[0].id);
  });

  it('parses quoted fields with commas and escaped quotes', async () => {
    const imports = await import('../src/backend/services/imports');
    const t = imports.parseCsvTable('A,B\n"x, y","say ""hi"""\n');
    expect(t.rows[0].a).toBe('x, y');
    expect(t.rows[0].b).toBe('say "hi"');
  });
});

describe('multi-user attribution', () => {
  it('stamps work with the switched-in user, not the default', () => {
    const uid = settings.saveUser({ name: 'Priya Patel', email: 'priya@example.com' });
    settings.setActiveUser(uid);
    const mj = journals.saveDraft({
      narration: 'Priya adjustment', date: '2026-06-01',
      lines: [{ account_id: acc('477'), debit: 700 }, { account_id: acc('825'), credit: 700 }],
    });
    journals.post(mj);
    const db = getDb();
    const last = db.prepare("SELECT a.user_id, u.name FROM audit_log a JOIN users u ON u.id=a.user_id ORDER BY a.id DESC LIMIT 1").get();
    expect(last.name).toBe('Priya Patel');
    settings.setActiveUser(1); // reset for other tests
    const me = settings.getActiveUser();
    expect(me.id).toBe(1);
  });
});

describe('cash vs accrual P&L', () => {
  it('recognises revenue when invoiced (accrual) vs when paid (cash, prorated)', async () => {
    const banking = await import('../src/backend/services/banking');
    const cid = contacts.save({ name: 'Cashflow Co', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cid, date: '2026-01-10',
      lines: [{ description: 'Project', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 3 }], // 1,000 net + 10% tax
    });
    invoices.approve(inv.id);
    const total = invoices.get(inv.id).total; // 110000
    paymentsCreate({
      type: 'RECEIVE', date: '2026-02-05', bank_account_id: acc('090'), contact_id: cid,
      amount: Math.round(total / 2), allocations: [{ invoice_id: inv.id, amount: Math.round(total / 2) }],
    });
    banking.createBankTransaction({
      type: 'SPEND', bank_account_id: acc('090'), contact_id: cid, date: '2026-02-10', line_amount_type: 'NOTAX',
      lines: [{ description: 'Hosting', quantity: 1, unit_amount: 20000, account_id: acc('477'), tax_rate_id: 2 }],
    });

    const accrualJan = reports.profitAndLoss({ from: '2026-01-01', to: '2026-01-31' });
    const cashJan = reports.profitAndLoss({ from: '2026-01-01', to: '2026-01-31', basis: 'CASH' });
    const accrualFeb = reports.profitAndLoss({ from: '2026-02-01', to: '2026-02-28' });
    const cashFeb = reports.profitAndLoss({ from: '2026-02-01', to: '2026-02-28', basis: 'CASH' });

    const revOf = (r: any) => r.income.filter((x: any) => x.code === '200').reduce((s: number, x: any) => s + x.amount, 0);
    expect(revOf(accrualJan)).toBe(100000);      // invoiced in Jan
    expect(revOf(cashJan)).toBe(0);              // nothing received yet
    expect(revOf(accrualFeb)).toBe(0);
    expect(revOf(cashFeb)).toBe(50000);          // half paid → half the net revenue
    // direct cash expense appears on both bases in Feb
    const expOf = (r: any) => r.expenses.filter((x: any) => x.code === '477').reduce((s: number, x: any) => s + x.amount, 0);
    expect(expOf(accrualFeb)).toBe(20000);
    expect(expOf(cashFeb)).toBe(20000);
    expect(cashFeb.basis).toBe('CASH');
  });

  it('cash-flagged manual journals appear only on the cash basis when flagged', () => {
    const mk = (flag: boolean, narr: string) => {
      const id = journals.saveDraft({
        narration: narr, date: '2026-03-15', show_on_cash_basis: flag,
        lines: [{ account_id: acc('477'), debit: 5000 }, { account_id: acc('825'), credit: 5000 }],
      });
      journals.post(id);
    };
    mk(false, 'Pure accrual');
    mk(true, 'Cash-flagged');
    const cashMar = reports.profitAndLoss({ from: '2026-03-01', to: '2026-03-31', basis: 'CASH' });
    const expOf = (r: any) => r.expenses.filter((x: any) => x.code === '477').reduce((s: number, x: any) => s + x.amount, 0);
    expect(expOf(cashMar)).toBe(5000); // only the flagged one
  });
});

describe('organisation name stamping contract', () => {
  it('updateOrganisation applies partial name changes (the bridge relies on this)', () => {
    settings.updateOrganisation({ legal_name: 'Harbour Café Pty Ltd', trading_name: 'Harbour Café' });
    const org = settings.getOrganisation();
    expect(org.legal_name).toBe('Harbour Café Pty Ltd');
    expect(org.trading_name).toBe('Harbour Café');
  });
});

describe('system control accounts are protected', () => {
  it('blocks AR/AP on document lines but allows them in manual journals', () => {
    const db = getDb();
    const ar = db.prepare("SELECT id, code FROM accounts WHERE system_account = 'AR'").get();
    const ap = db.prepare("SELECT id FROM accounts WHERE system_account = 'AP'").get();
    expect(ar && ap).toBeTruthy();
    const cust = contacts.save({ name: 'Sys Acct Co', is_customer: true }).id;
    expect(() => invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-01',
      lines: [{ description: 'X', quantity: 1, unit_amount: 1000, account_id: ar.id, tax_rate_id: 2 }],
    })).toThrow(/control account/i);
    // a manual journal may legitimately touch the control account
    const jid = journals.saveDraft({
      narration: 'AR adjustment', date: '2026-03-01',
      lines: [{ account_id: ar.id, debit: 1000 }, { account_id: acc('200'), credit: 1000 }],
    });
    expect(() => journals.post(jid)).not.toThrow();
  });
});

describe('account statement running balance', () => {
  it('carries opening + per-line running balance and a closing total for a single account', () => {
    initDatabase(':memory:');
    const cust = contacts.save({ name: 'RB Co', is_customer: true }).id;
    const rev = getDb().prepare("SELECT id FROM accounts WHERE code='200'").get().id;
    // Two approved invoices in-period hit revenue (credits to 200).
    const mk = (date: string, amt: number) => {
      const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 'x', quantity: 1, unit_amount: amt, account_id: rev, tax_rate_id: 2 }] });
      invoices.approve(inv.id);
    };
    mk('2026-03-05', 10000);
    mk('2026-03-20', 25000);
    const r: any = reports.accountStatement({ from: '2026-03-01', to: '2026-03-31', account_ids: [rev] });
    expect(r.has_running_balance).toBe(true);
    expect(r.opening).toBe(0);
    // revenue is a credit, so debit - credit is negative; running balance walks down
    expect(r.lines[0].running_balance).toBe(-10000);
    expect(r.lines[1].running_balance).toBe(-35000);
    expect(r.closing).toBe(-35000);
  });

  it('omits running balance when multiple accounts or filters are in play', () => {
    initDatabase(':memory:');
    const r: any = reports.accountStatement({ from: '2026-01-01', to: '2026-12-31' });
    expect(r.has_running_balance).toBe(false);
    expect(r.opening).toBeNull();
  });
});

describe('date & quantity validation', () => {
  beforeEach(() => initDatabase(':memory:'));
  const cust = () => contacts.save({ name: 'Val Co', is_customer: true }).id;
  const rev = () => getDb().prepare("SELECT id FROM accounts WHERE code='200'").get().id;
  const line = (over: any = {}) => ({ description: 'x', quantity: 1, unit_amount: 1000, account_id: rev(), tax_rate_id: 2, ...over });

  it('rejects impossible and malformed dates', () => {
    const c = cust();
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-02-30', lines: [line()] })).toThrow(/calendar date/i);
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '275760-02-30', lines: [line()] })).toThrow(/calendar date|year/i);
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-13-01', lines: [line()] })).toThrow(/month|calendar/i);
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: 'not-a-date', lines: [line()] })).toThrow(/calendar date/i);
    // a real date is fine
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-02-28', lines: [line()] })).not.toThrow();
  });

  it('rejects a due date that is not real', () => {
    const c = cust();
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-03-01', due_date: '2026-04-31', lines: [line()] })).toThrow(/Due date/i);
  });

  it('rejects zero or negative quantity', () => {
    const c = cust();
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-03-01', lines: [line({ quantity: 0 })] })).toThrow(/quantity/i);
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-03-01', lines: [line({ quantity: -2 })] })).toThrow(/quantity/i);
    expect(() => invoices.saveDraft({ type: 'ACCPAY', contact_id: c, date: '2026-03-01', lines: [line(), line({ quantity: 0 })] })).toThrow(/Line 2.*quantity/i);
  });

  it('validates journal dates too', () => {
    const r = getDb().prepare("SELECT id FROM accounts WHERE code='200'").get().id;
    const e = getDb().prepare("SELECT id FROM accounts WHERE code='400'").get()?.id ?? r;
    expect(() => journals.saveDraft({ narration: 'bad', date: '2026-02-31', lines: [{ account_id: r, debit: 100 }, { account_id: e, credit: 100 }] })).toThrow(/calendar date/i);
  });

  it('attachments reject unsupported file types and oversize files', () => {
    const c = cust();
    const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-03-01', lines: [line()] });
    expect(() => attachmentsSvc.add({ entity_type: 'invoice', entity_id: inv.id, filename: 'evil.exe', data_base64: Buffer.from('hello').toString('base64') })).toThrow(/supported file type/i);
    expect(() => attachmentsSvc.add({ entity_type: 'invoice', entity_id: inv.id, filename: 'ok.pdf', data_base64: Buffer.from('hello').toString('base64') })).not.toThrow();
  });
});

describe('journal search & filters', () => {
  beforeEach(() => initDatabase(':memory:'));
  const r = () => getDb().prepare("SELECT id FROM accounts WHERE code='200'").get().id;
  const e = () => getDb().prepare("SELECT id FROM accounts WHERE code='400'").get()?.id ?? getDb().prepare("SELECT id FROM accounts WHERE code='453'").get().id;

  it('filters journals by date range, text, account and amount', () => {
    const a = journals.saveDraft({ narration: 'March accrual', date: '2026-03-10', lines: [{ account_id: e(), debit: 5000 }, { account_id: r(), credit: 5000 }] });
    journals.post(a);
    const b = journals.saveDraft({ narration: 'April rent', date: '2026-04-10', lines: [{ account_id: e(), debit: 90000 }, { account_id: r(), credit: 90000 }] });
    journals.post(b);

    expect(journals.list({}).length).toBe(2);
    expect(journals.list({ from: '2026-04-01' }).length).toBe(1);
    expect(journals.list({ to: '2026-03-31' }).length).toBe(1);
    expect(journals.list({ search: 'rent' }).length).toBe(1);
    expect(journals.list({ search: 'accrual' })[0].narration).toBe('March accrual');
    expect(journals.list({ min: 10000 }).length).toBe(1); // only the 90000 one
    expect(journals.list({ max: 10000 }).length).toBe(1); // only the 5000 one
    expect(journals.list({ account_id: e() }).length).toBe(2);
  });
});
