import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as fx from '../src/backend/services/fxrevalue';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;
const sysId = (sa: string) => getDb().prepare('SELECT id FROM accounts WHERE system_account = ?').get(sa).id as number;
const bal = (id: number) => getDb().prepare(
  `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS v FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE jl.account_id=? AND j.status='POSTED'`
).get(id).v as number;

let cust: number, supp: number;
beforeEach(() => {
  initDatabase(':memory:');
  // ensure a foreign currency + a rate exist
  getDb().prepare("INSERT OR IGNORE INTO currencies (code, name) VALUES ('EUR','Euro')").run();
  cust = contacts.save({ name: 'Euro Customer', is_customer: true }).id;
  supp = contacts.save({ name: 'Euro Supplier', is_supplier: true }).id;
});

// A €1,000 invoice booked at 1.10 → AR carries 1100.00 base.
function eurInvoice(rate = 1.10) {
  const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-03-01', currency_code: 'EUR', exchange_rate: rate, lines: [{ description: 'x', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 2 }] });
  invoices.approve(inv.id);
  return inv.id;
}
function eurBill(rate = 1.10) {
  const inv = invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date: '2026-03-01', currency_code: 'EUR', exchange_rate: rate, lines: [{ description: 'y', quantity: 1, unit_amount: 100000, account_id: acc('400') }] });
  invoices.approve(inv.id);
  return inv.id;
}

describe('unrealised FX revaluation', () => {
  it('preview computes the gain when the foreign currency strengthens (AR)', () => {
    eurInvoice(1.10);
    const pv = fx.preview('2026-03-31', { EUR: 1.20 });
    const line = pv.lines.find((l) => l.currency === 'EUR' && l.control === 'AR')!;
    expect(line.carrying_base).toBe(110000);  // €1000 × 1.10
    expect(line.revalued_base).toBe(120000);  // €1000 × 1.20
    expect(line.delta).toBe(10000);           // +€-value
    expect(pv.total_gain).toBe(10000);        // AR up = gain
  });

  it('posts a balanced revaluation and a next-day reversal (AR gain)', () => {
    eurInvoice(1.10);
    const arBefore = bal(sysId('AR'));
    const r = fx.revalue('2026-03-31', { EUR: 1.20 });
    expect(r.posted).toBe(true);
    // On the revaluation date itself, AR is higher by 10000 and Unrealised FX shows a gain (credit).
    const arOn = getDb().prepare(
      `SELECT COALESCE(SUM(jl.debit-jl.credit),0) AS v FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE jl.account_id=? AND j.status='POSTED' AND j.date<='2026-03-31'`
    ).get(sysId('AR')).v;
    expect(arOn).toBe(arBefore + 10000);
    // After the next-day reversal, everything nets back to zero adjustment.
    expect(bal(sysId('AR'))).toBe(arBefore);
    expect(bal(sysId('UNREALISED_FX'))).toBe(0);
    // the whole ledger still balances
    const tb = getDb().prepare("SELECT COALESCE(SUM(debit),0) d, COALESCE(SUM(credit),0) c FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE j.status='POSTED'").get();
    expect(tb.d).toBe(tb.c);
  });

  it('treats an AP increase as a loss (opposite sign)', () => {
    eurBill(1.10);
    const pv = fx.preview('2026-03-31', { EUR: 1.20 });
    const line = pv.lines.find((l) => l.control === 'AP')!;
    expect(line.delta).toBe(10000);      // AP base rises
    expect(pv.total_gain).toBe(-10000);  // ...which is a loss
  });

  it('requires a rate for every open foreign currency', () => {
    eurInvoice();
    expect(() => fx.revalue('2026-03-31', {})).toThrow(/closing rate for/i);
  });

  it('does nothing when rates are unchanged', () => {
    eurInvoice(1.10);
    const r = fx.revalue('2026-03-31', { EUR: 1.10 });
    expect(r.posted).toBe(false);
    expect(r.message).toMatch(/no revaluation needed/i);
  });

  it('ignores base-currency and fully-paid documents', () => {
    // base-currency invoice
    invoices.approve(invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-03-01', lines: [{ description: 'x', quantity: 1, unit_amount: 5000, account_id: acc('200'), tax_rate_id: 2 }] }).id);
    const pv = fx.preview('2026-03-31', { EUR: 1.20 });
    expect(pv.lines.length).toBe(0); // nothing foreign+open
    expect(fx.openForeignCurrencies('2026-03-31')).toEqual([]);
  });

  it('lists open foreign currencies for the UI', () => {
    eurInvoice();
    expect(fx.openForeignCurrencies('2026-03-31')).toEqual(['EUR']);
  });
});
