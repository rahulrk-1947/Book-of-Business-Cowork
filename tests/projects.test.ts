import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as projects from '../src/backend/services/projects';

let cust: number;
beforeEach(() => {
  initDatabase(':memory:');
  cust = contacts.save({ name: 'Client Co', is_customer: true }).id;
});

describe('projects: time, costs, profitability, on-billing', () => {
  it('values time by its task rate and tracks unbilled value', () => {
    const p = projects.createProject({ name: 'Website build', contact_id: cust, estimate_amount: 1000000 });
    const task = projects.saveTask({ project_id: p.id, name: 'Development', rate: 12000 }); // $120/hr
    projects.logTime({ project_id: p.id, task_id: task.id, date: '2026-03-01', minutes: 150 }); // 2.5h → $300
    projects.logTime({ project_id: p.id, task_id: task.id, date: '2026-03-02', minutes: 60, billable: false });
    const got = projects.getProject(p.id);
    expect(got.summary.logged_minutes).toBe(210);
    expect(got.summary.unbilled_time_value).toBe(30000); // only the billable 2.5h
  });

  it('applies markup to project costs', () => {
    const p = projects.createProject({ name: 'P', contact_id: cust });
    const c = projects.addCost({ project_id: p.id, date: '2026-03-01', description: 'Stock photos', cost_amount: 10000, markup_percent: 20 });
    expect(c.charge_amount).toBe(12000);
  });

  it('on-bills unbilled time + costs into a draft invoice, tags lines, and prevents double billing', () => {
    const p = projects.createProject({ name: 'P', contact_id: cust });
    const task = projects.saveTask({ project_id: p.id, name: 'Consulting', rate: 20000 }); // $200/hr
    projects.logTime({ project_id: p.id, task_id: task.id, date: '2026-03-01', minutes: 120 }); // 2h → $400
    projects.addCost({ project_id: p.id, date: '2026-03-01', description: 'Travel', cost_amount: 5000, markup_percent: 0 });

    const inv = projects.invoiceUnbilled(p.id, { date: '2026-03-31' });
    expect(inv.subtotal).toBe(45000); // $400 + $50
    const tagged = getDb().prepare('SELECT COUNT(*) AS n FROM invoice_lines WHERE invoice_id = ? AND project_id = ?').get(inv.id, p.id) as any;
    expect(tagged.n).toBe(2);

    expect(projects.unbilled(p.id).total).toBe(0);
    expect(() => projects.invoiceUnbilled(p.id)).toThrow(/nothing unbilled/i);

    invoices.approve(inv.id);
    expect(projects.getProject(p.id).summary.billed_total).toBe(45000);
  });

  it('refuses to delete a project once it has invoiced items', () => {
    const p = projects.createProject({ name: 'P', contact_id: cust });
    const task = projects.saveTask({ project_id: p.id, name: 'Work', rate: 10000 });
    projects.logTime({ project_id: p.id, task_id: task.id, date: '2026-03-01', minutes: 60 });
    invoices.approve(projects.invoiceUnbilled(p.id).id);
    expect(() => projects.deleteProject(p.id)).toThrow(/invoiced/i);
  });

  it('excludes time with no task (no rate) from billing', () => {
    const p = projects.createProject({ name: 'P', contact_id: cust });
    projects.logTime({ project_id: p.id, date: '2026-03-01', minutes: 120 }); // no task → not billable value
    expect(projects.unbilled(p.id).total).toBe(0);
    expect(() => projects.invoiceUnbilled(p.id)).toThrow(/nothing unbilled/i);
  });

  it('requires a customer before on-billing', () => {
    const p = projects.createProject({ name: 'No customer project' });
    const task = projects.saveTask({ project_id: p.id, name: 'Work', rate: 10000 });
    projects.logTime({ project_id: p.id, task_id: task.id, date: '2026-03-01', minutes: 60 });
    expect(() => projects.invoiceUnbilled(p.id)).toThrow(/customer/i);
  });
});
