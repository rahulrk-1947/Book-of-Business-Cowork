import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as journals from '../src/backend/services/journals';
import * as search from '../src/backend/services/search';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('global quick search', () => {
  let cust: number;
  beforeEach(() => {
    initDatabase(':memory:');
    cust = contacts.save({ name: 'Northwind Traders', email: 'hello@northwind.test', is_customer: true }).id;
    const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-03-01', reference: 'PO-998', lines: [{ description: 'Widgets', quantity: 1, unit_amount: 5000, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(inv.id);
  });

  const groupTypes = (r: any) => r.groups.map((g: any) => g.type);

  it('finds a contact by name and by email', () => {
    expect(groupTypes(search.global('north'))).toContain('contact');
    expect(groupTypes(search.global('northwind.test'))).toContain('contact');
  });

  it('finds a document by number, by reference, and by contact name', () => {
    expect(groupTypes(search.global('INV'))).toContain('document');
    expect(groupTypes(search.global('PO-998'))).toContain('document');
    const byContact = search.global('northwind');
    expect(byContact.groups.find((g: any) => g.type === 'document')).toBeTruthy();
  });

  it('finds an account by code and by name', () => {
    expect(groupTypes(search.global('200'))).toContain('account');
    const named = search.global('Sales');
    expect(named.groups.find((g: any) => g.type === 'account')).toBeTruthy();
  });

  it('finds a manual journal by narration', () => {
    const id = journals.saveDraft({ narration: 'Depreciation catch-up', date: '2026-03-31', lines: [{ account_id: acc('200'), debit: 1000 }, { account_id: acc('090'), credit: 1000 }] });
    journals.post(id);
    expect(groupTypes(search.global('depreciation'))).toContain('journal');
  });

  it('returns each hit with a way to open it', () => {
    const r = search.global('north');
    for (const g of r.groups) for (const h of g.hits) {
      expect(h.open).toBeTruthy();
      expect(['source', 'nav']).toContain(h.open.kind);
      if (h.open.kind === 'nav') expect(typeof h.open.hash).toBe('string');
      else { expect(typeof h.open.source).toBe('string'); expect(typeof h.open.id).toBe('number'); }
    }
  });

  it('ranks an exact contact-name match first', () => {
    contacts.save({ name: 'North', is_customer: true });
    const r = search.global('North');
    const c = r.groups.find((g: any) => g.type === 'contact')!;
    expect(c.hits[0].title).toBe('North'); // exact match outranks "Northwind Traders"
  });

  it('returns nothing for an empty query', () => {
    expect(search.global('').groups).toHaveLength(0);
    expect(search.global('   ').groups).toHaveLength(0);
  });

  it('excludes deleted/voided documents', () => {
    const draft = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-03-02', reference: 'ZZZ-DELME', lines: [{ description: 'x', quantity: 1, unit_amount: 100, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.voidDoc(draft.id);
    const r = search.global('ZZZ-DELME');
    expect(r.groups.find((g: any) => g.type === 'document')).toBeFalsy();
  });
});
