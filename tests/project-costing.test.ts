import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as expenseclaims from '../src/backend/services/expenseclaims';
import * as projects from '../src/backend/services/projects';

const acc = (c: string) => (getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c) as any).id as number;

let customer: number;
let supplier: number;
let projectId: number;

beforeEach(() => {
  initDatabase(':memory:');
  customer = contacts.save({ name: 'Client Co', is_customer: true }).id;
  supplier = contacts.save({ name: 'Parts Supplier', is_supplier: true }).id;
  projectId = projects.createProject({ name: 'Kitchen reno', contact_id: customer }).id;
});

describe('costs flow into projects from bills', () => {
  it('a posted bill line tagged to a project becomes a billable project cost', () => {
    const b = invoices.saveDraft({
      type: 'ACCPAY', contact_id: supplier, date: '2026-04-01',
      lines: [
        { description: 'Timber', quantity: 1, unit_amount: 30000, account_id: acc('400'), project_id: projectId },
        { description: 'Office stuff (no project)', quantity: 1, unit_amount: 5000, account_id: acc('400') },
      ],
    } as any);
    // Nothing on the project until the bill is posted.
    expect(projects.getProject(projectId).costs.length).toBe(0);

    invoices.approve(b.id);

    const after = projects.getProject(projectId);
    expect(after.costs.length).toBe(1);
    expect(after.costs[0].source_type).toBe('BILL');
    expect(after.costs[0].cost_amount).toBe(30000);
    expect(after.costs[0].charge_amount).toBe(30000); // default markup 0 → charge at cost
    expect(after.summary.cost_total).toBe(30000);
    expect(projects.unbilled(projectId).total).toBe(30000); // billable, ready to on-bill
  });

  it('on-bills a bill-sourced cost to the customer, then prevents double billing', () => {
    const b = invoices.saveDraft({
      type: 'ACCPAY', contact_id: supplier, date: '2026-04-01',
      lines: [{ description: 'Tiles', quantity: 1, unit_amount: 80000, account_id: acc('400'), project_id: projectId }],
    } as any);
    invoices.approve(b.id);

    const inv = projects.invoiceUnbilled(projectId, { date: '2026-04-30' });
    expect(inv.id).toBeTruthy();
    expect(projects.unbilled(projectId).total).toBe(0);
    // The cost is now marked invoiced and survives — it's been billed to the customer.
    const cost = projects.getProject(projectId).costs[0];
    expect(cost.invoiced).toBe(1);
  });

  it('removes a bill-sourced cost when the bill is voided (if not yet on-billed)', () => {
    const b = invoices.saveDraft({
      type: 'ACCPAY', contact_id: supplier, date: '2026-04-01',
      lines: [{ description: 'Paint', quantity: 1, unit_amount: 12000, account_id: acc('400'), project_id: projectId }],
    } as any);
    invoices.approve(b.id);
    expect(projects.getProject(projectId).costs.length).toBe(1);

    invoices.voidDoc(b.id);
    expect(projects.getProject(projectId).costs.length).toBe(0);
  });

  it('reopening a bill to draft clears its project costs, re-approving re-creates them', () => {
    const b = invoices.saveDraft({
      type: 'ACCPAY', contact_id: supplier, date: '2026-04-01',
      lines: [{ description: 'Cement', quantity: 1, unit_amount: 9000, account_id: acc('400'), project_id: projectId }],
    } as any);
    invoices.approve(b.id);
    expect(projects.getProject(projectId).costs.length).toBe(1);

    invoices.revertToDraft(b.id);
    expect(projects.getProject(projectId).costs.length).toBe(0);

    invoices.approve(b.id);
    expect(projects.getProject(projectId).costs.length).toBe(1);
  });
});

describe('costs flow into projects from expense claims', () => {
  it('an approved expense-claim line tagged to a project becomes a project cost', () => {
    const claim = expenseclaims.save({
      date: '2026-04-02', line_amount_type: 'NOTAX',
      lines: [
        { account_id: acc('400'), description: 'Site fuel', unit_amount: 4000, project_id: projectId },
        { account_id: acc('400'), description: 'Personal (no project)', unit_amount: 1000 },
      ],
    } as any);
    expect(projects.getProject(projectId).costs.length).toBe(0);

    expenseclaims.approve(claim.id);

    const after = projects.getProject(projectId);
    expect(after.costs.length).toBe(1);
    expect(after.costs[0].source_type).toBe('EXPENSECLAIM');
    expect(after.costs[0].cost_amount).toBe(4000);
    expect(projects.unbilled(projectId).total).toBe(4000);
  });

  it('voiding the claim removes its not-yet-billed project cost', () => {
    const claim = expenseclaims.save({
      date: '2026-04-02', line_amount_type: 'NOTAX',
      lines: [{ account_id: acc('400'), description: 'Parking', unit_amount: 2500, project_id: projectId }],
    } as any);
    expenseclaims.approve(claim.id);
    expect(projects.getProject(projectId).costs.length).toBe(1);

    expenseclaims.voidClaim(claim.id);
    expect(projects.getProject(projectId).costs.length).toBe(0);
  });
});

