import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as dashboard from '../src/backend/services/dashboard';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('onboarding setup status', () => {
  beforeEach(() => initDatabase(':memory:'));

  it('reports tax, bank already done from seed, contact + invoice pending', () => {
    const s = dashboard.setupStatus();
    const by = Object.fromEntries(s.steps.map((x: any) => [x.id, x.done]));
    expect(by.tax).toBe(true);
    expect(by.bank).toBe(true);
    expect(by.contact).toBe(false);
    expect(by.invoice).toBe(false);
    expect(s.complete).toBe(false);
  });

  it('marks contact done once one exists', () => {
    contacts.save({ name: 'Acme', is_customer: true });
    const by = Object.fromEntries(dashboard.setupStatus().steps.map((x: any) => [x.id, x.done]));
    expect(by.contact).toBe(true);
  });

  it('becomes complete once all required steps are satisfied', () => {
    // org name
    const db = getDb();
    db.prepare("UPDATE organisations SET trading_name = 'Real Biz' WHERE id = 1").run();
    // contact + invoice
    const c = contacts.save({ name: 'Acme', is_customer: true }).id;
    invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-03-01', lines: [{ description: 'x', quantity: 1, unit_amount: 1000, account_id: acc('200'), tax_rate_id: 2 }] });
    const s = dashboard.setupStatus();
    expect(s.complete).toBe(true);
    expect(s.done_count).toBe(s.total);
  });

  it('counts only required steps in the tally (opening balances optional)', () => {
    const s = dashboard.setupStatus();
    const optional = s.steps.find((x: any) => x.id === 'opening')!;
    expect(optional.optional).toBe(true);
    expect(s.total).toBe(s.steps.filter((x: any) => !x.optional).length);
  });
});
