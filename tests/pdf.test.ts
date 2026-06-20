import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as settings from '../src/backend/services/settings';
import { renderDocumentHtml } from '../src/ui/pages/DocumentEditor';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('branded document PDF', () => {
  let cust: number;
  beforeEach(() => {
    initDatabase(':memory:');
    cust = contacts.save({
      name: 'Pioneer Hardware', email: 'ap@pioneer.test', is_customer: true,
      addresses: [{ type: 'BILLING', line1: '12 Trade St', city: 'Auckland', postcode: '1010', country: 'NZ' }],
    }).id;
    settings.updateOrganisation({
      trading_name: 'Acme Tools Ltd', tax_number: 'GST123',
      address_line1: '99 Main Rd', address_city: 'Wellington', contact_email: 'hi@acme.test',
      contact_phone: '021 555 0000', website: 'acme.test', invoice_footer: 'Thanks for your business!',
      logo_data: 'data:image/png;base64,iVBORw0KGgoAAAANS',
    });
  });

  function html() {
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cust, date: '2026-06-19', due_date: '2026-06-26', reference: 'PO-5',
      lines: [{ description: 'Wholesale order', quantity: 2, unit_amount: 76250, account_id: acc('200'), tax_rate_id: 2 }],
    });
    invoices.approve(inv.id);
    const doc = invoices.get(inv.id);
    const org = settings.getOrganisation();
    return renderDocumentHtml(doc, org, 'Invoice');
  }

  it('includes the business name, logo, address and footer', () => {
    const h = html();
    expect(h).toContain('Acme Tools Ltd');
    expect(h).toContain('data:image/png;base64'); // logo embedded
    expect(h).toContain('99 Main Rd');
    expect(h).toContain('hi@acme.test');
    expect(h).toContain('Thanks for your business!');
    expect(h).toContain('GST123');
  });

  it('shows the recipient with their billing address', () => {
    const h = html();
    expect(h).toContain('Bill to');
    expect(h).toContain('Pioneer Hardware');
    expect(h).toContain('12 Trade St');
    expect(h).toContain('Auckland');
  });

  it('lists the line with its account and the totals', () => {
    const h = html();
    expect(h).toContain('Wholesale order');
    expect(h).toContain('200 Sales');     // account column
    expect(h).toContain('Invoice');       // doc label/title
  });

  it('escapes HTML in user content (no injection)', () => {
    const evil = contacts.save({ name: '<script>x</script>Bad Co', is_customer: true }).id;
    const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: evil, date: '2026-06-19', lines: [{ description: '<b>boom</b>', quantity: 1, unit_amount: 100, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(inv.id);
    const h = renderDocumentHtml(invoices.get(inv.id), settings.getOrganisation(), 'Invoice');
    expect(h).not.toContain('<script>x</script>');
    expect(h).toContain('&lt;script&gt;');
    expect(h).toContain('&lt;b&gt;boom');
  });

  it('renders cleanly when branding fields are empty (new book)', () => {
    initDatabase(':memory:');
    const c = contacts.save({ name: 'Plain Co', is_customer: true }).id;
    const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: c, date: '2026-06-19', lines: [{ description: 'x', quantity: 1, unit_amount: 1000, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(inv.id);
    const h = renderDocumentHtml(invoices.get(inv.id), settings.getOrganisation(), 'Invoice');
    expect(h).toContain('Plain Co');
    expect(h).not.toContain('undefined');
    expect(h).not.toContain('null');
  });
});
