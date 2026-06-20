import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
let cust: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'BuildCo', is_customer: true }).id; });

function quote(lines: Array<[number, string?, number?]>, mode: 'EXCLUSIVE' | 'INCLUSIVE' = 'EXCLUSIVE') {
  const q = invoices.saveQuote({
    contact_id: cust, date: '2026-06-01', line_amount_type: mode,
    lines: lines.map(([cents, desc, tax]) => ({ description: desc ?? 'Work', quantity: 1, unit_amount: cents, account_id: acc('200'), tax_rate_id: tax ?? 2 })),
  });
  invoices.setQuoteStatus(q.id, 'ACCEPTED');
  return q.id;
}
const fromQuote = (invId: number) => (getDb().prepare('SELECT from_quote_id, progress_pct FROM invoices WHERE id = ?').get(invId) as any);

describe('progress invoicing', () => {
  it('reports zero progress on a fresh quote', () => {
    const q = quote([[100000]]);
    const p = invoices.quoteProgress(q);
    expect(p.total).toBe(100000);
    expect(p.invoiced).toBe(0);
    expect(p.remaining).toBe(100000);
    expect(p.invoices).toHaveLength(0);
  });

  it('bills a percentage, scaling every line and linking the invoice', () => {
    const q = quote([[40000, 'Design'], [60000, 'Build']]);
    const r = invoices.invoiceQuoteProgress({ quote_id: q, percent: 30, date: '2026-06-02' });
    expect(r.progress.invoiced).toBe(30000);  // 30% of 100,000
    expect(r.progress.remaining).toBe(70000);
    expect(r.progress.invoiced_pct).toBe(30);
    const link = fromQuote(r.invoice_id);
    expect(link.from_quote_id).toBe(q);
    expect(link.progress_pct).toBe(30);
    const inv = invoices.get(r.invoice_id);
    expect(inv.total).toBe(30000);
    expect(inv.lines).toHaveLength(2); // both quote lines, scaled
  });

  it('bills a flat amount', () => {
    const q = quote([[100000]]);
    const r = invoices.invoiceQuoteProgress({ quote_id: q, amount: 25000 });
    expect(r.progress.invoiced).toBe(25000);
    expect(r.progress.remaining).toBe(75000);
  });

  it('accumulates across several progress invoices and marks the quote invoiced at 100%', () => {
    const q = quote([[100000]]);
    invoices.invoiceQuoteProgress({ quote_id: q, percent: 30 });
    invoices.invoiceQuoteProgress({ quote_id: q, percent: 50 });
    expect(invoices.getQuote(q).status).toBe('ACCEPTED'); // not yet fully billed
    const r = invoices.invoiceQuoteProgress({ quote_id: q, percent: 20 });
    expect(r.progress.invoiced).toBe(100000);
    expect(r.progress.remaining).toBe(0);
    expect(invoices.getQuote(q).status).toBe('INVOICED');
    expect(r.progress.invoices).toHaveLength(3);
  });

  it('refuses to invoice more than the quote total', () => {
    const q = quote([[100000]]);
    invoices.invoiceQuoteProgress({ quote_id: q, percent: 80 });
    expect(() => invoices.invoiceQuoteProgress({ quote_id: q, percent: 30 })).toThrow(/more than the quote total/i);
    // but the exact remaining is allowed
    expect(() => invoices.invoiceQuoteProgress({ quote_id: q, percent: 20 })).not.toThrow();
  });

  it('carries tax through proportionally and posts correctly when approved', () => {
    const q = quote([[100000, 'Taxed work', 3]]); // 10% sales tax
    const r = invoices.invoiceQuoteProgress({ quote_id: q, percent: 50 });
    const inv = invoices.get(r.invoice_id);
    expect(inv.subtotal).toBe(50000);   // half the net
    expect(inv.total_tax).toBe(5000);   // half the tax
    expect(inv.total).toBe(55000);
    invoices.approve(r.invoice_id);
    const arId = getDb().prepare("SELECT id FROM accounts WHERE system_account='AR'").get().id as number;
    const ar = getDb().prepare("SELECT COALESCE(SUM(debit-credit),0) d FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE jl.account_id=? AND j.status='POSTED'").get(arId) as any;
    expect(ar.d).toBe(55000);
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('excludes voided progress invoices from the total', () => {
    const q = quote([[100000]]);
    const r1 = invoices.invoiceQuoteProgress({ quote_id: q, percent: 40 });
    invoices.approve(r1.invoice_id);
    invoices.voidDoc(r1.invoice_id);
    const p = invoices.quoteProgress(q);
    expect(p.invoiced).toBe(0); // voided one no longer counts
    expect(p.remaining).toBe(100000);
  });

  it('validates inputs', () => {
    const q = quote([[100000]]);
    expect(() => invoices.invoiceQuoteProgress({ quote_id: q })).toThrow(/percentage or an amount/i);
    expect(() => invoices.invoiceQuoteProgress({ quote_id: q, percent: 0 })).toThrow(/greater than zero/i);
    expect(() => invoices.invoiceQuoteProgress({ quote_id: 9999, percent: 10 })).toThrow(/not found/i);
  });
});
