import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as ec from '../src/backend/services/expenseclaims';
import * as reports from '../src/backend/services/reports';

const acc = (c: string) => getDb().prepare('SELECT id FROM accounts WHERE code = ?').get(c).id as number;
const sys = (s: string) => getDb().prepare('SELECT id FROM accounts WHERE system_account = ? LIMIT 1').get(s).id as number;
const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account=1 LIMIT 1').get().id as number;
const bal = (id: number, asof = '2099-01-01') => {
  const r: any = getDb().prepare("SELECT COALESCE(SUM(jl.debit-jl.credit),0) d, COALESCE(SUM(jl.credit-jl.debit),0) c FROM journal_lines jl JOIN journals j ON j.id=jl.journal_id WHERE jl.account_id=? AND j.status='POSTED' AND j.date<=?").get(id, asof);
  return r;
};
beforeEach(() => { initDatabase(':memory:'); });

describe('expense claims', () => {
  it('approving posts net to the expense account, input tax to GST, and credits the liability', () => {
    const r = ec.create({ date: '2026-06-05', reference: 'T1', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), description: 'Lunch', unit_amount: 11000, tax_rate_id: 4 }] });
    expect(bal(acc('400')).d).toBe(10000);             // net
    expect(bal(sys('GST')).d).toBe(1000);              // recoverable input tax (debit)
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(11000);  // liability owed to claimant
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('handles tax-exclusive claims (amount is net, tax added on top)', () => {
    ec.create({ date: '2026-06-05', line_amount_type: 'EXCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 10000, tax_rate_id: 4 }] });
    expect(bal(acc('400')).d).toBe(10000);
    expect(bal(sys('GST')).d).toBe(1000);
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(11000);
  });

  it('handles a no-tax claim', () => {
    ec.create({ date: '2026-06-05', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 5000, tax_rate_id: 2 }] });
    expect(bal(acc('400')).d).toBe(5000);
    expect(bal(sys('GST')).d).toBe(0);
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(5000);
  });

  it('reimbursing relieves the liability, pays the bank, and marks the claim PAID', () => {
    const r = ec.create({ date: '2026-06-05', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 11000, tax_rate_id: 4 }] });
    ec.reimburse({ claim_id: r.id, bank_account_id: bankId(), date: '2026-06-10' });
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(0);      // liability cleared
    expect(bal(bankId()).c).toBe(11000);               // cash out
    expect(ec.get(r.id).status).toBe('PAID');
    expect(ec.outstanding().total).toBe(0);
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('outstanding reflects approved-but-unpaid claims only', () => {
    ec.create({ date: '2026-06-05', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 8000, tax_rate_id: 2 }] });
    const paid = ec.create({ date: '2026-06-06', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 3000, tax_rate_id: 2 }] });
    expect(ec.outstanding().total).toBe(11000);
    ec.reimburse({ claim_id: paid.id, bank_account_id: bankId() });
    expect(ec.outstanding().total).toBe(8000);
  });

  it('a draft can be edited but an approved claim cannot', () => {
    const { id } = ec.save({ date: '2026-06-05', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 5000, tax_rate_id: 2 }] });
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(0); // nothing posted while draft
    ec.save({ id, date: '2026-06-05', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 7000, tax_rate_id: 2 }] }); // edit ok
    ec.approve(id);
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(7000);
    expect(() => ec.save({ id, date: '2026-06-05', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 9000, tax_rate_id: 2 }] })).toThrow(/no longer be edited|approved/i);
  });

  it('voiding an approved (unpaid) claim reverses the posting', () => {
    const r = ec.create({ date: '2026-06-05', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 6600, tax_rate_id: 4 }] });
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(6600);
    ec.voidClaim(r.id);
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(0);
    expect(bal(acc('400')).d).toBe(0);
    expect(ec.get(r.id).status).toBe('DECLINED');
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('voiding a PAID claim reverses both the claim and the reimbursement', () => {
    const r = ec.create({ date: '2026-06-05', line_amount_type: 'INCLUSIVE', lines: [{ account_id: acc('400'), unit_amount: 11000, tax_rate_id: 4 }] });
    ec.reimburse({ claim_id: r.id, bank_account_id: bankId(), date: '2026-06-10' });
    ec.voidClaim(r.id);
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(0);
    expect(bal(bankId()).c).toBe(0); // bank movement reversed
    expect(bal(acc('400')).d).toBe(0);
    expect(reports.integrityCheck().ok).toBe(true);
  });

  it('a multi-line claim sums correctly and lists with a claimant', () => {
    const r = ec.create({ date: '2026-06-05', reference: 'TRIP', line_amount_type: 'INCLUSIVE', lines: [
      { account_id: acc('400'), description: 'Taxi', unit_amount: 2200, tax_rate_id: 4 },
      { account_id: acc('400'), description: 'Hotel', unit_amount: 16500, tax_rate_id: 4 },
    ] });
    const claim = ec.get(r.id);
    expect(claim.total).toBe(18700);
    expect(claim.lines).toHaveLength(2);
    expect(bal(sys('EXPENSE_CLAIMS')).c).toBe(18700);
    const listed = ec.list().find((c: any) => c.id === r.id);
    expect(listed.claimant).toBeTruthy();
    expect(listed.status).toBe('APPROVED');
  });

  it('validates inputs and state transitions', () => {
    expect(() => ec.save({ date: '2026-06-05', lines: [] })).toThrow(/at least one/i);
    expect(() => ec.save({ date: 'not-a-date', lines: [{ account_id: acc('400'), unit_amount: 1000 }] })).toThrow();
    const { id } = ec.save({ date: '2026-06-05', lines: [{ account_id: acc('400'), unit_amount: 1000, tax_rate_id: 2 }] });
    expect(() => ec.reimburse({ claim_id: id, bank_account_id: bankId() })).toThrow(/approved/i); // can't pay a draft
    ec.remove(id); // draft delete ok
    expect(ec.list().find((c: any) => c.id === id)).toBeUndefined();
  });
});
