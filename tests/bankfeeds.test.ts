import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase, getDb } from '../src/backend/db';
import * as bankfeeds from '../src/backend/services/bankfeeds';
import * as banking from '../src/backend/services/banking';

const bankId = () => getDb().prepare('SELECT id FROM accounts WHERE is_bank_account = 1 LIMIT 1').get().id as number;
beforeEach(() => initDatabase(':memory:'));

describe('bank feeds', () => {
  it('lists the sandbox provider (flagged not live)', () => {
    const ps = bankfeeds.availableProviders();
    const sb = ps.find((p) => p.key === 'SANDBOX')!;
    expect(sb.live).toBe(false);
  });

  it('connects a feed to a bank account', () => {
    const f = bankfeeds.connect({ bank_account_id: bankId(), provider: 'SANDBOX' });
    expect(f.status).toBe('ACTIVE');
    expect(f.connection_ref).toBeTruthy();
    expect(bankfeeds.list()).toHaveLength(1);
  });

  it('refuses a non-bank account and a duplicate active feed', () => {
    const rev = getDb().prepare("SELECT id FROM accounts WHERE code='200'").get().id as number;
    expect(() => bankfeeds.connect({ bank_account_id: rev, provider: 'SANDBOX' })).toThrow(/bank account/i);
    const b = bankId();
    bankfeeds.connect({ bank_account_id: b, provider: 'SANDBOX' });
    expect(() => bankfeeds.connect({ bank_account_id: b, provider: 'SANDBOX' })).toThrow(/already has an active feed/i);
  });

  it('syncs transactions into the statement-line pipeline, then de-duplicates on re-sync', () => {
    const b = bankId();
    const f = bankfeeds.connect({ bank_account_id: b, provider: 'SANDBOX' });
    const r1 = bankfeeds.sync(f.id);
    expect(r1.imported).toBeGreaterThan(0);
    expect(r1.duplicates).toBe(0);
    expect(banking.unreconciled(b).length).toBe(r1.imported);
    const r2 = bankfeeds.sync(f.id);
    expect(r2.imported).toBe(0);
    expect(r2.duplicates).toBe(r1.imported); // same lines skipped
    expect(banking.unreconciled(b).length).toBe(r1.imported); // no new lines
  });

  it('records last_refresh_at after a sync', () => {
    const f = bankfeeds.connect({ bank_account_id: bankId(), provider: 'SANDBOX' });
    expect(bankfeeds.get(f.id).last_refresh_at).toBeFalsy();
    bankfeeds.sync(f.id);
    expect(bankfeeds.get(f.id).last_refresh_at).toBeTruthy();
  });

  it('disconnect stops further syncing', () => {
    const f = bankfeeds.connect({ bank_account_id: bankId(), provider: 'SANDBOX' });
    bankfeeds.disconnect(f.id);
    expect(() => bankfeeds.sync(f.id)).toThrow(/not active/i);
  });

  it('imported feed lines are real statement lines that can be reconciled', () => {
    const b = bankId();
    const f = bankfeeds.connect({ bank_account_id: b, provider: 'SANDBOX' });
    bankfeeds.sync(f.id);
    const lines = banking.unreconciled(b);
    expect(lines[0]).toHaveProperty('amount');
    expect(lines[0]).toHaveProperty('date');
  });
});
