import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as fxrevalue from '../src/backend/services/fxrevalue';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const rate = (ccy: string, r: number, d: string) => getDb().prepare('INSERT OR IGNORE INTO exchange_rates(date,currency_code,rate) VALUES(?,?,?)').run(d, ccy, r);
const AR = (bs: any) => bs.assets.find((a: any) => a.code === '610')?.amount ?? 0;
const AP = (bs: any) => bs.liabilities.find((l: any) => l.code === '800')?.amount ?? 0;
const unrealisedLine = (bs: any) => bs.equity.find((e: any) => /unrealised currency/i.test(e.name))?.amount;
let cust: number, supp: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'C', is_customer: true }).id; supp = contacts.save({ name: 'S', is_supplier: true }).id; rate('EUR', 1.10, '2026-06-01'); });

const eurInvoice = (cents: number) => invoices.approve(invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-06-01', currency_code: 'EUR', exchange_rate: 1.10, lines: [{ description: 'x', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: 2 }] }).id);
const eurBill = (cents: number) => invoices.approve(invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date: '2026-06-01', currency_code: 'EUR', exchange_rate: 1.10, lines: [{ description: 'y', quantity: 1, unit_amount: cents, account_id: acc('400'), tax_rate_id: 2 }] }).id);

describe('on-report FX revaluation (Balance Sheet toggle)', () => {
  it('revalues open foreign AR to the report-date rate and books the gain in equity', () => {
    eurInvoice(100000); rate('EUR', 1.20, '2026-06-30');
    const bs = reports.balanceSheet({ as_at: '2026-06-30', revalue: true });
    expect(AR(bs)).toBe(120000);          // €1,000 × 1.20
    expect(unrealisedLine(bs)).toBe(10000); // gain
    expect(bs.balances).toBe(true);
    expect(bs.revalued_fx).toBe(true);
  });

  it('revalues open foreign AP in the correct direction (liability rises on appreciation)', () => {
    eurBill(100000); rate('EUR', 1.20, '2026-06-30');
    const bs = reports.balanceSheet({ as_at: '2026-06-30', revalue: true });
    expect(AP(bs)).toBe(120000);            // owe more
    expect(unrealisedLine(bs)).toBe(-10000); // a loss
    expect(bs.balances).toBe(true);
  });

  it('nets a mixed AR + AP book and stays balanced', () => {
    eurInvoice(100000); eurBill(50000); rate('EUR', 1.20, '2026-06-30');
    const bs = reports.balanceSheet({ as_at: '2026-06-30', revalue: true });
    expect(AR(bs)).toBe(120000);
    expect(AP(bs)).toBe(60000);
    expect(unrealisedLine(bs)).toBe(5000); // +10,000 AR gain − 5,000 AP loss
    expect(bs.balances).toBe(true);
  });

  it('does nothing when the toggle is off', () => {
    eurInvoice(100000); rate('EUR', 1.20, '2026-06-30');
    const bs = reports.balanceSheet({ as_at: '2026-06-30' });
    expect(AR(bs)).toBe(110000);
    expect(unrealisedLine(bs)).toBeUndefined();
    expect(bs.revalued_fx).toBeFalsy();
  });

  it('is a no-op for a domestic-only book', () => {
    invoices.approve(invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-06-01', lines: [{ description: 'z', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 2 }] }).id);
    const off = reports.balanceSheet({ as_at: '2026-06-30' });
    const on = reports.balanceSheet({ as_at: '2026-06-30', revalue: true });
    expect(AR(on)).toBe(AR(off));
    expect(unrealisedLine(on)).toBeUndefined();
    expect(on.balances).toBe(true);
  });

  it('skips a currency with no rate on/before the date (uses booked) and still balances', () => {
    eurInvoice(100000); // no 2026-06-30 EUR rate added → falls back to the 1.10 booked rate
    const bs = reports.balanceSheet({ as_at: '2026-06-30', revalue: true });
    expect(AR(bs)).toBe(110000); // unchanged (closing rate == booked)
    expect(bs.balances).toBe(true);
  });

  it('does NOT double count when a manual revaluation is already posted at the date', () => {
    eurInvoice(100000); rate('EUR', 1.20, '2026-06-30');
    fxrevalue.revalue('2026-06-30', { EUR: 1.20 }); // posts AR→120,000 in the ledger (reverses next day)
    const bs = reports.balanceSheet({ as_at: '2026-06-30', revalue: true });
    expect(AR(bs)).toBe(120000);           // matches the posted revaluation, not 130,000
    expect(bs.revalued_fx).toBe(false);     // live revaluation skipped — ledger already reflects it
    expect(unrealisedLine(bs)).toBeUndefined();
    expect(bs.balances).toBe(true);
  });

  it('uses the latest rate on/before the date (not a later one)', () => {
    eurInvoice(100000);
    rate('EUR', 1.15, '2026-06-15');
    rate('EUR', 1.30, '2026-07-10'); // after the as-at date — must be ignored
    const bs = reports.balanceSheet({ as_at: '2026-06-30', revalue: true });
    expect(AR(bs)).toBe(115000); // €1,000 × 1.15 (the 2026-06-15 rate)
    expect(bs.balances).toBe(true);
  });
});
