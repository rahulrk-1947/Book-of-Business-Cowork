import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import { call } from '../src/backend/registry';
import * as settings from '../src/backend/services/settings';
import * as contacts from '../src/backend/services/contacts';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('role-based permission gating (via the API the UI uses)', () => {
  let readOnlyId: number;
  let custId: number;
  beforeEach(() => {
    initDatabase(':memory:');
    // Seed a Read-Only user (role id 3 per schema) and a customer.
    readOnlyId = Number(getDb().prepare("INSERT INTO users (name, email, password_hash) VALUES ('Riley ReadOnly','riley@x.com','x')").run().lastInsertRowid);
    getDb().prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, 3)').run(readOnlyId);
    custId = contacts.save({ name: 'Perm Test Co', is_customer: true }).id;
  });

  it('admin (default user 1) can do everything', () => {
    expect((call('settings.getActiveUser', []) as any).is_admin).toBe(true);
    const inv = call('invoices.saveDraft', [{
      type: 'ACCREC', contact_id: custId, date: '2026-03-01',
      lines: [{ description: 'X', quantity: 1, unit_amount: 1000, account_id: acc('200'), tax_rate_id: 2 }],
    }]) as any;
    expect(() => call('invoices.approve', [inv.id])).not.toThrow();
  });

  it('read-only profile is blocked from writes but can read', () => {
    call('settings.setActiveUser', [readOnlyId]);
    const me = call('settings.getActiveUser', []) as any;
    expect(me.roles).toContain('Read Only');
    expect(me.is_admin).toBe(false);
    // reads still work
    expect(() => call('reports.trialBalance', [{ as_at: '2099-12-31' }])).not.toThrow();
    expect(() => call('contacts.list', [{}])).not.toThrow();
    // writes are refused with a helpful message
    expect(() => call('invoices.saveDraft', [{
      type: 'ACCREC', contact_id: custId, date: '2026-03-01',
      lines: [{ description: 'X', quantity: 1, unit_amount: 1000, account_id: acc('200'), tax_rate_id: 2 }],
    }])).toThrow(/permission/i);
    expect(() => call('journals.saveDraft', [{ narration: 'x', date: '2026-03-01', lines: [{ account_id: acc('200'), debit: 1 }, { account_id: acc('200'), credit: 1 }] }])).toThrow(/permission/i);
    expect(() => call('accounts.create', [{ code: '4999', name: 'Nope', type: 'REVENUE' }])).toThrow(/permission/i);
    expect(() => call('recode.recode', [{ targets: [], changes: {} }])).toThrow(/permission/i);
  });

  it('switching back to an adviser restores full rights', () => {
    call('settings.setActiveUser', [readOnlyId]);
    call('settings.setActiveUser', [1]);
    expect(() => call('accounts.create', [{ code: '4998', name: 'OK now', type: 'REVENUE' }])).not.toThrow();
  });
});
