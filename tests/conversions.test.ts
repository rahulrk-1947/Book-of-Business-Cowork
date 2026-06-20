import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as conversions from '../src/backend/services/conversions';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
beforeEach(() => initDatabase(':memory:'));

describe('conversion / opening balances', () => {
  it('posts a balanced opening journal and shows it on the Balance Sheet', () => {
    const r = conversions.save({ conversion_date: '2026-03-31', lines: [
      { account_id: acc('090'), debit: 5000000 },   // bank
      { account_id: acc('970'), credit: 5000000 },   // owner capital
    ] });
    expect(r.posted).toBe(true);
    expect(r.difference).toBe(0);
    const bs = reports.balanceSheet({ as_at: '2026-04-30' });
    expect(bs.assets.find((a: any) => a.code === '090')!.amount).toBe(5000000);
    expect(bs.balances).toBe(true);
  });

  it('absorbs an imbalance into Historical Adjustment so setup can proceed', () => {
    const r = conversions.save({ conversion_date: '2026-03-31', lines: [
      { account_id: acc('090'), debit: 5000000 },
      { account_id: acc('970'), credit: 4000000 }, // 1,000,000 short
    ] });
    expect(r.difference).toBe(1000000);
    // the journal still balances (difference parked in Historical Adjustment)
    const bs = reports.balanceSheet({ as_at: '2026-04-30' });
    expect(bs.balances).toBe(true);
    const hist = bs.equity.find((e: any) => e.code === '840');
    expect(hist).toBeTruthy();
  });

  it('re-saving replaces the prior opening journal (no doubling up)', () => {
    conversions.save({ conversion_date: '2026-03-31', lines: [
      { account_id: acc('090'), debit: 5000000 }, { account_id: acc('970'), credit: 5000000 },
    ] });
    conversions.save({ conversion_date: '2026-03-31', lines: [
      { account_id: acc('090'), debit: 8000000 }, { account_id: acc('970'), credit: 8000000 },
    ] });
    const bs = reports.balanceSheet({ as_at: '2026-04-30' });
    expect(bs.assets.find((a: any) => a.code === '090')!.amount).toBe(8000000); // replaced, not 13,000,000
    expect(bs.balances).toBe(true);
  });

  it('opening retained earnings flows into the Retained Earnings line', () => {
    getDb().prepare('UPDATE organisations SET financial_year_end_month=3, financial_year_end_day=31 WHERE id=1').run();
    conversions.save({ conversion_date: '2026-03-31', lines: [
      { account_id: acc('090'), debit: 3000000 },
      { account_id: acc('960'), credit: 3000000 }, // opening retained earnings
    ] });
    // As at a date in the new FY, the opening RE (posted last FY) sits in retained earnings
    const bs = reports.balanceSheet({ as_at: '2026-06-30' });
    const reLine = bs.equity.find((e: any) => /retained earnings/i.test(e.name));
    expect(reLine!.amount).toBe(3000000);
    expect(bs.balances).toBe(true);
  });

  it('get() reports the stored lines, totals and difference', () => {
    conversions.save({ conversion_date: '2026-03-31', lines: [
      { account_id: acc('090'), debit: 5000000 }, { account_id: acc('970'), credit: 5000000 },
    ] });
    const g = conversions.get();
    expect(g.conversion_date).toBe('2026-03-31');
    expect(g.lines).toHaveLength(2);
    expect(g.total_debit).toBe(5000000);
    expect(g.total_credit).toBe(5000000);
    expect(g.difference).toBe(0);
  });

  it('clear() removes the opening balances entirely', () => {
    conversions.save({ conversion_date: '2026-03-31', lines: [
      { account_id: acc('090'), debit: 5000000 }, { account_id: acc('970'), credit: 5000000 },
    ] });
    conversions.clear();
    const g = conversions.get();
    expect(g.posted).toBe(false);
    expect(g.lines).toHaveLength(0);
    const bs = reports.balanceSheet({ as_at: '2026-04-30' });
    expect(bs.assets.find((a: any) => a.code === '090')).toBeFalsy();
  });

  it('rejects an account with both a debit and a credit', () => {
    expect(() => conversions.save({ conversion_date: '2026-03-31', lines: [{ account_id: acc('090'), debit: 100, credit: 100 }] })).toThrow(/either a debit or a credit/i);
  });
});
