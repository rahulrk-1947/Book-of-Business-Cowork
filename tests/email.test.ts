import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as settings from '../src/backend/services/settings';
import * as email from '../src/backend/services/email';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
let cust: number;
beforeEach(() => {
  initDatabase(':memory:');
  settings.updateOrganisation({ trading_name: 'Acme Tools', invoice_footer: 'Pay within 14 days.' });
  cust = contacts.save({ name: 'Pioneer Hardware', email: 'ap@pioneer.test', is_customer: true }).id;
});

function invoice() {
  const i = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-06-01', due_date: '2026-06-15', lines: [{ description: 'x', quantity: 1, unit_amount: 150000, account_id: acc('200'), tax_rate_id: 2 }] });
  invoices.approve(i.id);
  return i.id;
}

describe('email compose', () => {
  it('fills placeholders from the document and organisation', () => {
    const c = email.compose('ACCREC', invoice());
    expect(c.to).toBe('ap@pioneer.test');
    expect(c.subject).toContain('Acme Tools');
    expect(c.subject).toMatch(/INV-/);
    expect(c.body).toContain('Pioneer Hardware');
    expect(c.body).toContain('$1,500.00');
    expect(c.has_recipient).toBe(true);
    expect(c.filename).toMatch(/INV-.*\.pdf/);
  });

  it('produces real newlines (not literal backslash-n)', () => {
    const c = email.compose('ACCREC', invoice());
    expect(c.body).toContain('\n');
    expect(c.body).not.toContain('\\n');
  });

  it('flags a missing recipient when the contact has no email', () => {
    const noEmail = contacts.save({ name: 'No Email Co', is_customer: true }).id;
    const i = invoices.saveDraft({ type: 'ACCREC', contact_id: noEmail, date: '2026-06-01', lines: [{ description: 'x', quantity: 1, unit_amount: 1000, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(i.id);
    const c = email.compose('ACCREC', i.id);
    expect(c.to).toBe('');
    expect(c.has_recipient).toBe(false);
  });

  it('uses a customised template after saving one', () => {
    email.saveTemplate({ doc_type: 'ACCREC', subject: 'Your bill {number}', body: 'Hello {contact}, you owe {amount_due}.' });
    const c = email.compose('ACCREC', invoice());
    expect(c.subject).toMatch(/^Your bill INV-/);
    expect(c.body).toMatch(/^Hello Pioneer Hardware, you owe \$1,500\.00\.$/);
  });

  it('reset restores the default template', () => {
    email.saveTemplate({ doc_type: 'ACCREC', subject: 'Custom', body: 'Custom body' });
    expect(email.getTemplate('ACCREC').is_default).toBe(false);
    email.resetTemplate('ACCREC');
    expect(email.getTemplate('ACCREC').is_default).toBe(true);
  });

  it('rejects empty subject/body', () => {
    expect(() => email.saveTemplate({ doc_type: 'PO', subject: '', body: 'x' })).toThrow(/subject/i);
    expect(() => email.saveTemplate({ doc_type: 'PO', subject: 'x', body: '  ' })).toThrow(/body/i);
  });

  it('lists a template for every document type', () => {
    const list = email.listTemplates();
    const types = list.map((t: any) => t.doc_type);
    expect(types).toEqual(expect.arrayContaining(['ACCREC', 'ACCPAY', 'QUOTE', 'PO']));
    expect(list.every((t: any) => t.subject && t.body)).toBe(true);
  });
});
