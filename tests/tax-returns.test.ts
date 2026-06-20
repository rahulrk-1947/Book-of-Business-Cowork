import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as taxreturns from '../src/backend/services/taxreturns';
import * as settings from '../src/backend/services/settings';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
let cust: number, supp: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'C', is_customer: true }).id; supp = contacts.save({ name: 'S', is_supplier: true }).id; });

const sale = (date: string, net: number, rate = 3) => { const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 's', quantity: 1, unit_amount: net, account_id: acc('200'), tax_rate_id: rate }] }); invoices.approve(i.id); return i.id; };
const purchase = (date: string, net: number, rate = 4) => { const i = invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date, lines: [{ description: 'b', quantity: 1, unit_amount: net, account_id: acc('400'), tax_rate_id: rate }] }); invoices.approve(i.id); return i.id; };

describe('tax (GST/VAT) returns', () => {
  it('computes output tax, input tax and net payable for a period', () => {
    sale('2026-04-10', 100000);   // 10% → 10,000 output
    purchase('2026-04-12', 40000); // 10% → 4,000 input
    const p = taxreturns.prepare({ from: '2026-04-01', to: '2026-06-30' });
    expect(p.collected).toBe(10000);
    expect(p.paid).toBe(4000);
    expect(p.net).toBe(6000);
    expect(p.payable).toBe(6000);
    expect(p.refundable).toBe(0);
  });

  it('shows a refundable position when input tax exceeds output', () => {
    sale('2026-04-10', 10000);     // 1,000 output
    purchase('2026-04-12', 50000);  // 5,000 input
    const p = taxreturns.prepare({ from: '2026-04-01', to: '2026-06-30' });
    expect(p.net).toBe(-4000);
    expect(p.refundable).toBe(4000);
    expect(p.payable).toBe(0);
  });

  it('only includes documents within the period', () => {
    sale('2026-03-31', 100000); // before period
    sale('2026-05-01', 50000);  // inside
    const p = taxreturns.prepare({ from: '2026-04-01', to: '2026-06-30' });
    expect(p.collected).toBe(5000); // only the May sale's tax
  });

  it('filing records the return and locks the period', () => {
    sale('2026-04-10', 100000);
    const f: any = taxreturns.file({ from: '2026-04-01', to: '2026-06-30', note: 'Q1 FY27' });
    expect(f.net).toBe(10000);
    expect(taxreturns.list()).toHaveLength(1);
    expect(settings.getOrganisation().lock_date).toBe('2026-06-30');
    // posting a new document inside the filed period is blocked
    const late = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-05-15', lines: [{ description: 'late', quantity: 1, unit_amount: 1000, account_id: acc('200'), tax_rate_id: 3 }] });
    expect(() => invoices.approve(late.id)).toThrow(/lock/i);
  });

  it('prepare flags a period that has already been filed', () => {
    sale('2026-04-10', 100000);
    expect(taxreturns.prepare({ from: '2026-04-01', to: '2026-06-30' }).already_filed).toBe(false);
    taxreturns.file({ from: '2026-04-01', to: '2026-06-30' });
    expect(taxreturns.prepare({ from: '2026-04-01', to: '2026-06-30' }).already_filed).toBe(true);
  });

  it('filing only advances the lock date, never moves it backwards', () => {
    sale('2026-04-10', 100000);
    settings.setLockDate('2026-12-31', null); // a later manual lock, set after the sale
    taxreturns.file({ from: '2026-04-01', to: '2026-06-30' });
    expect(settings.getOrganisation().lock_date).toBe('2026-12-31'); // unchanged
  });

  it('unfiling the latest return rolls the lock back to the previous return', () => {
    sale('2026-04-10', 100000);
    sale('2026-07-10', 100000);
    taxreturns.file({ from: '2026-04-01', to: '2026-06-30' });
    const q2: any = taxreturns.file({ from: '2026-07-01', to: '2026-09-30' });
    expect(settings.getOrganisation().lock_date).toBe('2026-09-30');
    taxreturns.unfile(q2.id);
    expect(settings.getOrganisation().lock_date).toBe('2026-06-30'); // back to the remaining return
    expect(taxreturns.list()).toHaveLength(1);
  });

  it('unfiling the only return clears the lock', () => {
    sale('2026-04-10', 100000);
    const f: any = taxreturns.file({ from: '2026-04-01', to: '2026-06-30' });
    taxreturns.unfile(f.id);
    expect(settings.getOrganisation().lock_date).toBeNull();
  });

  it('rejects a period whose end precedes its start', () => {
    expect(() => taxreturns.prepare({ from: '2026-06-30', to: '2026-04-01' })).toThrow(/before/i);
  });
});
