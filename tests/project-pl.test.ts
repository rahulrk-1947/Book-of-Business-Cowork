import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as projects from '../src/backend/services/projects';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => (getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c) as any).id as number;

let customer: number;
let supplier: number;
let projectId: number;

beforeEach(() => {
  initDatabase(':memory:');
  customer = contacts.save({ name: 'Client Co', is_customer: true }).id;
  supplier = contacts.save({ name: 'Supplier Co', is_supplier: true }).id;
  projectId = projects.createProject({ name: 'Build', contact_id: customer }).id;
});

function bill(amount: number, date: string) {
  const b = invoices.saveDraft({ type: 'ACCPAY', contact_id: supplier, date, lines: [{ description: 'Mat', quantity: 1, unit_amount: amount, account_id: acc('400'), project_id: projectId }] } as any);
  invoices.approve(b.id);
  return b.id;
}
function sale(amount: number, date: string, type: 'ACCREC' | 'ACCRECCREDIT' = 'ACCREC') {
  const s = invoices.saveDraft({ type, contact_id: customer, date, lines: [{ description: 'Work', quantity: 1, unit_amount: amount, account_id: acc('200'), project_id: projectId }] } as any);
  invoices.approve(s.id);
  return s.id;
}

describe('project P&L report', () => {
  it('shows billed revenue, cost and margin per project for the period', () => {
    sale(50000, '2026-03-15');
    bill(20000, '2026-03-20');
    const r = reports.projectProfitability({ from: '2026-03-01', to: '2026-03-31' });
    const row = r.rows.find((x: any) => x.project_id === projectId)!;
    expect(row.revenue).toBe(50000);
    expect(row.cost).toBe(20000);
    expect(row.margin).toBe(30000);
    expect(row.margin_pct).toBe(60);
    expect(r.totals.revenue).toBe(50000);
    expect(r.totals.cost).toBe(20000);
    expect(r.totals.margin).toBe(30000);
  });

  it('bounds the figures to the date range', () => {
    sale(50000, '2026-03-15'); // in range
    sale(99000, '2026-06-15'); // out of range
    bill(20000, '2026-03-20'); // in range
    bill(70000, '2026-06-20'); // out of range
    const r = reports.projectProfitability({ from: '2026-03-01', to: '2026-03-31' });
    const row = r.rows.find((x: any) => x.project_id === projectId)!;
    expect(row.revenue).toBe(50000);
    expect(row.cost).toBe(20000);
  });

  it('nets customer credit notes out of revenue', () => {
    sale(50000, '2026-03-15');
    sale(20000, '2026-03-18', 'ACCRECCREDIT');
    const r = reports.projectProfitability({ from: '2026-03-01', to: '2026-03-31' });
    const row = r.rows.find((x: any) => x.project_id === projectId)!;
    expect(row.revenue).toBe(30000);
  });

  it('reports a negative margin when costs exceed revenue', () => {
    sale(10000, '2026-03-15');
    bill(25000, '2026-03-20');
    const r = reports.projectProfitability({ from: '2026-03-01', to: '2026-03-31' });
    const row = r.rows.find((x: any) => x.project_id === projectId)!;
    expect(row.margin).toBe(-15000);
    expect(row.margin_pct).toBe(-150);
  });
});
