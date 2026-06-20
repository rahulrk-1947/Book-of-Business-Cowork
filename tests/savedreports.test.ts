import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/backend/db';
import * as sr from '../src/backend/services/savedreports';

describe('saved report views', () => {
  beforeEach(() => initDatabase(':memory:'));

  it('saves a view and lists it', () => {
    const id = sr.save({ name: 'Q1 P&L', report_type: 'profit_and_loss', config: { from: '2026-01-01', to: '2026-03-31' } });
    expect(id).toBeGreaterThan(0);
    const list = sr.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'Q1 P&L', report_type: 'profit_and_loss' });
  });

  it('round-trips the full config (filters, columns, comparison)', () => {
    const config = { report: 'general_ledger', from: '2026-01-01', to: '2026-06-30', glAccounts: [200, 400], glCols: { balance: true, drcr: false }, pl: { basis: 'MONTH', count: 3 } };
    const id = sr.save({ name: 'GL view', report_type: 'general_ledger', config });
    expect(sr.get(id).config).toEqual(config);
  });

  it('updates by id', () => {
    const id = sr.save({ name: 'A', report_type: 'trial_balance', config: { to: '2026-01-31' } });
    sr.save({ id, name: 'A renamed', report_type: 'trial_balance', config: { to: '2026-02-28' } });
    expect(sr.list()).toHaveLength(1);
    expect(sr.get(id).name).toBe('A renamed');
    expect(sr.get(id).config.to).toBe('2026-02-28');
  });

  it('saving the same name (case-insensitive) updates instead of duplicating', () => {
    const id = sr.save({ name: 'Monthly', report_type: 'balance_sheet', config: { x: 1 } });
    const id2 = sr.save({ name: 'monthly', report_type: 'balance_sheet', config: { x: 2 } });
    expect(id2).toBe(id);
    expect(sr.list()).toHaveLength(1);
    expect(sr.get(id).config.x).toBe(2);
  });

  it('rejects a blank name', () => {
    expect(() => sr.save({ name: '  ', report_type: 'profit_and_loss', config: {} })).toThrow(/name/i);
  });

  it('removes a view', () => {
    const id = sr.save({ name: 'Temp', report_type: 'cash_flow', config: {} });
    sr.remove(id);
    expect(sr.list()).toHaveLength(0);
    expect(() => sr.get(id)).toThrow(/not found/i);
  });
});
