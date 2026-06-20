import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as banking from '../src/backend/services/banking';
import * as accounts from '../src/backend/services/accounts';
import * as reports from '../src/backend/services/reports';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('internal bank transfers', () => {
  let second: number;
  beforeEach(() => {
    initDatabase(':memory:');
    second = acc('091'); // seeded "Business Savings Account"
  });

  it('moves money between accounts with a balanced journal and no P&L impact', () => {
    const main = acc('090');
    const plBefore = reports.profitAndLoss({ from: '2000-01-01', to: '2099-12-31' });
    const tid = banking.createTransfer({ date: '2026-03-10', from_account_id: main, to_account_id: second, amount: 50000, reference: 'To savings' });
    expect(tid).toBeGreaterThan(0);

    const bal = (id: number) => getDb().prepare(
      `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS v FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE jl.account_id=? AND j.status='POSTED'`
    ).get(id).v;
    expect(bal(second)).toBe(50000);   // savings up
    expect(bal(main)).toBe(-50000);    // main down
    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
    const plAfter = reports.profitAndLoss({ from: '2000-01-01', to: '2099-12-31' });
    expect(plAfter.net_profit).toBe(plBefore.net_profit); // a transfer is not income/expense
  });

  it('validates inputs', () => {
    const main = acc('090');
    expect(() => banking.createTransfer({ date: '2026-03-10', from_account_id: main, to_account_id: main, amount: 1000 })).toThrow(/different/i);
    expect(() => banking.createTransfer({ date: '2026-03-10', from_account_id: main, to_account_id: second, amount: 0 })).toThrow(/greater than zero/i);
    expect(() => banking.createTransfer({ date: '2026-02-30', from_account_id: main, to_account_id: second, amount: 1000 })).toThrow(/calendar date/i);
    // a non-bank account can't be used
    const rev = acc('200');
    expect(() => banking.createTransfer({ date: '2026-03-10', from_account_id: main, to_account_id: rev, amount: 1000 })).toThrow(/bank account/i);
  });

  it('supports a different received amount (cross-currency) and still balances', () => {
    const main = acc('090');
    banking.createTransfer({ date: '2026-03-10', from_account_id: main, to_account_id: second, amount: 100000, to_amount: 98000, reference: 'FX' });
    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
  });

  it('void reverses the transfer', () => {
    const main = acc('090');
    const tid = banking.createTransfer({ date: '2026-03-10', from_account_id: main, to_account_id: second, amount: 25000 });
    banking.voidTransfer(tid);
    const bal = (id: number) => getDb().prepare(
      `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS v FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE jl.account_id=? AND j.status='POSTED'`
    ).get(id).v;
    expect(bal(second)).toBe(0);
    expect(() => banking.getTransfer(tid)).toThrow(/not found/i);
  });
});
