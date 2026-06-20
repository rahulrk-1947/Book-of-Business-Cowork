import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'bob-2fa-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

import { initControl, createUser, login, beginTotpEnrollment, confirmTotpEnrollment, disableTotp, totpStatus } from '../src/control';
import { totp, verifyTotp, base32Encode, base32Decode } from '../src/totp';

beforeAll(() => { initControl(); });
afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

describe('TOTP primitive', () => {
  it('matches RFC 6238 test vectors (SHA1, 8 digits)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(totp(secret, 59 * 1000, 30, 8)).toBe('94287082');
    expect(totp(secret, 1111111109 * 1000, 30, 8)).toBe('07081804');
    expect(totp(secret, 1234567890 * 1000, 30, 8)).toBe('89005924');
  });
  it('base32 round-trips', () => {
    expect(base32Decode(base32Encode(Buffer.from('hello world'))).toString()).toBe('hello world');
  });
  it('accepts codes within the skew window and rejects others', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    const now = Date.now();
    expect(verifyTotp(secret, totp(secret, now), now)).toBe(true);
    expect(verifyTotp(secret, totp(secret, now), now + 30000)).toBe(true);  // +1 step
    expect(verifyTotp(secret, totp(secret, now), now + 120000)).toBe(false); // too far
    expect(verifyTotp(secret, '000000', now)).toBe(false);
  });
});

describe('2FA enrolment + login enforcement', () => {
  it('enrols, enforces a code at login, then disables', () => {
    const u: any = createUser('2fa@test.com', 'TwoFA', 'password123');
    expect(totpStatus(u.id).enabled).toBe(false);
    // login works without a code while 2FA is off
    expect(() => login('2fa@test.com', 'password123')).not.toThrow();

    // begin enrolment → get a secret
    const { secret, otpauth_url } = beginTotpEnrollment(u.id);
    expect(secret).toBeTruthy();
    expect(otpauth_url).toContain('otpauth://totp/');
    expect(otpauth_url).toContain('secret=' + secret);
    // not enabled until confirmed
    expect(totpStatus(u.id).enabled).toBe(false);
    expect(() => login('2fa@test.com', 'password123')).not.toThrow();

    // confirm with a wrong code fails
    expect(() => confirmTotpEnrollment(u.id, '000000')).toThrow(/didn.t match|code/i);
    // confirm with the real code enables it
    confirmTotpEnrollment(u.id, totp(secret));
    expect(totpStatus(u.id).enabled).toBe(true);

    // now login without a code is rejected with the 2FA_REQUIRED signal
    try { login('2fa@test.com', 'password123'); throw new Error('should have required 2FA'); }
    catch (e: any) { expect(e.code).toBe('2FA_REQUIRED'); }
    // wrong code rejected
    expect(() => login('2fa@test.com', 'password123', '000000')).toThrow(/invalid authentication code/i);
    // correct code succeeds
    expect(() => login('2fa@test.com', 'password123', totp(secret))).not.toThrow();

    // wrong password is still wrong even with a valid code
    expect(() => login('2fa@test.com', 'wrongpass', totp(secret))).toThrow(/wrong email or password/i);

    // disable requires a valid code
    expect(() => disableTotp(u.id, '000000')).toThrow(/invalid/i);
    disableTotp(u.id, totp(secret));
    expect(totpStatus(u.id).enabled).toBe(false);
    // login without a code works again
    expect(() => login('2fa@test.com', 'password123')).not.toThrow();
  });

  it('confirm before setup is rejected', () => {
    const u: any = createUser('nosetup@test.com', 'NoSetup', 'password123');
    expect(() => confirmTotpEnrollment(u.id, '123456')).toThrow(/start two-factor setup/i);
  });
});
