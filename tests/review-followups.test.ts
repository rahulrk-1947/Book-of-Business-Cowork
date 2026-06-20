import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as settings from '../src/backend/services/settings';
import * as engine from '../src/backend/engine';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('review follow-ups', () => {
  let cust: number;
  beforeEach(() => { initDatabase(':memory:'); cust = contacts.save({ name: 'Acme', is_customer: true }).id; });

  it('a double-clicked approve cannot double-post (idempotent by status)', () => {
    const inv = invoices.saveDraft({ type: 'ACCREC', contact_id: cust, date: '2026-03-01', lines: [{ description: 'x', quantity: 1, unit_amount: 5000, account_id: acc('200'), tax_rate_id: 2 }] });
    invoices.approve(inv.id);
    expect(() => invoices.approve(inv.id)).toThrow(/cannot approve/i);
    // exactly one posted journal exists for the document
    const n = getDb().prepare("SELECT COUNT(*) AS n FROM journals WHERE source_type='INVOICE' AND source_id=? AND status='POSTED'").get(inv.id).n;
    expect(n).toBe(1);
  });

  it('manual journals can only balance in base cents (no cross-currency imbalance possible)', async () => {
    const journals = await import('../src/backend/services/journals');
    // unbalanced is rejected
    expect(() => { const id = journals.saveDraft({ narration: 'x', date: '2026-03-01', lines: [{ account_id: acc('200'), debit: 100 }, { account_id: acc('090'), credit: 50 }] }); journals.post(id); }).toThrow(/unbalanced|balance/i);
    // balanced posts fine
    const id = journals.saveDraft({ narration: 'ok', date: '2026-03-01', lines: [{ account_id: acc('200'), debit: 100 }, { account_id: acc('090'), credit: 100 }] });
    expect(() => journals.post(id)).not.toThrow();
  });

  it('schema enforces one-sided journal lines at the DB level', () => {
    // The CHECK constraint should reject a row that is both debit and credit,
    // even if a service somehow tried to write one.
    const db = getDb();
    const jid = Number(db.prepare("INSERT INTO journals (date, narration, status, source_type) VALUES ('2026-03-01','t','POSTED','MANUAL')").run().lastInsertRowid);
    expect(() => db.prepare('INSERT INTO journal_lines (journal_id, account_id, debit, credit) VALUES (?,?,?,?)').run(jid, acc('200'), 100, 100)).toThrow();
  });
});

describe('reverseJournal date surfacing', () => {
  it('notes the original locked date in the reversal narration when rescheduled', () => {
    initDatabase(':memory:');
    // Post a journal in March, then lock March and reverse it.
    const jid = engine.postJournal({ date: '2026-03-10', narration: 'orig', source_type: 'MANUAL', lines: [{ account_id: acc('200'), debit: 1000 }, { account_id: acc('090'), credit: 1000 }] });
    settings.setLockDate('2026-03-31', null);
    const rid = engine.reverseJournal(jid, {});
    const rev: any = getDb().prepare('SELECT date, narration FROM journals WHERE id = ?').get(rid);
    expect(rev.narration).toMatch(/locked period/i);
    expect(rev.narration).toContain('2026-03-10'); // original date surfaced
    expect(rev.date).not.toBe('2026-03-10');        // moved out of the locked period
  });
});
