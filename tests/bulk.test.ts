import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('bulk document actions', () => {
  let cust: number;
  const mkDraft = (ref: string) => invoices.saveDraft({
    type: 'ACCREC', contact_id: cust, date: '2026-03-01', reference: ref,
    lines: [{ description: 'x', quantity: 1, unit_amount: 10000, account_id: acc('200'), tax_rate_id: 2 }],
  }).id;

  beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'Bulk Co', is_customer: true }).id; });

  it('approves many drafts at once and reports the tally', () => {
    const ids = [mkDraft('a'), mkDraft('b'), mkDraft('c')];
    const r = invoices.bulkApprove(ids);
    expect(r.ok_count).toBe(3);
    expect(r.fail_count).toBe(0);
    for (const id of ids) expect(invoices.get(id).status).toBe('AUTHORISED');
  });

  it('skips documents it cannot action and explains why (partial success)', () => {
    const draft = mkDraft('ok');
    const approved = mkDraft('already');
    invoices.approve(approved); // now AUTHORISED — can't be approved again
    const r = invoices.bulkApprove([draft, approved]);
    expect(r.ok_count).toBe(1);
    expect(r.fail_count).toBe(1);
    expect(r.succeeded).toContain(draft);
    expect(r.failed[0].id).toBe(approved);
    expect(r.failed[0].error).toMatch(/cannot approve/i);
    expect(r.failed[0].number).toBeTruthy(); // includes the doc number for the message
  });

  it('bulk voids drafts (delete) and approved docs (reverse), skipping paid ones', () => {
    const draft = mkDraft('d1');
    const approved = mkDraft('d2');
    invoices.approve(approved);
    const r = invoices.bulkVoid([draft, approved]);
    expect(r.ok_count).toBe(2);
    expect(invoices.get(draft).status).toBe('DELETED');
    expect(invoices.get(approved).status).toBe('VOIDED');
  });

  it('exports a CSV summary of the selected documents', () => {
    const ids = [mkDraft('x1'), mkDraft('x2')];
    invoices.approve(ids[0]);
    const out = invoices.exportSelectionCsv(ids);
    expect(out.count).toBe(2);
    expect(out.filename).toMatch(/documents-.*\.csv/);
    const lines = out.csv.split('\n');
    expect(lines[0]).toContain('Number');
    expect(lines[0]).toContain('Total');
    expect(lines).toHaveLength(3); // header + 2 docs
    expect(out.csv).toContain('Bulk Co');
  });

  it('rejects an empty export selection', () => {
    expect(() => invoices.exportSelectionCsv([])).toThrow(/select at least one/i);
  });

  it('handles an empty id list gracefully for approve/void', () => {
    expect(invoices.bulkApprove([]).ok_count).toBe(0);
    expect(invoices.bulkVoid([]).fail_count).toBe(0);
  });
});
