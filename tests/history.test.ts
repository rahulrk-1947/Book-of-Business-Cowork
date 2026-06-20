import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as settings from '../src/backend/services/settings';
import * as history from '../src/backend/services/history';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

function seedUsers() {
  // user 1 already exists; add a second to attribute a change to someone else
  return Number(getDb().prepare("INSERT INTO users (name, email, password_hash) VALUES ('Sam Senior','sam@x.com','x')").run().lastInsertRowid);
}

describe('document change history', () => {
  let cust: number;
  beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'History Co', is_customer: true }).id; });

  it('records create, edit (with before/after), and approve — attributed to the acting user', () => {
    const samId = seedUsers();
    // created by user 1
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-01', reference: 'first',
      lines: [{ description: 'Initial work', quantity: 1, unit_amount: 50000, account_id: acc('200'), tax_rate_id: 2 }],
    }, 1);
    // edited by Sam: changed amount + reference
    invoices.saveDraft({
      id: inv.id, type: 'ACCREC', contact_id: cust, date: '2026-03-01', reference: 'revised',
      lines: [{ description: 'Initial work', quantity: 1, unit_amount: 80000, account_id: acc('200'), tax_rate_id: 2 }],
    }, samId);
    // approved by user 1
    invoices.approve(inv.id, 1);

    const h = history.forDocument('INVOICE', inv.id);
    const labels = h.events.map((e) => e.label);
    // newest first
    expect(labels[0]).toBe('Approved');
    expect(labels).toContain('Edited');
    expect(labels[labels.length - 1]).toBe('Created');

    const edit = h.events.find((e) => e.label === 'Edited')!;
    expect(edit.user).toBe('Sam Senior');
    expect(edit.before).toBeTruthy();
    expect(edit.after).toBeTruthy();
    // the before/after capture the actual change
    expect((edit.before as any).reference).toBe('first');
    expect((edit.after as any).reference).toBe('revised');
    expect((edit.before as any).total).toBe(50000);
    expect((edit.after as any).total).toBe(80000);

    const created = h.events.find((e) => e.label === 'Created')!;
    expect(created.user).toBe('Administrator'); // user 1 is the seeded admin
  });

  it('folds a Find & Recode change into the document history', async () => {
    const fr = await import('../src/backend/services/find_recode');
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-03-01',
      lines: [{ description: 'Job', quantity: 1, unit_amount: 50000, account_id: acc('200'), tax_rate_id: 2 }],
    }, 1);
    invoices.approve(inv.id, 1);
    const line = fr.search({ match: 'all', conds: [{ field: 'account', op: 'in', values: [acc('200')] }] }).lines[0];
    fr.recode({ targets: [line], changes: { account_id: acc('260') } }, 1);
    const h = history.forDocument('INVOICE', inv.id);
    expect(h.events.some((e) => e.label.includes('Re-coded'))).toBe(true);
  });
});
