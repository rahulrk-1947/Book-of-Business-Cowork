/**
 * Validation audit — one place that exercises every guard in the app, so a
 * future change can't quietly remove one. Grouped by the surface it protects.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as journals from '../src/backend/services/journals';
import * as banking from '../src/backend/services/banking';
import * as payments from '../src/backend/services/payments';
import * as accounts from '../src/backend/services/accounts';
import * as settings from '../src/backend/services/settings';
import * as recurring from '../src/backend/services/recurring';
import * as attachments from '../src/backend/services/attachments';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;
let cust: number, supp: number;
const b64 = (s: string) => Buffer.from(s).toString('base64');

beforeEach(() => {
  initDatabase(':memory:');
  cust = contacts.save({ name: 'Customer Co', is_customer: true }).id;
  supp = contacts.save({ name: 'Supplier Co', is_supplier: true }).id;
});

const recLine = (over: any = {}) => ({ description: 'x', quantity: 1, unit_amount: 1000, account_id: acc('200'), tax_rate_id: 2, ...over });

describe('VALIDATION: dates', () => {
  it('rejects impossible dates on invoices, journals, transfers, payments, bank txns', () => {
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-02-30', lines: [recLine()] })).toThrow(/calendar date/i);
    expect(() => journals.saveDraft({ narration: 'x', date: '2026-13-01', lines: [{ account_id: acc('200'), debit: 100 }, { account_id: acc('090'), credit: 100 }] })).toThrow(/month|calendar/i);
    expect(() => banking.createTransfer({ date: '2026-02-30', from_account_id: acc('090'), to_account_id: acc('091'), amount: 1000 })).toThrow(/calendar date/i);
    expect(() => banking.createBankTransaction({ type: 'SPEND', bank_account_id: acc('090'), date: '2026-02-30', lines: [recLine({ account_id: acc('453') })] } as any)).toThrow(/calendar date/i);
    const inv = approvedInvoice();
    expect(() => payments.create({ type: 'RECEIVE', date: '2026-02-30', bank_account_id: acc('090'), amount: 1000, allocations: [{ invoice_id: inv, amount: 1000 }] })).toThrow(/calendar date/i);
  });

  it('rejects out-of-range years', () => {
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '1899-01-01', lines: [recLine()] })).toThrow(/year|calendar/i);
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '275760-02-30', lines: [recLine()] })).toThrow(/calendar date|year/i);
  });
});

describe('VALIDATION: locked periods', () => {
  function lockAt(date: string) { settings.setLockDate(date, null); }

  it('blocks posting, approving, and voiding inside a locked period', () => {
    const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-01-10', lines: [recLine()] });
    lockAt('2026-01-31');
    expect(() => invoices.approve(inv.id)).toThrow(/locked/i);
    // a brand-new journal in the locked window
    expect(() => { const id = journals.saveDraft({ narration: 'x', date: '2026-01-15', lines: [{ account_id: acc('200'), debit: 100 }, { account_id: acc('090'), credit: 100 }] }); journals.post(id); }).toThrow(/locked/i);
  });

  it('blocks voiding an approved invoice dated in a locked period', () => {
    const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-03-10', lines: [recLine()] });
    invoices.approve(inv.id);
    settings.setLockDate('2026-03-31', null);
    expect(() => invoices.voidDoc(inv.id)).toThrow(/locked/i);
  });

  it('blocks removing a payment dated in a locked period', () => {
    const inv = approvedInvoice('2026-03-01');
    const pid = payments.create({ type: 'RECEIVE', date: '2026-03-05', bank_account_id: acc('090'), amount: 5000, allocations: [{ invoice_id: inv, amount: 5000 }] });
    settings.setLockDate('2026-03-31', null);
    expect(() => payments.remove(typeof pid === 'object' ? (pid as any).id ?? pid : pid)).toThrow(/locked/i);
  });
});

describe('VALIDATION: quantities & amounts', () => {
  it('rejects zero/negative quantities on documents and bank transactions', () => {
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-03-01', lines: [recLine({ quantity: 0 })] })).toThrow(/quantity/i);
    expect(() => banking.createBankTransaction({ type: 'SPEND', bank_account_id: acc('090'), date: '2026-03-01', lines: [recLine({ account_id: acc('453'), quantity: 0 })] } as any)).toThrow(/quantity/i);
  });

  it('rejects non-positive payment amounts and transfer amounts', () => {
    const inv = approvedInvoice();
    expect(() => payments.create({ type: 'RECEIVE', date: '2026-03-01', bank_account_id: acc('090'), amount: 0, allocations: [{ invoice_id: inv, amount: 0 }] })).toThrow(/greater than zero|amount/i);
    expect(() => banking.createTransfer({ date: '2026-03-01', from_account_id: acc('090'), to_account_id: acc('091'), amount: 0 })).toThrow(/greater than zero/i);
  });

  it('rejects a payment allocation exceeding the amount due', () => {
    const inv = approvedInvoice(); // 5000
    expect(() => payments.create({ type: 'RECEIVE', date: '2026-03-01', bank_account_id: acc('090'), amount: 9999, allocations: [{ invoice_id: inv, amount: 9999 }] })).toThrow(/exceeds|sum/i);
  });
});

describe('VALIDATION: bank transfers', () => {
  it('requires two different real bank accounts', () => {
    expect(() => banking.createTransfer({ date: '2026-03-01', from_account_id: acc('090'), to_account_id: acc('090'), amount: 1000 })).toThrow(/different/i);
    expect(() => banking.createTransfer({ date: '2026-03-01', from_account_id: acc('090'), to_account_id: acc('200'), amount: 1000 })).toThrow(/bank account/i);
  });
});

describe('VALIDATION: control accounts', () => {
  it('blocks a control account on an invoice line and a bank-transaction line', () => {
    const ar = acc('AR' in {} ? '610' : '610'); void ar;
    const arId = getDb().prepare("SELECT id FROM accounts WHERE system_account = 'AR'").get().id as number;
    expect(() => invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-03-01', lines: [recLine({ account_id: arId })] })).toThrow(/control account|automatically/i);
    expect(() => banking.createBankTransaction({ type: 'SPEND', bank_account_id: acc('090'), date: '2026-03-01', lines: [recLine({ account_id: arId })] } as any)).toThrow(/control account|automatically/i);
  });
});

describe('VALIDATION: name uniqueness', () => {
  it('rejects duplicate contact, account, and tax-rate names', () => {
    expect(() => contacts.save({ name: 'Customer Co', is_customer: true })).toThrow(/named|unique|exists/i);
    expect(() => accounts.create({ code: '200', name: 'Whatever', type: 'REVENUE' })).toThrow(/code|exists/i);
    const existingTax = getDb().prepare('SELECT name FROM tax_rates LIMIT 1').get().name;
    expect(() => settings.saveTaxRate({ name: existingTax, tax_type: 'SALES', components: [{ name: 'X', percent: 5 }] } as any)).toThrow(/named|exists/i);
  });
});

describe('VALIDATION: balanced journals', () => {
  it('rejects an unbalanced manual journal', () => {
    expect(() => { const id = journals.saveDraft({ narration: 'x', date: '2026-03-01', lines: [{ account_id: acc('200'), debit: 100 }, { account_id: acc('090'), credit: 50 }] }); journals.post(id); }).toThrow(/unbalanced|balance/i);
  });
  it('rejects a line that is both debit and credit', () => {
    expect(() => { const id = journals.saveDraft({ narration: 'x', date: '2026-03-01', lines: [{ account_id: acc('200'), debit: 100, credit: 100 } as any, { account_id: acc('090'), credit: 100 }] }); journals.post(id); }).toThrow(/both|debit/i);
  });
});

describe('VALIDATION: file uploads', () => {
  it('rejects unsupported types and oversize files, accepts good ones', () => {
    const inv = approvedInvoice();
    expect(() => attachments.add({ entity_type: 'invoice', entity_id: inv, filename: 'x.exe', data_base64: b64('hi') })).toThrow(/supported file type/i);
    expect(() => attachments.add({ entity_type: 'invoice', entity_id: inv, filename: 'big.pdf', data_base64: 'A'.repeat(4.2 * 1024 * 1024) })).toThrow(/3 MB|MB/i);
    expect(() => attachments.add({ entity_type: 'invoice', entity_id: inv, filename: 'ok.pdf', data_base64: b64('hi') })).not.toThrow();
  });
});

describe('VALIDATION: recurring schedules', () => {
  it('rejects bad name, dates, frequency, interval and quantities', () => {
    expect(() => recurring.save({ name: '', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', start_date: '2026-01-01', lines: [recLine()] } as any)).toThrow(/name/i);
    expect(() => recurring.save({ name: 'x', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', start_date: '2026-02-30', lines: [recLine()] })).toThrow(/calendar date/i);
    expect(() => recurring.save({ name: 'x', type: 'ACCREC', contact_id: cust, frequency: 'DAILY' as any, start_date: '2026-01-01', lines: [recLine()] })).toThrow(/frequency/i);
    expect(() => recurring.save({ name: 'x', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', every_n: 0, start_date: '2026-01-01', lines: [recLine()] })).toThrow(/interval/i);
    expect(() => recurring.save({ name: 'x', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', start_date: '2026-01-01', lines: [recLine({ quantity: 0 })] })).toThrow(/quantity/i);
    expect(() => recurring.save({ name: 'x', type: 'ACCREC', contact_id: cust, frequency: 'MONTHLY', start_date: '2026-06-01', end_date: '2026-01-01', lines: [recLine()] })).toThrow(/end date/i);
  });
});

// helper: create an approved $50 invoice (amount_due 5000) for payment tests
function approvedInvoice(date = '2026-03-01'): number {
  const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date, lines: [{ description: 'x', quantity: 1, unit_amount: 5000, account_id: acc('200'), tax_rate_id: 2 }] });
  invoices.approve(inv.id);
  return inv.id;
}
