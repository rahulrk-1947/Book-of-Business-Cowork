import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'bob-pwd-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

import {
  initControl, createUser, login, findUserByEmail,
  changePassword, setPassword, setPasswordByEmail, resetMemberPassword,
  createTenant, membership, ctl,
} from '../src/control';

beforeAll(() => { initControl(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('password management (control)', () => {
  it('change-your-own-password requires the correct current password', () => {
    const u: any = createUser('owner1@test.com', 'Owner', 'originalpass');
    expect(() => changePassword(u.id, 'wrongpass', 'newpassword1')).toThrow(/current password is incorrect/i);
    expect(() => changePassword(u.id, 'short', 'newpassword1')).toThrow(/incorrect/i);
    // correct current, but too-short new
    expect(() => changePassword(u.id, 'originalpass', 'short')).toThrow(/at least 8/i);
    // works
    changePassword(u.id, 'originalpass', 'brandnewpass');
    expect(() => login('owner1@test.com', 'brandnewpass')).not.toThrow();
    expect(() => login('owner1@test.com', 'originalpass')).toThrow(/wrong email or password/i);
  });

  it('break-glass setPasswordByEmail resets any account and clears sessions', () => {
    const u: any = createUser('locked@test.com', 'Locked Out', 'forgotten1');
    const before = findUserByEmail('locked@test.com') as any;
    const sess = login('locked@test.com', 'forgotten1'); // create a session
    expect(sess.token).toBeTruthy();
    const r = setPasswordByEmail('locked@test.com', 'recovered123');
    expect(r.ok).toBe(true);
    const after = findUserByEmail('locked@test.com') as any;
    expect(after.password_hash).not.toBe(before.password_hash);
    expect(() => login('locked@test.com', 'recovered123')).not.toThrow();
  });

  it('break-glass on an unknown email fails clearly', () => {
    expect(() => setPasswordByEmail('nobody@test.com', 'whatever1')).toThrow(/no account found/i);
  });

  it('setPassword enforces a minimum length', () => {
    const u: any = createUser('shorty@test.com', 'Shorty', 'validpass1');
    expect(() => setPassword(u.id, 'abc')).toThrow(/at least 8/i);
  });

  it('admin can reset a member, but a non-admin cannot', () => {
    const owner: any = createUser('boss@test.com', 'Boss', 'ownerpass1');
    const member: any = createUser('staff@test.com', 'Staff', 'staffpass1');
    const tenant: any = createTenant('Acme Ltd', owner.id);
    // add member as Standard (direct insert, the way accepting an invite does)
    ctl().prepare('INSERT INTO memberships (user_id, tenant_id, role, is_owner) VALUES (?, ?, ?, 0)').run(member.id, tenant.id, 'Standard');

    // owner resets the member's password
    expect(() => resetMemberPassword(tenant.id, owner.id, member.id, 'resetbyowner1')).not.toThrow();
    expect(() => login('staff@test.com', 'resetbyowner1')).not.toThrow();

    // the member (non-admin) cannot reset the owner
    expect(() => resetMemberPassword(tenant.id, member.id, owner.id, 'sneaky12345')).toThrow(/owner or adviser/i);
  });

  it('cannot reset someone who is not a member of the organisation', () => {
    const owner: any = createUser('boss2@test.com', 'Boss2', 'ownerpass2');
    const stranger: any = createUser('stranger@test.com', 'Stranger', 'strangerpass');
    const tenant: any = createTenant('Beta Ltd', owner.id);
    expect(() => resetMemberPassword(tenant.id, owner.id, stranger.id, 'nope12345')).toThrow(/not a member/i);
  });
});
