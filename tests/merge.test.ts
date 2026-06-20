import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as journals from '../src/backend/services/journals';
import * as banking from '../src/backend/services/banking';
import * as reports from '../src/backend/services/reports';
import { create as paymentsCreate } from '../src/backend/services/payments';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('contact merge & unmerge', () => {
  let dupA: number; // will be merged away
  let keep: number; // survivor
  beforeEach(() => {
    initDatabase(':memory:');
    dupA = contacts.save({ name: 'Acme Co', is_customer: true, is_supplier: true }).id;
    keep = contacts.save({ name: 'Acme Company Ltd', is_customer: true, is_supplier: true }).id;
  });

  function billAndSale(contactId: number) {
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: contactId, date: '2026-03-10',
      lines: [{ description: 'Job', quantity: 1, unit_amount: 50000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(inv.id);
    paymentsCreate({
      type: 'RECEIVE', date: '2026-03-20', bank_account_id: acc('090'), contact_id: contactId,
      amount: 25000, allocations: [{ invoice_id: inv.id, amount: 25000 }],
    });
    banking.createBankTransaction({
      type: 'SPEND', bank_account_id: acc('090'), contact_id: contactId, date: '2026-03-15', line_amount_type: 'NOTAX',
      lines: [{ description: 'Stuff', quantity: 1, unit_amount: 3000, account_id: acc('453'), tax_rate_id: 2 }],
    });
    return inv.id;
  }

  it('moves every reference, archives the duplicate, keeps the ledger balanced', () => {
    const invA = billAndSale(dupA);
    billAndSale(keep);
    const before = reports.trialBalance({ as_at: '2099-12-31' });

    const preview = contacts.mergePreview(dupA, keep);
    expect(preview.total).toBeGreaterThanOrEqual(3); // invoice + payment + bank txn (+ journal lines)
    expect(preview.counts.invoices).toBe(1);

    const r = contacts.merge(dupA, keep);
    expect(r.moved).toBe(preview.total);

    // duplicate archived + renamed; nothing left pointing at it
    const arch = contacts.get(dupA);
    expect(arch.status).toBe('ARCHIVED');
    expect(arch.name).toMatch(/\(merged\)$/);
    for (const t of ['invoices', 'payments', 'bank_transactions', 'journal_lines']) {
      expect(getDb().prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE contact_id = ?`).get(dupA).n).toBe(0);
    }
    expect(invoices.get(invA).contact_id).toBe(keep);

    // survivor now shows both sets of activity
    const act = contacts.activity(keep);
    expect(act.rows.filter((x: any) => x.kind === 'ACCREC').length).toBe(2);

    const after = reports.trialBalance({ as_at: '2099-12-31' });
    expect(after.total_debit).toBe(after.total_credit);
    expect(after.total_debit).toBe(before.total_debit); // merge moves names, not money
  });

  it('unmerge restores the archived contact, its name, and exactly its transactions', () => {
    const invA = billAndSale(dupA);
    const invKeepOwn = billAndSale(keep);
    const r = contacts.merge(dupA, keep);
    const mergeId = r.merge_id;

    // Add NEW activity to the survivor after the merge — must NOT travel back
    const post = invoices.saveDraft({
      type: 'ACCREC', contact_id: keep, date: '2026-04-01',
      lines: [{ description: 'Later', quantity: 1, unit_amount: 9000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(post.id);

    const hist = contacts.mergeHistory();
    expect(hist[0].id).toBe(mergeId);
    expect(hist[0].from_status).toBe('ARCHIVED');

    const u = contacts.unmerge(mergeId);
    expect(u.restored).toBeGreaterThanOrEqual(3);

    // archived one is back, active, original name
    const back = contacts.get(dupA);
    expect(back.status).toBe('ACTIVE');
    expect(back.name).toBe('Acme Co');

    // its original transactions returned…
    expect(invoices.get(invA).contact_id).toBe(dupA);
    // …survivor keeps its own and the post-merge one
    expect(invoices.get(invKeepOwn).contact_id).toBe(keep);
    expect(invoices.get(post.id).contact_id).toBe(keep);

    // history shows it undone; can't undo twice
    expect(contacts.mergeHistory().find((m: any) => m.id === mergeId)).toBeUndefined();
    expect(() => contacts.unmerge(mergeId)).toThrow(/already been undone|not found/i);

    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
  });

  it('refuses silly merges', () => {
    expect(() => contacts.merge(keep, keep)).toThrow(/different/i);
    contacts.archive(dupA);
    expect(() => contacts.merge(dupA, keep)).toThrow(/active/i);
  });
});

describe('merge name choice', () => {
  beforeEach(() => initDatabase(':memory:'));
  it('adopts the duplicate name on the survivor when chosen, and unmerge stays consistent', () => {
    const dup = contacts.save({ name: 'Bright Spark', is_customer: true }).id;
    const keep = contacts.save({ name: 'Bright Spark Electrical', is_customer: true }).id;
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: dup, date: '2026-03-01',
      lines: [{ description: 'X', quantity: 1, unit_amount: 10000, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(inv.id);
    const r = contacts.merge(dup, keep, 1, 'Bright Spark'); // keep the duplicate's shorter name
    expect(contacts.get(keep).name).toBe('Bright Spark');
    expect(contacts.get(dup).name).toMatch(/\(merged\)$/);
    // unmerge: survivor still named 'Bright Spark', so the restored one is kept distinct
    contacts.unmerge(r.merge_id);
    expect(contacts.get(keep).name).toBe('Bright Spark');
    expect(contacts.get(dup).name).toBe('Bright Spark (unmerged)');
    expect(contacts.get(dup).status).toBe('ACTIVE');
    expect(invoices.get(inv.id).contact_id).toBe(dup);
  });
});
