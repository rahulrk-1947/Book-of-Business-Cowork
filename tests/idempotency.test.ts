import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as engine from '../src/backend/engine';
import { call, isMutating } from '../src/backend/registry';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;
let cust: number;
beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'Idem Co', is_customer: true }).id; });

const docArgs = (ref: string) => ({
  type: 'ACCREC', contact_id: cust, date: '2026-03-01', reference: ref,
  lines: [{ description: 'x', quantity: 1, unit_amount: 5000, account_id: acc('200'), tax_rate_id: 2 }],
});

describe('postJournal idempotency', () => {
  it('returns the original journal on a repeat with the same key (no double post)', () => {
    const lines = [{ account_id: acc('200'), debit: 1000 }, { account_id: acc('090'), credit: 1000 }];
    const j1 = engine.postJournal({ date: '2026-03-01', narration: 'x', source_type: 'MANUAL', lines, idempotency_key: 'k-123' });
    const j2 = engine.postJournal({ date: '2026-03-01', narration: 'x', source_type: 'MANUAL', lines, idempotency_key: 'k-123' });
    expect(j2).toBe(j1); // same journal id returned
    const n = getDb().prepare('SELECT COUNT(*) AS n FROM journals').get().n;
    expect(n).toBe(1); // only one journal actually posted
  });

  it('still posts distinct journals for different keys', () => {
    const lines = [{ account_id: acc('200'), debit: 1000 }, { account_id: acc('090'), credit: 1000 }];
    const j1 = engine.postJournal({ date: '2026-03-01', source_type: 'MANUAL', lines, idempotency_key: 'a' });
    const j2 = engine.postJournal({ date: '2026-03-01', source_type: 'MANUAL', lines, idempotency_key: 'b' });
    expect(j2).not.toBe(j1);
  });
});

describe('registry operation idempotency', () => {
  it('replays the stored result instead of running a mutating call twice', () => {
    const r1: any = call('invoices.saveDraft', [docArgs('once')], { idempotencyKey: 'op-1' });
    const r2: any = call('invoices.saveDraft', [docArgs('once')], { idempotencyKey: 'op-1' });
    expect(r2.id).toBe(r1.id); // same document returned
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM invoices WHERE status != 'DELETED'").get().n;
    expect(n).toBe(1); // only ONE invoice created (no duplicate subledger record)
  });

  it('prevents a double-submitted payment from creating two records', () => {
    // approve an invoice to pay
    const inv: any = call('invoices.saveDraft', [docArgs('pay')]);
    call('invoices.approve', [inv.id]);
    const payArgs = { type: 'RECEIVE', date: '2026-03-02', bank_account_id: acc('090'), amount: 5000, allocations: [{ invoice_id: inv.id, amount: 5000 }] };
    call('payments.create', [payArgs], { idempotencyKey: 'pay-1' });
    call('payments.create', [payArgs], { idempotencyKey: 'pay-1' }); // retry
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM payments WHERE status='POSTED'").get().n;
    expect(n).toBe(1);
  });

  it('different keys run independently', () => {
    call('invoices.saveDraft', [docArgs('one')], { idempotencyKey: 'x1' });
    call('invoices.saveDraft', [docArgs('two')], { idempotencyKey: 'x2' });
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM invoices WHERE status != 'DELETED'").get().n;
    expect(n).toBe(2);
  });

  it('does not dedupe reads, and no-key calls behave as before', () => {
    const a: any = call('invoices.saveDraft', [docArgs('nokey')]);
    const b: any = call('invoices.saveDraft', [docArgs('nokey')]); // no key → runs again
    expect(b.id).not.toBe(a.id);
    // a read with a key is not stored/replayed
    const list1 = call('invoices.list', [{ type: 'ACCREC' }], { idempotencyKey: 'read-1' });
    expect(Array.isArray(list1)).toBe(true);
  });

  it('classifies mutating vs read methods correctly', () => {
    expect(isMutating('invoices.saveDraft')).toBe(true);
    expect(isMutating('invoices.approve')).toBe(true);
    expect(isMutating('payments.create')).toBe(true);
    expect(isMutating('banking.createTransfer')).toBe(true);
    expect(isMutating('invoices.bulkVoid')).toBe(true);
    expect(isMutating('invoices.list')).toBe(false);
    expect(isMutating('invoices.get')).toBe(false);
    expect(isMutating('reports.profitAndLoss')).toBe(false);
  });
});
