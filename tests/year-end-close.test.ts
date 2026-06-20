import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as journals from '../src/backend/services/journals';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const setFYEnd = (m: number, d: number) => getDb().prepare('UPDATE organisations SET financial_year_end_month=?, financial_year_end_day=? WHERE id=1').run(m, d);
let cust: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'C', is_customer: true }).id; });

const sale = (date: string, cents: number) => {
  const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 'x', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: 2 }] });
  invoices.approve(i.id);
};

describe('retained earnings roll-forward', () => {
  it('rolls prior-year profit into Retained Earnings and shows only this year in Current Year Earnings (Dec year-end)', () => {
    setFYEnd(12, 31);
    sale('2024-06-01', 5000000); // FY2024 profit 50,000
    sale('2025-06-01', 2000000); // FY2025 profit 20,000
    const bs = reports.balanceSheet({ as_at: '2025-09-30' });
    expect(bs.fy_start).toBe('2025-01-01');
    expect(bs.retained_earnings).toBe(5000000);
    expect(bs.current_year_earnings).toBe(2000000);
    expect(bs.balances).toBe(true);
  });

  it('respects a 31 March financial year-end (India-style)', () => {
    setFYEnd(3, 31);
    sale('2024-06-01', 10000000); // FY ending Mar 2025
    sale('2025-06-01', 3000000);  // FY ending Mar 2026
    const bs = reports.balanceSheet({ as_at: '2025-09-30' });
    expect(bs.fy_start).toBe('2025-04-01');
    expect(bs.retained_earnings).toBe(10000000);
    expect(bs.current_year_earnings).toBe(3000000);
  });

  it('an as-at date before the year-end uses the prior financial year', () => {
    setFYEnd(3, 31);
    sale('2024-06-01', 10000000);
    sale('2025-02-01', 1000000); // still in FY ending Mar 2025
    const bs = reports.balanceSheet({ as_at: '2025-02-28' });
    expect(bs.fy_start).toBe('2024-04-01');
    expect(bs.current_year_earnings).toBe(11000000); // both sales are this FY
    expect(bs.retained_earnings).toBe(0);
  });

  it('total equity is unchanged by the split (still balances, same total)', () => {
    setFYEnd(12, 31);
    sale('2024-06-01', 4000000);
    sale('2025-06-01', 6000000);
    const bs = reports.balanceSheet({ as_at: '2025-12-31' });
    expect(bs.retained_earnings + bs.current_year_earnings).toBe(10000000); // all profit accounted for
    expect(bs.total_assets).toBe(bs.total_liabilities + bs.total_equity);
  });

  it('combines directly-posted Retained Earnings with rolled-forward prior profit', () => {
    setFYEnd(12, 31);
    // Post an opening retained earnings amount directly (e.g. migrated balance): Cr RE 1,000,000 / Dr a bank
    const jid = journals.saveDraft({
      narration: 'Opening retained earnings', date: '2023-12-31',
      lines: [
        { account_id: acc('960'), debit: 0, credit: 1000000, description: 'Opening RE' },
        { account_id: acc('090'), debit: 1000000, credit: 0, description: 'Opening cash' },
      ],
    });
    journals.post(jid);
    sale('2024-06-01', 5000000); // FY2024 profit → retained next year
    const bs = reports.balanceSheet({ as_at: '2025-06-30' });
    // Retained earnings line = posted 1,000,000 + prior-year P&L 5,000,000
    const reLine = bs.equity.find((e: any) => e.name === 'Retained Earnings' || e.name === 'Retained earnings');
    expect(reLine!.amount).toBe(6000000);
    expect(bs.balances).toBe(true);
  });

  it('clamps an awkward year-end day to the month length', () => {
    setFYEnd(2, 31); // "31 Feb" → clamp to 28/29
    sale('2025-06-01', 1000000);
    const bs = reports.balanceSheet({ as_at: '2025-09-30' });
    expect(bs.fy_start).toBe('2025-03-01'); // day after 28/29 Feb
    expect(bs.balances).toBe(true);
  });
});
