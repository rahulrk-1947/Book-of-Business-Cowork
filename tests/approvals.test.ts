import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as approvals from '../src/backend/services/approvals';

const acc = (c: string) => (getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c) as any).id as number;
let supplier: number;
beforeEach(() => {
  initDatabase(':memory:');
  supplier = contacts.save({ name: 'Big Supplier', is_supplier: true }).id;
});

function bill(total_cents: number) {
  return invoices.saveDraft({ type: 'ACCPAY', contact_id: supplier, date: '2026-05-01', lines: [{ description: 'svc', quantity: 1, unit_amount: total_cents, account_id: acc('400') }] });
}

describe('approval workflows', () => {
  it('leaves posting unchanged when no rules are configured', () => {
    const b = bill(900000);
    expect(() => invoices.approve(b.id)).not.toThrow();
    expect(invoices.get(b.id).status).toBe('AUTHORISED');
  });

  it('blocks posting a bill that needs approval until it is approved', () => {
    approvals.saveRule({ doc_type: 'ACCPAY', min_amount: 500000 }); // ≥ $5,000
    const b = bill(800000);
    expect(approvals.state(b.id).requires).toBe(true);
    expect(() => invoices.approve(b.id)).toThrow(/needs approval/i);
    expect(invoices.get(b.id).status).toBe('DRAFT');

    const ap = approvals.submit(b.id);
    expect(ap.status).toBe('PENDING');
    expect(invoices.get(b.id).status).toBe('SUBMITTED');
    expect(approvals.pendingCount()).toBe(1);

    approvals.approve(b.id, 'ok by me');
    expect(invoices.get(b.id).status).toBe('AUTHORISED');
    expect(approvals.approvalFor('ACCPAY', b.id).status).toBe('APPROVED');
    expect(approvals.pendingCount()).toBe(0);
  });

  it('does not gate bills below the threshold', () => {
    approvals.saveRule({ doc_type: 'ACCPAY', min_amount: 500000 });
    const b = bill(100000);
    expect(approvals.state(b.id).requires).toBe(false);
    expect(() => invoices.approve(b.id)).not.toThrow();
    expect(invoices.get(b.id).status).toBe('AUTHORISED');
  });

  it('rejecting sends the document back to draft', () => {
    approvals.saveRule({ doc_type: 'ACCPAY', min_amount: 0 }); // everything needs approval
    const b = bill(20000);
    approvals.submit(b.id);
    approvals.reject(b.id, 'missing PO');
    expect(invoices.get(b.id).status).toBe('DRAFT');
    expect(approvals.approvalFor('ACCPAY', b.id).status).toBe('REJECTED');
  });

  it('rejects approve/submit when there is no pending request', () => {
    approvals.saveRule({ doc_type: 'ACCPAY', min_amount: 0 });
    const b = bill(20000);
    expect(() => approvals.approve(b.id)).toThrow(/no pending approval/i);
  });

  it('supports invoices as well as bills', () => {
    approvals.saveRule({ doc_type: 'ACCREC', min_amount: 0 });
    const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: supplier, date: '2026-05-01', lines: [{ description: 'x', quantity: 1, unit_amount: 100000, account_id: acc('200') }] });
    expect(approvals.state(inv.id).requires).toBe(true);
    approvals.submit(inv.id);
    approvals.approve(inv.id);
    expect(invoices.get(inv.id).status).toBe('AUTHORISED');
  });
});
