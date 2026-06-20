import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as fxrevalue from '../src/backend/services/fxrevalue';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
// Net balance of a system account as at a date (so we see the revaluation before its next-day reversal).
const natBal = (sys: string, asOf: string) => {
  const r: any = getDb().prepare(
    `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS dr_minus_cr, COALESCE(SUM(jl.credit - jl.debit),0) AS cr_minus_dr
       FROM journal_lines jl JOIN accounts a ON a.id=jl.account_id JOIN journals j ON j.id=jl.journal_id
      WHERE a.system_account=? AND j.status='POSTED' AND j.date<=?`).get(sys, asOf);
  return r;
};
beforeEach(() => { initDatabase(':memory:'); getDb().prepare("INSERT OR IGNORE INTO exchange_rates(date,currency_code,rate) VALUES('2026-06-01','EUR',1.10)").run(); });

function eurBill() { const s = contacts.save({ name: 'S', is_supplier: true }).id; const b = invoices.saveDraft({ type: 'ACCPAY', contact_id: s, date: '2026-06-01', currency_code: 'EUR', exchange_rate: 1.10, lines: [{ description: 'y', quantity: 1, unit_amount: 100000, account_id: acc('400'), tax_rate_id: 2 }] }); invoices.approve(b.id); }
function eurInvoice() { const c = contacts.save({ name: 'C', is_customer: true }).id; const i = invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-06-01', currency_code: 'EUR', exchange_rate: 1.10, lines: [{ description: 'x', quantity: 1, unit_amount: 100000, account_id: acc('200'), tax_rate_id: 2 }] }); invoices.approve(i.id); }

describe('FX revaluation — posted ledger direction (regression for the AP sign bug)', () => {
  it('foreign PAYABLE that appreciated: liability rises, books a loss', () => {
    eurBill(); // AP carries 110,000
    fxrevalue.revalue('2026-06-15', { EUR: 1.20 }); // now owe 120,000
    expect(natBal('AP', '2026-06-15').cr_minus_dr).toBe(120000);          // liability INCREASED
    expect(natBal('UNREALISED_FX', '2026-06-15').dr_minus_cr).toBe(10000); // expense up = loss
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('foreign PAYABLE that depreciated: liability falls, books a gain', () => {
    eurBill();
    fxrevalue.revalue('2026-06-15', { EUR: 1.00 }); // now owe 100,000
    expect(natBal('AP', '2026-06-15').cr_minus_dr).toBe(100000);
    expect(natBal('UNREALISED_FX', '2026-06-15').dr_minus_cr).toBe(-10000); // negative expense = gain
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('foreign RECEIVABLE that appreciated: asset rises, books a gain', () => {
    eurInvoice(); // AR carries 110,000
    fxrevalue.revalue('2026-06-15', { EUR: 1.20 });
    expect(natBal('AR', '2026-06-15').dr_minus_cr).toBe(120000);
    expect(natBal('UNREALISED_FX', '2026-06-15').dr_minus_cr).toBe(-10000); // gain
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('foreign RECEIVABLE that depreciated: asset falls, books a loss', () => {
    eurInvoice();
    fxrevalue.revalue('2026-06-15', { EUR: 1.00 });
    expect(natBal('AR', '2026-06-15').dr_minus_cr).toBe(100000);
    expect(natBal('UNREALISED_FX', '2026-06-15').dr_minus_cr).toBe(10000); // loss
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('posted netGain matches preview.total_gain for a mixed AR + AP book', () => {
    eurInvoice(); eurBill();
    const pv = fxrevalue.preview('2026-06-15', { EUR: 1.20 }); // AR +10,000 gain, AP +10,000 loss → net 0
    expect(pv.total_gain).toBe(0);
    fxrevalue.revalue('2026-06-15', { EUR: 1.20 });
    // Net unrealised P&L is zero; AR and AP each moved to 120,000.
    expect(natBal('AR', '2026-06-15').dr_minus_cr).toBe(120000);
    expect(natBal('AP', '2026-06-15').cr_minus_dr).toBe(120000);
    expect(natBal('UNREALISED_FX', '2026-06-15').dr_minus_cr).toBe(0);
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('the next-day reversal cancels the revaluation entirely', () => {
    eurBill();
    fxrevalue.revalue('2026-06-15', { EUR: 1.20 });
    // As at the day AFTER, the revaluation and its reversal net out → AP back to booked 110,000.
    expect(natBal('AP', '2026-06-16').cr_minus_dr).toBe(110000);
    expect(natBal('UNREALISED_FX', '2026-06-16').dr_minus_cr).toBe(0);
    expect(reports.integrityCheck().ok).toBe(true);
  });
});
