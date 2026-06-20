import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import * as invoices from '../src/backend/services/invoices';
import * as journals from '../src/backend/services/journals';
import * as banking from '../src/backend/services/banking';
import * as reports from '../src/backend/services/reports';
import * as settings from '../src/backend/services/settings';
import * as fr from '../src/backend/services/find_recode';
import { create as paymentsCreate } from '../src/backend/services/payments';

const acc = (code: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(code).id as number;

describe('find & recode', () => {
  let cid: number;
  beforeEach(() => {
    initDatabase(':memory:');
    cid = contacts.save({ name: 'Recode Customer', is_customer: true, is_supplier: true }).id;
  });

  function makeInvoice(amount = 100000, date = '2026-03-10') {
    const inv = invoices.saveDraft({
      type: 'ACCREC', contact_id: cid, date,
      lines: [{ description: 'Job', quantity: 1, unit_amount: amount, account_id: acc('200'), tax_rate_id: 3 }],
    });
    invoices.approve(inv.id);
    return invoices.get(inv.id);
  }

  it('searches lines with all/any semantics across fields', () => {
    makeInvoice(100000, '2026-03-10');
    makeInvoice(50000, '2026-04-10');
    banking.createBankTransaction({
      type: 'SPEND', bank_account_id: acc('090'), contact_id: cid, date: '2026-03-15', line_amount_type: 'NOTAX',
      lines: [{ description: 'Hosting', quantity: 1, unit_amount: 9000, account_id: acc('477'), tax_rate_id: 2 }],
    });
    const byAccount = fr.search({ match: 'all', conds: [{ field: 'account', op: 'in', values: [acc('200')] }] });
    expect(byAccount.total).toBe(2);
    const andDate = fr.search({
      match: 'all',
      conds: [{ field: 'account', op: 'in', values: [acc('200')] }, { field: 'date', from: '2026-04-01' }],
    });
    expect(andDate.total).toBe(1);
    const anyOf = fr.search({
      match: 'any',
      conds: [{ field: 'account', op: 'in', values: [acc('477')] }, { field: 'date', from: '2026-04-01', to: '2026-04-30' }],
    });
    expect(anyOf.total).toBe(2); // the bank line OR the April invoice line
    expect(anyOf.transactions).toBe(2);
  });

  it('recodes the account on a PAID invoice: ledger moves, money untouched', () => {
    const inv = makeInvoice();
    paymentsCreate({
      type: 'RECEIVE', date: '2026-03-20', bank_account_id: acc('090'), contact_id: cid,
      amount: inv.total, allocations: [{ invoice_id: inv.id, amount: inv.total }],
    });
    const paid = invoices.get(inv.id);
    expect(paid.status).toBe('PAID');

    const hit = fr.search({ match: 'all', conds: [{ field: 'account', op: 'in', values: [acc('200')] }] }).lines[0];
    const r = fr.recode({ targets: [hit], changes: { account_id: acc('260') } });
    expect(r.done).toBe(1);
    expect(r.skipped).toBe(0);

    const after = invoices.get(inv.id);
    expect(after.total).toBe(paid.total);           // money unchanged
    expect(after.amount_due).toBe(0);               // payment intact
    const gl = (account: number) => getDb().prepare(
      `SELECT COALESCE(SUM(jl.credit - jl.debit),0) AS v FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id
       WHERE jl.account_id = ? AND j.status='POSTED'`
    ).get(account).v;
    expect(gl(acc('260'))).toBe(100000);            // revenue now sits on the new account
    expect(gl(acc('200'))).toBe(0);
    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
  });

  it('tax recode: allowed and recomputed when unpaid, skipped with reason when paid', () => {
    const open = makeInvoice(100000, '2026-05-05');           // 10% tax → total 110000
    const paid = makeInvoice(100000, '2026-05-06');
    paymentsCreate({
      type: 'RECEIVE', date: '2026-05-10', bank_account_id: acc('090'), contact_id: cid,
      amount: paid.total, allocations: [{ invoice_id: paid.id, amount: paid.total }],
    });
    const lines = fr.search({ match: 'all', conds: [{ field: 'account', op: 'in', values: [acc('200')] }] }).lines;
    const openLine = lines.find((l) => l.doc_id === open.id)!;
    const paidLine = lines.find((l) => l.doc_id === paid.id)!;
    const r = fr.recode({ targets: [openLine, paidLine], changes: { tax_rate_id: 2 } }); // → No Tax
    expect(r.done).toBe(1);
    expect(r.skipped).toBe(1);
    expect(r.results.find((x) => x.status === 'SKIPPED')!.reason).toMatch(/payments/i);
    const reOpen = invoices.get(open.id);
    expect(reOpen.total).toBe(100000);              // tax removed, totals recomputed
    expect(reOpen.total_tax).toBe(0);
    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
    expect(fr.history()[0].items_done).toBe(1);
    expect(fr.history()[0].items_skipped).toBe(1);
  });

  it('bank transaction recode moves the expense, never the bank movement', () => {
    const t = banking.createBankTransaction({
      type: 'SPEND', bank_account_id: acc('090'), contact_id: cid, date: '2026-03-15', line_amount_type: 'NOTAX',
      lines: [{ description: 'Hosting', quantity: 1, unit_amount: 9000, account_id: acc('477'), tax_rate_id: 2 }],
    });
    const bankBefore = getDb().prepare(
      `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS v FROM journal_lines jl WHERE jl.account_id = ?`
    ).get(acc('090')).v;
    const line = fr.search({ match: 'all', conds: [{ field: 'account', op: 'in', values: [acc('477')] }] }).lines[0];
    const r = fr.recode({ targets: [line], changes: { account_id: acc('453'), tracking_option_1: null } });
    expect(r.done).toBe(1);
    const bankAfter = getDb().prepare(
      `SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS v FROM journal_lines jl WHERE jl.account_id = ?`
    ).get(acc('090')).v;
    expect(bankAfter).toBe(bankBefore);
    expect(getDb().prepare('SELECT account_id FROM bank_transaction_lines WHERE id = ?').get(line.line_id).account_id).toBe(acc('453'));
    void t;
  });

  it('manual journals recode; auto-reversing ones are skipped', () => {
    const ok = journals.saveDraft({
      narration: 'Plain accrual', date: '2026-03-28',
      lines: [{ account_id: acc('477'), debit: 7000 }, { account_id: acc('825'), credit: 7000 }],
    });
    journals.post(ok);
    const rev = journals.saveDraft({
      narration: 'Reversing accrual', date: '2026-03-28', auto_reversing_date: '2026-04-01',
      lines: [{ account_id: acc('477'), debit: 5000 }, { account_id: acc('825'), credit: 5000 }],
    });
    journals.post(rev);
    const lines = fr.search({ match: 'all', conds: [{ field: 'account', op: 'in', values: [acc('477')] }] }).lines;
    const r = fr.recode({ targets: lines, changes: { account_id: acc('453') } });
    expect(r.done).toBe(1);
    expect(r.skipped).toBeGreaterThanOrEqual(1);
    expect(r.results.find((x) => x.status === 'SKIPPED')!.reason).toMatch(/auto-reversal/i);
    const tb = reports.trialBalance({ as_at: '2099-12-31' });
    expect(tb.total_debit).toBe(tb.total_credit);
  });

  it('contact recode flows through to the rebuilt journal lines', () => {
    const other = contacts.save({ name: 'New Owner Co', is_customer: true }).id;
    const inv = makeInvoice();
    const line = fr.search({ match: 'all', conds: [{ field: 'contact', op: 'in', values: [cid] }] }).lines.find((l) => l.doc_id === inv.id)!;
    const r = fr.recode({ targets: [line], changes: { contact_id: other } });
    expect(r.done).toBe(1);
    expect(invoices.get(inv.id).contact_id).toBe(other);
    const jc = getDb().prepare(
      `SELECT DISTINCT jl.contact_id FROM journal_lines jl JOIN journals j ON j.id = jl.journal_id
       WHERE j.source_type='INVOICE' AND j.source_id=? AND jl.contact_id IS NOT NULL`
    ).all(inv.id);
    expect(jc).toEqual([{ contact_id: other }]);
  });
});
