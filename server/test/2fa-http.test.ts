import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'bob-2fahttp-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';
process.env.COOKIE_SECRET = 'test-secret-please-change-1234567890';

import { buildServer } from '../src/server';
import { initControl } from '../src/control';
import { totp } from '../src/totp';

let app: ReturnType<typeof buildServer>;
beforeAll(async () => { initControl(); app = buildServer(); await app.ready(); });
afterAll(async () => { await app.close(); rmSync(dir, { recursive: true, force: true }); });

const cookieFrom = (res: any) => { const raw = res.headers['set-cookie']; const arr = Array.isArray(raw) ? raw : [raw]; const c = arr.find((x: string) => x?.startsWith('bob_session=')); return c ? c.split(';')[0] : ''; };

describe('2FA over HTTP', () => {
  it('signup → enable 2FA → login requires the code', async () => {
    // sign up
    const signup = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'http2fa@test.com', full_name: 'H', password: 'password123', org_name: 'Org' } });
    expect(signup.statusCode).toBe(200);
    const cookie = cookieFrom(signup);

    // setup 2FA
    const setup = await app.inject({ method: 'POST', url: '/api/auth/2fa/setup', headers: { cookie } });
    expect(setup.statusCode).toBe(200);
    const secret = setup.json().data.secret as string;
    expect(secret).toBeTruthy();

    // confirm
    const confirm = await app.inject({ method: 'POST', url: '/api/auth/2fa/confirm', headers: { cookie }, payload: { code: totp(secret) } });
    expect(confirm.statusCode).toBe(200);

    // login without code → 401 with totp_required
    const noCode = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'http2fa@test.com', password: 'password123' } });
    expect(noCode.statusCode).toBe(401);
    expect(noCode.json().totp_required).toBe(true);

    // login with code → success
    const withCode = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'http2fa@test.com', password: 'password123', code: totp(secret) } });
    expect(withCode.statusCode).toBe(200);
    expect(withCode.json().ok).toBe(true);
  });
});
