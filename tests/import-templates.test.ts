import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/backend/db';
import * as banking from '../src/backend/services/banking';
import * as imports from '../src/backend/services/imports';

beforeEach(() => initDatabase(':memory:'));

describe('import templates', () => {
  it('bank statement (Amount) template parses with correct money-in/out signs', () => {
    const rows = banking.parseCsv(banking.statementTemplate());
    expect(rows.length).toBe(3);
    expect(rows[0].amount).toBeGreaterThan(0); // money in
    expect(rows[1].amount).toBeLessThan(0);    // money out
    expect(rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('bank statement (Debit/Credit) template parses with correct signs', () => {
    const rows = banking.parseCsv(banking.statementTemplateDebitCredit());
    expect(rows.length).toBe(3);
    expect(rows[0].amount).toBeGreaterThan(0); // credit = money in
    expect(rows[1].amount).toBeLessThan(0);    // debit = money out
  });

  it('document and journal templates are non-empty with a header row', () => {
    expect(imports.documentTemplate('ACCREC').split('\n')[0]).toContain('ContactName');
    expect(imports.documentTemplate('ACCPAY').split('\n').length).toBeGreaterThan(1);
    expect(imports.journalTemplate().split('\n')[0]).toContain('Narration');
  });

  it('the document template actually imports cleanly (dry run, no errors)', () => {
    const csv = imports.documentTemplate('ACCREC');
    const r = imports.importDocuments({ type: 'ACCREC', csv, dry_run: true });
    expect(r.errors?.length ?? 0).toBe(0);
  });
});
