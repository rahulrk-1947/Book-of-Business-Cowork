import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as budgets from '../src/backend/services/budgets';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
let cust: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'C', is_customer: true }).id; });

const sale = (date: string, cents: number) => {
  const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 'x', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: 2 }] });
  invoices.approve(i.id);
};

describe('budgets', () => {
  it('derives 12 months from the start month and snaps to the 1st', () => {
    const id = budgets.create({ name: 'FY', start_month: '2026-03-15' });
    const g = budgets.get(id);
    expect(g.months[0]).toBe('2026-03-01');
    expect(g.months[11]).toBe('2027-02-01');
  });

  it('saves and reads back budget cells', () => {
    const id = budgets.create({ name: 'FY', start_month: '2026-01-01' });
    budgets.setLines(id, [
      { account_id: acc('200'), period: '2026-01-01', amount: 500000 },
      { account_id: acc('200'), period: '2026-02-01', amount: 600000 },
    ]);
    const lines = budgets.get(id).lines;
    expect(lines).toHaveLength(2);
    expect(lines.find((l: any) => l.period === '2026-02-01').amount).toBe(600000);
  });

  it('zeroing a cell removes it', () => {
    const id = budgets.create({ name: 'FY', start_month: '2026-01-01' });
    budgets.setLines(id, [{ account_id: acc('200'), period: '2026-01-01', amount: 500000 }]);
    budgets.setLines(id, [{ account_id: acc('200'), period: '2026-01-01', amount: 0 }]);
    expect(budgets.get(id).lines).toHaveLength(0);
  });

  it('upserts a cell rather than duplicating it', () => {
    const id = budgets.create({ name: 'FY', start_month: '2026-01-01' });
    budgets.setLines(id, [{ account_id: acc('200'), period: '2026-01-01', amount: 100 }]);
    budgets.setLines(id, [{ account_id: acc('200'), period: '2026-01-01', amount: 999 }]);
    const lines = budgets.get(id).lines;
    expect(lines).toHaveLength(1);
    expect(lines[0].amount).toBe(999);
  });

  it('compares actual vs budget with correct variance and favourability', () => {
    const id = budgets.create({ name: 'FY', start_month: '2026-01-01' });
    budgets.setLines(id, [{ account_id: acc('200'), period: '2026-01-01', amount: 500000 }]);
    sale('2026-01-20', 300000); // actual income 3000 vs budget 5000
    const va = budgets.vsActual({ budget_id: id, from: '2026-01-01', to: '2026-01-31' });
    const s = va.income.find((r: any) => r.code === '200')!;
    expect(s.actual).toBe(300000);
    expect(s.budget).toBe(500000);
    expect(s.variance).toBe(-200000);
    expect(s.favourable).toBe(false); // under budget on income = unfavourable
  });

  it('expense under budget is favourable', () => {
    const id = budgets.create({ name: 'FY', start_month: '2026-01-01' });
    budgets.setLines(id, [{ account_id: acc('400'), period: '2026-01-01', amount: 500000 }]);
    // actual expense 2000 via a bill
    const b = invoices.saveDraft({ type: 'ACCPAY', contact_id: cust, date: '2026-01-10', lines: [{ description: 'y', quantity: 1, unit_amount: 200000, account_id: acc('400') }] });
    invoices.approve(b.id);
    const va = budgets.vsActual({ budget_id: id, from: '2026-01-01', to: '2026-01-31' });
    const e = va.expense.find((r: any) => r.code === '400')!;
    expect(e.actual).toBe(200000);
    expect(e.variance).toBe(-300000);
    expect(e.favourable).toBe(true); // under budget on expense = good
  });

  it('only counts budget months within the range', () => {
    const id = budgets.create({ name: 'FY', start_month: '2026-01-01' });
    budgets.setLines(id, [
      { account_id: acc('200'), period: '2026-01-01', amount: 100000 },
      { account_id: acc('200'), period: '2026-03-01', amount: 100000 },
    ]);
    const va = budgets.vsActual({ budget_id: id, from: '2026-01-01', to: '2026-02-28' });
    expect(va.income.find((r: any) => r.code === '200')!.budget).toBe(100000); // only Jan, not Mar
  });

  it('rejects a blank name and removes a budget', () => {
    expect(() => budgets.create({ name: '  ', start_month: '2026-01-01' })).toThrow(/name/i);
    const id = budgets.create({ name: 'Temp', start_month: '2026-01-01' });
    budgets.remove(id);
    expect(budgets.list()).toHaveLength(0);
  });
});
