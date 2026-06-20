import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as banking from '../src/backend/services/banking';
import * as recurring from '../src/backend/services/recurring';
import * as forecast from '../src/backend/services/forecast';
import * as payments from '../src/backend/services/payments';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('cash-flow forecast', () => {
  let cust: number, supp: number;
  beforeEach(() => {
    initDatabase(':memory:');
    cust = contacts.save({ name: 'Customer Co', is_customer: true }).id;
    supp = contacts.save({ name: 'Supplier Co', is_supplier: true }).id;
  });

  const invoice = (due: string, amt: number) => {
    const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-06-01', due_date: due, lines: [{ description: 'x', quantity: 1, unit_amount: amt, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(i.id); return i.id;
  };
  const bill = (due: string, amt: number) => {
    const i = invoices.saveDraft({ type: 'ACCPAY', contact_id: supp, date: '2026-06-01', due_date: due, lines: [{ description: 'y', quantity: 1, unit_amount: amt, account_id: acc('400') }] });
    invoices.approve(i.id); return i.id;
  };

  it('projects inflows and outflows on their due dates within the horizon', () => {
    invoice('2026-06-20', 100000);
    bill('2026-06-25', 40000);
    const f = forecast.cashFlow({ as_of: '2026-06-10', horizon_days: 90 });
    expect(f.total_in).toBe(100000);
    expect(f.total_out).toBe(40000);
    expect(f.projected_closing).toBe(f.opening + 60000);
    expect(f.movements).toHaveLength(2);
  });

  it('excludes documents that settle beyond the horizon', () => {
    invoice('2026-06-15', 5000);   // within 30 days
    invoice('2026-09-15', 9000);   // beyond 30 days
    const f = forecast.cashFlow({ as_of: '2026-06-10', horizon_days: 30 });
    expect(f.total_in).toBe(5000);
  });

  it('treats overdue invoices as expected now (within horizon)', () => {
    invoice('2026-05-01', 7000); // already overdue at as_of
    const f = forecast.cashFlow({ as_of: '2026-06-10', horizon_days: 30 });
    expect(f.total_in).toBe(7000);
    expect(f.movements[0].date).toBe('2026-06-10'); // pulled to as_of
  });

  it('includes upcoming recurring invoices as estimated inflows', () => {
    recurring.save({
      name: 'Monthly retainer', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', every_n: 1,
      start_date: '2026-06-15', due_days: 0,
      lines: [{ description: 'Retainer', quantity: 1, unit_amount: 30000, account_id: acc('200'), tax_rate_id: 2 }],
    });
    const f = forecast.cashFlow({ as_of: '2026-06-10', horizon_days: 90 });
    // ~3 monthly issues land within 90 days (Jun 15, Jul 15, Aug 15)
    const est = f.movements.filter((m: any) => m.estimated);
    expect(est.length).toBeGreaterThanOrEqual(3);
    expect(est.every((m: any) => m.in === 30000)).toBe(true);
    expect(f.total_in).toBeGreaterThanOrEqual(90000);
  });

  it('starts from current bank balance as opening cash', () => {
    // put money in the bank via a transfer-in style: receive payment on an invoice
    const id = invoice('2026-06-05', 50000);
    void banking;
    // receive the payment into the bank, allocated to the invoice
    payments.create({ type: 'RECEIVE', date: '2026-06-05', bank_account_id: acc('090'), contact_id: cust, amount: 50000, allocations: [{ invoice_id: id, amount: 50000 }] });
    const f = forecast.cashFlow({ as_of: '2026-06-10', horizon_days: 30 });
    expect(f.opening).toBe(50000);
  });

  it('flags the first date the projected balance goes negative', () => {
    bill('2026-06-20', 80000); // big outflow, no cash
    const f = forecast.cashFlow({ as_of: '2026-06-10', horizon_days: 30 });
    expect(f.first_negative_date).toBe('2026-06-20');
    expect(f.lowest_balance).toBeLessThan(0);
  });

  it('builds a continuous weekly balance series across the horizon', () => {
    invoice('2026-06-20', 10000);
    const f = forecast.cashFlow({ as_of: '2026-06-10', horizon_days: 28 });
    expect(f.weeks.length).toBeGreaterThanOrEqual(4);
    // last week reflects the inflow
    expect(f.weeks[f.weeks.length - 1].balance).toBe(f.opening + 10000);
  });
});