describe('supplier credits reduce project cost', () => {
  it('a posted supplier credit tagged to a project records a negative cost', () => {
    const credit = invoices.saveDraft({
      type: 'ACCPAYCREDIT', contact_id: supplier, date: '2026-04-10',
      lines: [{ description: 'Returned timber', quantity: 1, unit_amount: 10000, account_id: acc('400'), project_id: projectId }],
    } as any);
    invoices.approve(credit.id);
    const after = projects.getProject(projectId);
    expect(after.costs.length).toBe(1);
    expect(after.costs[0].source_type).toBe('SUPPLIERCREDIT');
    expect(after.costs[0].cost_amount).toBe(-10000);
    expect(after.summary.cost_total).toBe(-10000);
  });

  it('nets a credit against a bill on the same project', () => {
    const b = invoices.saveDraft({
      type: 'ACCPAY', contact_id: supplier, date: '2026-04-01',
      lines: [{ description: 'Timber', quantity: 1, unit_amount: 30000, account_id: acc('400'), project_id: projectId }],
    } as any);
    invoices.approve(b.id);
    const credit = invoices.saveDraft({
      type: 'ACCPAYCREDIT', contact_id: supplier, date: '2026-04-10',
      lines: [{ description: 'Timber returned', quantity: 1, unit_amount: 8000, account_id: acc('400'), project_id: projectId }],
    } as any);
    invoices.approve(credit.id);
    const s = projects.getProject(projectId).summary;
    expect(s.cost_total).toBe(22000); // 30000 booked − 8000 credited
    expect(projects.unbilled(projectId).total).toBe(22000);
  });

  it('removes the negative cost when the credit is voided', () => {
    const credit = invoices.saveDraft({
      type: 'ACCPAYCREDIT', contact_id: supplier, date: '2026-04-10',
      lines: [{ description: 'Return', quantity: 1, unit_amount: 5000, account_id: acc('400'), project_id: projectId }],
    } as any);
    invoices.approve(credit.id);
    expect(projects.getProject(projectId).costs.length).toBe(1);
    invoices.voidDoc(credit.id);
    expect(projects.getProject(projectId).costs.length).toBe(0);
  });

  it('lets a credit cost be marked non-billable without changing its amount', () => {
    const credit = invoices.saveDraft({
      type: 'ACCPAYCREDIT', contact_id: supplier, date: '2026-04-10',
      lines: [{ description: 'Return', quantity: 1, unit_amount: 6000, account_id: acc('400'), project_id: projectId }],
    } as any);
    invoices.approve(credit.id);
    const cost = projects.getProject(projectId).costs[0];
    projects.updateCostBilling({ id: cost.id, billable: false });
    const updated = projects.getProject(projectId).costs[0];
    expect(updated.cost_amount).toBe(-6000); // amount untouched
    expect(updated.billable).toBe(0);
    expect(projects.unbilled(projectId).total).toBe(0); // no longer flows into on-billing
  });
});

describe('customer credit notes reduce project billed revenue', () => {
  it('a tagged sales invoice counts as billed revenue; a tagged customer credit reduces it', () => {
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: customer, date: '2026-05-01',
      lines: [{ description: 'Project work', quantity: 1, unit_amount: 50000, account_id: acc('200'), project_id: projectId }],
    } as any);
    invoices.approve(inv.id);
    expect(projects.getProject(projectId).summary.billed_total).toBe(50000);

    const cn = invoices.saveDraft({
      type: 'ACCRECCREDIT', contact_id: customer, date: '2026-05-10',
      lines: [{ description: 'Partial refund', quantity: 1, unit_amount: 20000, account_id: acc('200'), project_id: projectId }],
    } as any);
    invoices.approve(cn.id);
    expect(projects.getProject(projectId).summary.billed_total).toBe(30000); // 50000 billed − 20000 credited
    expect(projects.getProject(projectId).summary.net).toBe(30000);          // no costs on this project
  });

  it('voiding the customer credit note restores billed revenue', () => {
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: customer, date: '2026-05-01',
      lines: [{ description: 'Project work', quantity: 1, unit_amount: 40000, account_id: acc('200'), project_id: projectId }],
    } as any);
    invoices.approve(inv.id);
    const cn = invoices.saveDraft({
      type: 'ACCRECCREDIT', contact_id: customer, date: '2026-05-10',
      lines: [{ description: 'Refund', quantity: 1, unit_amount: 15000, account_id: acc('200'), project_id: projectId }],
    } as any);
    invoices.approve(cn.id);
    expect(projects.getProject(projectId).summary.billed_total).toBe(25000);

    invoices.voidDoc(cn.id);
    expect(projects.getProject(projectId).summary.billed_total).toBe(40000);
  });

  it('a draft customer credit does not affect billed revenue until posted', () => {
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: customer, date: '2026-05-01',
      lines: [{ description: 'Project work', quantity: 1, unit_amount: 30000, account_id: acc('200'), project_id: projectId }],
    } as any);
    invoices.approve(inv.id);
    invoices.saveDraft({
      type: 'ACCRECCREDIT', contact_id: customer, date: '2026-05-10',
      lines: [{ description: 'Pending refund', quantity: 1, unit_amount: 10000, account_id: acc('200'), project_id: projectId }],
    } as any);
    // Credit note left as a draft — billed revenue is unchanged.
    expect(projects.getProject(projectId).summary.billed_total).toBe(30000);
  });
});
