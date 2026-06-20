import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import { call } from '../src/backend/registry';
import { setCurrentUser } from '../src/backend/session';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
let supp: number;
beforeEach(() => {
  initDatabase(':memory:');
  supp = contacts.save({ name: 'Supplier Co', is_supplier: true, addresses: [{ type: 'BILLING', line1: '5 Dock Rd', city: 'Port', country: 'NZ' }] }).id;
});

const poLines = () => [{ description: 'Widgets', quantity: 10, unit_amount: 2500, account_id: acc('400'), tax_rate_id: 2 }];

describe('purchase orders', () => {
  it('creates a PO with an auto number and lists it', () => {
    const po = invoices.savePO({ contact_id: supp, date: '2026-03-01', delivery_date: '2026-03-15', lines: poLines() });
    expect(po.order_number).toBeTruthy();
    expect(po.status).toBe('DRAFT');
    expect(invoices.listPOs()).toHaveLength(1);
  });

  it('approves a PO then converts it to a bill (and marks it BILLED)', () => {
    const po = invoices.savePO({ contact_id: supp, date: '2026-03-01', lines: poLines() });
    invoices.setPOStatus(po.id, 'APPROVED');
    const bill = invoices.poToBill(po.id);
    expect(bill.type).toBe('ACCPAY');
    expect(bill.contact_id).toBe(supp);
    expect(bill.reference).toBe(po.order_number);
    expect(invoices.getPO(po.id).status).toBe('BILLED');
    // the bill carries the PO's lines
    const full = invoices.get(bill.id);
    expect(full.lines).toHaveLength(1);
    expect(full.lines[0].quantity).toBe(10);
  });

  it('getPO returns supplier address + line accounts for the PDF', () => {
    const po = invoices.savePO({ contact_id: supp, date: '2026-03-01', lines: poLines() });
    const got = invoices.getPO(po.id);
    expect(got.contact_address.line1).toBe('5 Dock Rd');
    expect(got.lines[0].account_code).toBe('400');
  });

  it('PO and quote writes are permission-gated', () => {
    // With a permitted user (the seeded owner), creating a PO works.
    setCurrentUser(1);
    const po: any = call('invoices.savePO', [{ contact_id: supp, date: '2026-03-01', lines: poLines() }]);
    expect(po.id).toBeGreaterThan(0);
    // With no current user (no permissions), the same call is refused — proving the gate is wired.
    setCurrentUser(null as any);
    expect(() => call('invoices.savePO', [{ contact_id: supp, date: '2026-03-01', lines: poLines() }])).toThrow(/permission/i);
    expect(() => call('invoices.poToBill', [po.id])).toThrow(/permission/i);
    expect(() => call('invoices.saveQuote', [{ contact_id: supp, date: '2026-03-01', lines: poLines() }])).toThrow(/permission/i);
    setCurrentUser(1);
  });
});
