import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
let cust: number, supp: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'Cust', is_customer: true }).id; supp = contacts.save({ name: 'Supp', is_supplier: true }).id; });
const sale = (cents: number, date: string, who = cust) => invoices.approve(invoices.saveDraft({ type: 'ACCREC', contact_id: who, date, lines: [{ description: 's', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: 2 }] }).id);
const bill = (cents: number, date: string) => invoices.approve(invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date, lines: [{ description: 'b', quantity: 1, unit_amount: cents, account_id: acc('400'), tax_rate_id: 2 }] }).id);
const row = (r: any, label: string) => r.rows.find((x: any) => x.label.includes(label));

describe('custom summary (transaction pivot) report', () => {
  it('pivots income by account across month columns', () => {
    sale(30000, '2026-01-10'); sale(50000, '2026-02-10');
    const r = reports.transactionSummary({ from: '2026-01-01', to: '2026-03-31', group_by: 'account', period: 'month', account_types: ['REVENUE'] });
    expect(r.periods.map((p: any) => p.key)).toEqual(['2026-01', '2026-02', '2026-03']);
    const sales = row(r, 'Sales');
    expect(sales.cells['2026-01']).toBe(30000);
    expect(sales.cells['2026-02']).toBe(50000);
    expect(sales.total).toBe(80000);
    expect(r.grand_total).toBe(80000);
  });

  it('with no period gives a single Total column', () => {
    sale(40000, '2026-01-10');
    const r = reports.transactionSummary({ from: '2026-01-01', to: '2026-12-31', group_by: 'account', period: 'none', account_types: ['REVENUE'] });
    expect(r.periods).toEqual([{ key: 'total', label: 'Total' }]);
    expect(row(r, 'Sales').cells['total']).toBe(40000);
  });

  it('shows natural signs — income and expenses both positive when scoped', () => {
    sale(60000, '2026-01-10');
    const inc = reports.transactionSummary({ from: '2026-01-01', to: '2026-12-31', group_by: 'account_type', period: 'none', account_types: ['REVENUE'] });
    expect(inc.grand_total).toBe(60000); // income positive
    bill(25000, '2026-01-12');
    const exp = reports.transactionSummary({ from: '2026-01-01', to: '2026-12-31', group_by: 'account_type', period: 'none', account_types: ['EXPENSE'] });
    expect(exp.grand_total).toBe(25000); // expense positive
  });

  it('groups by contact', () => {
    const other = contacts.save({ name: 'Acme', is_customer: true }).id;
    sale(30000, '2026-01-10', cust);
    sale(70000, '2026-01-11', other);
    const r = reports.transactionSummary({ from: '2026-01-01', to: '2026-12-31', group_by: 'contact', period: 'none', account_types: ['REVENUE'] });
    expect(row(r, 'Cust').total).toBe(30000);
    expect(row(r, 'Acme').total).toBe(70000);
    expect(r.grand_total).toBe(100000);
  });

  it('supports quarter and year periods', () => {
    sale(10000, '2026-02-10'); // Q1
    sale(20000, '2026-05-10'); // Q2
    const q = reports.transactionSummary({ from: '2026-01-01', to: '2026-06-30', group_by: 'account', period: 'quarter', account_types: ['REVENUE'] });
    expect(q.periods.map((p: any) => p.key)).toEqual(['2026-Q1', '2026-Q2']);
    expect(row(q, 'Sales').cells['2026-Q1']).toBe(10000);
    expect(row(q, 'Sales').cells['2026-Q2']).toBe(20000);
    const y = reports.transactionSummary({ from: '2026-01-01', to: '2026-12-31', group_by: 'account', period: 'year', account_types: ['REVENUE'] });
    expect(y.periods.map((p: any) => p.key)).toEqual(['2026']);
    expect(row(y, 'Sales').total).toBe(30000);
  });

  it('row totals, column totals and grand total reconcile', () => {
    sale(30000, '2026-01-10'); sale(50000, '2026-02-10'); sale(20000, '2026-02-20');
    const r = reports.transactionSummary({ from: '2026-01-01', to: '2026-03-31', group_by: 'contact', period: 'month', account_types: ['REVENUE'] });
    const rowSum = r.rows.reduce((s: number, x: any) => s + x.total, 0);
    const colSum = Object.values(r.column_totals).reduce((s: number, v: any) => s + v, 0);
    expect(rowSum).toBe(r.grand_total);
    expect(colSum).toBe(r.grand_total);
    expect(r.column_totals['2026-02']).toBe(70000);
  });

  it('honours filters (account type narrows the set)', () => {
    sale(30000, '2026-01-10'); bill(25000, '2026-01-12');
    const all = reports.transactionSummary({ from: '2026-01-01', to: '2026-12-31', group_by: 'account_type', period: 'none', account_types: ['REVENUE', 'EXPENSE'] });
    expect(all.rows.length).toBe(2); // income + expense rows
    const onlyIncome = reports.transactionSummary({ from: '2026-01-01', to: '2026-12-31', group_by: 'account_type', period: 'none', account_types: ['REVENUE'] });
    expect(onlyIncome.rows.length).toBe(1);
  });

  it('filters by tracking option', () => {
    const catId = Number(getDb().prepare("INSERT INTO tracking_categories(name) VALUES('Projects')").run().lastInsertRowid);
    const optA = Number(getDb().prepare("INSERT INTO tracking_options(category_id,name) VALUES(?,'A')").run(catId).lastInsertRowid);
    invoices.approve(invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-01-10', lines: [{ description: 'x', quantity: 1, unit_amount: 30000, account_id: acc('200'), tax_rate_id: 2, tracking_option_1: optA }] }).id);
    sale(99000, '2026-01-11'); // untagged
    const r = reports.transactionSummary({ from: '2026-01-01', to: '2026-12-31', group_by: 'account', period: 'none', tracking_option_id: optA });
    expect(r.grand_total).toBe(30000); // only the tagged line
  });
});
