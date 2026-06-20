import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import { postJournal, reverseJournal, PostingError } from '../src/backend/engine';
import { roundCents, lineNet, toBase } from '../src/backend/money';
import { calcLine, calcDocument } from '../src/backend/tax';
import * as settings from '../src/backend/services/settings';

function freshDb() {
  initDatabase(':memory:');
}

describe('money', () => {
  it('rounds half away from zero', () => {
    expect(roundCents(0.5)).toBe(1);
    expect(roundCents(-0.5)).toBe(-1);
    expect(roundCents(2.4)).toBe(2);
    expect(roundCents(2.5)).toBe(3);
  });
  it('computes line net with discount', () => {
    expect(lineNet(3, 1000, 10)).toBe(2700); // 3 × $10 − 10%
    expect(lineNet(0.5, 999, 0)).toBe(500); // rounded
  });
  it('converts to base at rate', () => {
    expect(toBase(10000, 1.08)).toBe(10800);
    expect(toBase(33333, 1.1)).toBe(36666); // 36666.3 → 36666
  });
});

describe('tax maths (spec §5.3)', () => {
  const gst10 = [{ percent: 10, is_compound: 0 as const }];
  it('exclusive: tax added on top', () => {
    const l = calcLine({ quantity: 1, unit_amount: 10000, components: gst10 }, 'EXCLUSIVE');
    expect(l.net).toBe(10000);
    expect(l.tax).toBe(1000);
    expect(l.gross).toBe(11000);
  });
  it('inclusive: tax backed out', () => {
    const l = calcLine({ quantity: 1, unit_amount: 11000, components: gst10 }, 'INCLUSIVE');
    expect(l.net).toBe(10000);
    expect(l.tax).toBe(1000);
    expect(l.gross).toBe(11000);
  });
  it('no tax', () => {
    const l = calcLine({ quantity: 2, unit_amount: 5000, components: gst10 }, 'NOTAX');
    expect(l.net).toBe(10000);
    expect(l.tax).toBe(0);
  });
  it('compound components stack', () => {
    // 5% + 7% compound: 5 then 7% on (100+5)
    const comps = [
      { percent: 5, is_compound: 0 as const },
      { percent: 7, is_compound: 1 as const },
    ];
    const l = calcLine({ quantity: 1, unit_amount: 10000, components: comps }, 'EXCLUSIVE');
    expect(l.tax).toBe(500 + Math.round(10500 * 0.07)); // 500 + 735
  });
  it('rounds per line then sums', () => {
    const doc = calcDocument(
      [
        { quantity: 1, unit_amount: 333, components: gst10 }, // tax 33.3 → 33
        { quantity: 1, unit_amount: 333, components: gst10 },
        { quantity: 1, unit_amount: 334, components: gst10 }, // tax 33.4 → 33
      ],
      'EXCLUSIVE'
    );
    expect(doc.subtotal).toBe(1000);
    expect(doc.total_tax).toBe(99); // 33+33+33, NOT round(100)
    expect(doc.total).toBe(1099);
  });
});

describe('journal engine', () => {
  beforeEach(freshDb);

  it('rejects unbalanced journals', () => {
    expect(() =>
      postJournal({
        date: '2026-01-15',
        source_type: 'MANUAL',
        lines: [
          { account_id: 1, debit: 100 },
          { account_id: 2, credit: 99 },
        ],
      })
    ).toThrow(PostingError);
  });

  it('rejects lines that are both debit and credit, or neither', () => {
    expect(() =>
      postJournal({ date: '2026-01-15', source_type: 'MANUAL', lines: [{ account_id: 1, debit: 5, credit: 5 }, { account_id: 2 }] })
    ).toThrow();
    expect(() =>
      postJournal({ date: '2026-01-15', source_type: 'MANUAL', lines: [{ account_id: 1 }, { account_id: 2 }] })
    ).toThrow();
  });

  it('posts a balanced journal and reverses it exactly', () => {
    const jid = postJournal({
      date: '2026-01-15',
      source_type: 'MANUAL',
      lines: [
        { account_id: 1, debit: 12345 },
        { account_id: 2, credit: 12345 },
      ],
    });
    expect(jid).toBeGreaterThan(0);
    const rid = reverseJournal(jid);
    const lines = getDb().prepare('SELECT * FROM journal_lines WHERE journal_id = ?').all(rid);
    expect(lines[0].credit).toBe(12345);
    expect(lines[1].debit).toBe(12345);
  });

  it('blocks postings into a locked period', () => {
    settings.setLockDate('2026-01-31', null);
    expect(() =>
      postJournal({
        date: '2026-01-15',
        source_type: 'MANUAL',
        lines: [
          { account_id: 1, debit: 100 },
          { account_id: 2, credit: 100 },
        ],
      })
    ).toThrow(/locked/i);
    // After the lock date is fine
    expect(
      postJournal({
        date: '2026-02-01',
        source_type: 'MANUAL',
        lines: [
          { account_id: 1, debit: 100 },
          { account_id: 2, credit: 100 },
        ],
      })
    ).toBeGreaterThan(0);
  });
});
