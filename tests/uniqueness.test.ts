import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as accounts from '../src/backend/services/accounts';
import * as settings from '../src/backend/services/settings';
import * as itemsSvc from '../src/backend/services/items';
import * as imports from '../src/backend/services/imports';

describe('name uniqueness', () => {
  beforeEach(() => initDatabase(':memory:'));

  it('contacts: blocks duplicates case- and space-insensitively, allows rename of self', () => {
    const a = contacts.save({ name: 'Anchor Coworking', is_customer: true });
    expect(() => contacts.save({ name: 'anchor coworking ', is_customer: true })).toThrow(/already exists/i);
    expect(() => contacts.save({ name: 'Anchor Coworking', is_customer: true })).toThrow(/already exists/i);
    // editing the same record to an unchanged name is fine
    expect(() => contacts.save({ id: a.id, name: 'Anchor Coworking', is_customer: true, is_supplier: true })).not.toThrow();
    // a genuinely different name is fine
    expect(() => contacts.save({ name: 'Anchor Coworking East', is_customer: true })).not.toThrow();
    // once archived, the name frees up
    contacts.archive(a.id);
    expect(() => contacts.save({ name: 'Anchor Coworking', is_customer: true })).not.toThrow();
  });

  it('accounts: code and name are both unique', () => {
    accounts.create({ code: '4100', name: 'Workshop Income', type: 'REVENUE' });
    expect(() => accounts.create({ code: '4100', name: 'Something else', type: 'REVENUE' })).toThrow(/code/i);
    expect(() => accounts.create({ code: '4101', name: 'workshop income', type: 'REVENUE' })).toThrow(/named/i);
    expect(() => accounts.create({ code: '4101', name: 'Workshop Income (NZ)', type: 'REVENUE' })).not.toThrow();
  });

  it('tracking: category names unique; option names unique within a category and within one save', () => {
    const id = settings.saveTrackingCategory({ name: 'Region', options: [{ name: 'North' }, { name: 'South' }] });
    expect(() => settings.saveTrackingCategory({ name: 'region', options: [{ name: 'X' }] })).toThrow(/category/i);
    // adding a duplicate option to the same category
    expect(() => settings.saveTrackingCategory({ id, name: 'Region', options: [{ name: 'north' }] })).toThrow(/option/i);
    // duplicate within a single submission
    expect(() => settings.saveTrackingCategory({ name: 'Channel', options: [{ name: 'Web' }, { name: 'web' }] })).toThrow(/twice/i);
    // same option name in a DIFFERENT category is fine
    expect(() => settings.saveTrackingCategory({ name: 'Department', options: [{ name: 'North' }] })).not.toThrow();
  });

  it('tax rates and items are guarded too', () => {
    settings.saveTaxRate({ name: 'City Levy', tax_type: 'OUTPUT', components: [{ name: 'Levy', percent: 2 }] });
    expect(() => settings.saveTaxRate({ name: 'city levy', tax_type: 'OUTPUT', components: [{ name: 'L', percent: 2 }] })).toThrow(/tax rate/i);
    itemsSvc.save({ code: 'SKU1', name: 'Coffee Beans', i_sell: true });
    expect(() => itemsSvc.save({ code: 'sku1', name: 'Other', i_sell: true })).toThrow(/code/i);
    expect(() => itemsSvc.save({ code: 'SKU2', name: 'coffee beans', i_sell: true })).toThrow(/named/i);
  });

  it('CSV import reuses an existing contact instead of erroring on the duplicate guard', () => {
    contacts.save({ name: 'Fresh Fields Produce', is_supplier: true });
    const before = getDb().prepare("SELECT COUNT(*) AS n FROM contacts").get().n;
    const csv = [
      'ContactName,Number,Date,Description,Quantity,UnitAmount,AccountCode',
      'fresh fields produce ,BILL-1,2026-03-01,Produce,1,120.00,310', // different case + trailing space
    ].join('\n');
    const r = imports.importDocuments({ type: 'ACCPAY', csv });
    expect(r.created).toHaveLength(1);
    expect(r.errors).toHaveLength(0);
    expect(r.contacts_created).toBe(0); // matched the existing one
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM contacts").get().n).toBe(before);
  });
});
