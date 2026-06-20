import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as deferrals from '../src/backend/services/deferrals';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const bal = (id: number, asof = '2099-12-31') => {
  const x: any = getDb().prepare("SELECT COALESCE(SUM(jl.debit-jl.credit),0) dr, COALESCE(SUM(jl.credit-jl.debit),0) cr FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE jl.account_id=? AND j.status='POSTED' AND j.date<=?").get(id, asof);
  return x;
};
beforeEach(() => initDatabase(':memory:'));

describe('accruals & deferrals (revenue/expense recognition)', () => {
  it('income deferral recognises evenly and draws down the holding liability', () => {
    deferrals.create({ name: 'Sub', kind: 'INCOME', deferral_account_id: acc('805'), recognition_account_id: acc('200'), total: 120000, periods: 12, start_date: '2026-01-15' });
    expect(bal(acc('200'), '2026-03-31').cr).toBe(30000); // 3 months of income
    expect(bal(acc('805'), '2026-03-31').dr).toBe(30000); // liability drawn down by the same
    expect(bal(acc('200'), '2026-12-31').cr).toBe(120000); // full year recognised
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('expense deferral books expense and draws down the prepaid asset', () => {
    deferrals.create({ name: 'Insurance', kind: 'EXPENSE', deferral_account_id: acc('620'), recognition_account_id: acc('400'), total: 120000, periods: 12, start_date: '2026-01-15' });
    expect(bal(acc('400'), '2026-03-31').dr).toBe(30000);
    expect(bal(acc('620'), '2026-03-31').cr).toBe(30000);
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('reports recognised-to-date and remaining as of a date', () => {
    const r = deferrals.create({ kind: 'INCOME', deferral_account_id: acc('805'), recognition_account_id: acc('200'), total: 120000, periods: 12, start_date: '2026-01-15' });
    const g = deferrals.get(r.id, '2026-04-30'); // 4 months in
    expect(g.recognised_to_date).toBe(40000);
    expect(g.remaining).toBe(80000);
    expect(g.periods).toHaveLength(12);
    expect(deferrals.progress(r.id, '2026-06-30').recognised_to_date).toBe(60000);
  });

  it('puts the rounding remainder in the final period', () => {
    const r = deferrals.create({ kind: 'INCOME', deferral_account_id: acc('805'), recognition_account_id: acc('200'), total: 10000, periods: 3, start_date: '2026-01-01' });
    const g = deferrals.get(r.id, '2027-01-01');
    expect(g.periods.map((p: any) => p.amount)).toEqual([3333, 3333, 3334]);
    expect(g.periods.reduce((s: number, p: any) => s + p.amount, 0)).toBe(10000); // sums exactly
    expect(bal(acc('200')).cr).toBe(10000);
  });

  it('dates each period to its month', () => {
    const r = deferrals.create({ kind: 'INCOME', deferral_account_id: acc('805'), recognition_account_id: acc('200'), total: 30000, periods: 3, start_date: '2026-01-15' });
    const dates = deferrals.get(r.id).periods.map((p: any) => p.date);
    expect(dates).toEqual(['2026-01-15', '2026-02-15', '2026-03-15']);
  });

  it('voiding reverses every recognition journal', () => {
    const r = deferrals.create({ kind: 'INCOME', deferral_account_id: acc('805'), recognition_account_id: acc('200'), total: 120000, periods: 12, start_date: '2026-01-15' });
    expect(bal(acc('200')).cr).toBe(120000);
    deferrals.voidSchedule(r.id);
    expect(bal(acc('200')).cr).toBe(0);
    expect(bal(acc('805')).dr).toBe(0);
    expect(deferrals.list().find((s: any) => s.id === r.id)).toBeUndefined();
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('each period journal balances (debits = credits)', () => {
    const r = deferrals.create({ kind: 'INCOME', deferral_account_id: acc('805'), recognition_account_id: acc('200'), total: 9999, periods: 4, start_date: '2026-01-01' });
    const rows = getDb().prepare("SELECT j.id, (SELECT SUM(debit) FROM journal_lines WHERE journal_id=j.id) d, (SELECT SUM(credit) FROM journal_lines WHERE journal_id=j.id) c FROM journals j WHERE j.source_type='DEFERRAL' AND j.source_id=?").all(r.id) as any[];
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.d).toBe(row.c);
  });

  it('validates inputs', () => {
    expect(() => deferrals.create({ kind: 'INCOME', deferral_account_id: acc('805'), recognition_account_id: acc('200'), total: 0, periods: 12, start_date: '2026-01-01' })).toThrow(/greater than zero/i);
    expect(() => deferrals.create({ kind: 'INCOME', deferral_account_id: acc('805'), recognition_account_id: acc('200'), total: 1000, periods: 0, start_date: '2026-01-01' })).toThrow(/at least one period/i);
    // income deferral must recognise to a revenue account (400 is an expense)
    expect(() => deferrals.create({ kind: 'INCOME', deferral_account_id: acc('805'), recognition_account_id: acc('400'), total: 1000, periods: 12, start_date: '2026-01-01' })).toThrow(/revenue account/i);
    // holding account must be a balance-sheet account (200 is revenue)
    expect(() => deferrals.create({ kind: 'INCOME', deferral_account_id: acc('200'), recognition_account_id: acc('200'), total: 1000, periods: 12, start_date: '2026-01-01' })).toThrow();
  });
});
