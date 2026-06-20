import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as invoices from '../src/backend/services/invoices';
import * as reports from '../src/backend/services/reports';
import { seedClientSample, SAMPLE_PROFILES } from '../src/backend/seed/clientSample';

describe.each(SAMPLE_PROFILES.map((p) => [p.org, p] as const))('sample books: %s', (_org, profile) => {
  beforeEach(() => initDatabase(':memory:'));

  it('seeds 50+ transactions and the ledger holds every invariant', () => {
    const r = seedClientSample(profile);
    expect(r.transactions).toBeGreaterThanOrEqual(50);

    const db = getDb();
    const n = (sql: string) => db.prepare(sql).get().n as number;
    expect(n("SELECT COUNT(*) AS n FROM invoices WHERE type='ACCREC' AND status!='DELETED'")).toBe(16);
    expect(n("SELECT COUNT(*) AS n FROM invoices WHERE type='ACCRECCREDIT'")).toBe(1);
    expect(n("SELECT COUNT(*) AS n FROM invoices WHERE type='ACCREC' AND status='PAID'")).toBe(7);  // 7 settled in full
    expect(n("SELECT COUNT(*) AS n FROM invoices WHERE type='ACCREC' AND status='AUTHORISED'")).toBeGreaterThanOrEqual(9); // rest still open (2 part-paid)
    expect(n("SELECT COUNT(*) AS n FROM invoices WHERE type='ACCPAY'")).toBe(10);
    expect(n('SELECT COUNT(*) AS n FROM payments')).toBe(13);
    expect(n('SELECT COUNT(*) AS n FROM bank_transactions')).toBe(8);
    expect(n('SELECT COUNT(*) AS n FROM manual_journals')).toBe(4);

    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);

    const today = new Date().toISOString().slice(0, 10);
    const yearAgo = new Date(Date.now() - 200 * 86400000).toISOString().slice(0, 10);
    const accrual = reports.profitAndLoss({ from: yearAgo, to: today });
    const cash = reports.profitAndLoss({ from: yearAgo, to: today, basis: 'CASH' });
    expect(accrual.total_income).toBeGreaterThan(0);
    expect(cash.total_income).toBeGreaterThan(0);
    expect(cash.total_income).toBeLessThan(accrual.total_income); // unpaid invoices excluded on cash

    const aged = reports.agedReceivables({ as_at: today });
    expect(aged.contacts.length).toBeGreaterThan(0);

    // tracking really applied
    expect(n('SELECT COUNT(*) AS n FROM invoice_lines WHERE tracking_option_1 IS NOT NULL')).toBeGreaterThan(15);
  });

  it('is deterministic: same profile, same books', () => {
    seedClientSample(profile);
    const a = getDb().prepare('SELECT SUM(total) AS n FROM invoices').get().n;
    initDatabase(':memory:');
    seedClientSample(profile);
    const b = getDb().prepare('SELECT SUM(total) AS n FROM invoices').get().n;
    expect(a).toBe(b);
  });
});
