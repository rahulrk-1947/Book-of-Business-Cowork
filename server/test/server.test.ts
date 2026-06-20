import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate each run on a throwaway data dir BEFORE the control module loads.
const dir = mkdtempSync(join(tmpdir(), 'bob-server-'));
process.env.DATA_DIR = dir;
process.env.NODE_ENV = 'test';

import { buildServer } from '../src/server';
import { initControl } from '../src/control';

let app: ReturnType<typeof buildServer>;

function cookieFrom(res: any): string {
  const raw = res.headers['set-cookie'];
  const arr = Array.isArray(raw) ? raw : [raw];
  const c = arr.find((x: string) => x?.startsWith('bob_session='));
  return c ? c.split(';')[0] : '';
}

beforeAll(async () => {
  initControl();
  app = buildServer();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function register(email: string, org: string) {
  const res = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { email, password: 'supersecret', full_name: email.split('@')[0], org_name: org },
  });
  return { body: res.json(), cookie: cookieFrom(res) };
}

const rpc = (cookie: string, tenantId: number, method: string, args: any[] = []) =>
  app.inject({ method: 'POST', url: '/api/rpc', headers: { cookie, 'x-tenant-id': String(tenantId) }, payload: { method, args } });

describe('server: auth & accounts', () => {
  it('registers a user with their first organisation and sets a session', async () => {
    const { body, cookie } = await register('owner@acme.test', 'Acme Books');
    expect(body.ok).toBe(true);
    expect(body.data.user.email).toBe('owner@acme.test');
    expect(body.data.tenant.id).toBeGreaterThan(0);
    expect(cookie).toContain('bob_session=');
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie } });
    expect(me.json().data.tenants[0].role).toBe('Adviser');
  });

  it('rejects duplicate email and wrong password', async () => {
    await register('dup@x.test', 'Dup Co');
    const again = await register('dup@x.test', 'Dup Co 2');
    expect(again.body.ok).toBe(false);
    const bad = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'dup@x.test', password: 'nope' } });
    expect(bad.statusCode).toBe(401);
  });

  it('blocks engine calls without a session', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/rpc', headers: { 'x-tenant-id': '1' }, payload: { method: 'contacts.list', args: [{}] } });
    expect(r.statusCode).toBe(401);
  });
});

describe('server: multi-tenant isolation', () => {
  it("keeps each org's books separate", async () => {
    const a = await register('a@iso.test', 'Org A');
    const b = await register('b@iso.test', 'Org B');
    const ta = a.body.data.tenant.id;
    const tb = b.body.data.tenant.id;

    // create a contact in Org A
    const made = await rpc(a.cookie, ta, 'contacts.save', [{ name: 'Only In A', is_customer: true }]);
    expect(made.json().ok).toBe(true);

    const listA = await rpc(a.cookie, ta, 'contacts.list', [{}]);
    const listB = await rpc(b.cookie, tb, 'contacts.list', [{}]);
    expect(listA.json().data.some((c: any) => c.name === 'Only In A')).toBe(true);
    expect(listB.json().data.some((c: any) => c.name === 'Only In A')).toBe(false);

    // user B cannot touch org A even by guessing its id
    const sneaky = await rpc(b.cookie, ta, 'contacts.list', [{}]);
    expect(sneaky.statusCode).toBe(403);
  });

  it('runs a real posting through the engine and keeps the ledger balanced', async () => {
    const a = await register('post@eng.test', 'Posting Co');
    const t = a.body.data.tenant.id;
    const accts = (await rpc(a.cookie, t, 'accounts.list', [{}])).json().data;
    const rev = accts.find((x: any) => x.code === '200').id;
    const cust = (await rpc(a.cookie, t, 'contacts.save', [{ name: 'Client', is_customer: true }])).json().data.id;
    const inv = (await rpc(a.cookie, t, 'invoices.saveDraft', [{
      type: 'ACCREC', contact_id: cust, date: '2026-03-01',
      lines: [{ description: 'Job', quantity: 1, unit_amount: 100000, account_id: rev, tax_rate_id: 2 }],
    }])).json().data;
    const approved = await rpc(a.cookie, t, 'invoices.approve', [inv.id]);
    expect(approved.json().ok).toBe(true);
    const tb = (await rpc(a.cookie, t, 'reports.trialBalance', [{ as_at: '2099-12-31' }])).json().data;
    expect(tb.total_debit).toBe(tb.total_credit);
    expect(tb.total_debit).toBeGreaterThan(0);
  });
});

describe('server: team invitations & role enforcement', () => {
  it('owner invites a Read-Only teammate who can read but not write', async () => {
    const owner = await register('boss@team.test', 'Team Co');
    const tId = owner.body.data.tenant.id;

    // invite a read-only teammate by email
    const inv = await app.inject({
      method: 'POST', url: `/api/orgs/${tId}/invites`,
      headers: { cookie: owner.cookie }, payload: { email: 'viewer@team.test', role: 'Read Only' },
    });
    expect(inv.json().ok).toBe(true);
    const token = inv.json().data.token;
    expect(inv.json().data.link).toContain('/invite/');

    // the invited person registers (same email) then accepts
    const viewer = await register('viewer@team.test', 'Viewer Personal Co');
    const accept = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, headers: { cookie: viewer.cookie } });
    expect(accept.json().ok).toBe(true);

    // viewer now sees Team Co among their orgs
    const me = await app.inject({ method: 'GET', url: '/api/me', headers: { cookie: viewer.cookie } });
    const membership = me.json().data.tenants.find((x: any) => x.id === tId);
    expect(membership.role).toBe('Read Only');

    // viewer can READ Team Co...
    const read = await rpc(viewer.cookie, tId, 'reports.trialBalance', [{ as_at: '2099-12-31' }]);
    expect(read.json().ok).toBe(true);
    // ...but cannot WRITE (engine permission gate enforced server-side)
    const write = await rpc(viewer.cookie, tId, 'contacts.save', [{ name: 'Should Fail', is_customer: true }]);
    expect(write.statusCode).toBe(400);
    expect(write.json().error).toMatch(/permission/i);
  });

  it('an invite for a different email cannot be accepted', async () => {
    const owner = await register('boss2@team.test', 'Team Two');
    const tId = owner.body.data.tenant.id;
    const inv = await app.inject({ method: 'POST', url: `/api/orgs/${tId}/invites`, headers: { cookie: owner.cookie }, payload: { email: 'intended@team.test', role: 'Standard' } });
    const token = inv.json().data.token;
    const wrongPerson = await register('someoneelse@team.test', 'Other Co');
    const accept = await app.inject({ method: 'POST', url: `/api/invites/${token}/accept`, headers: { cookie: wrongPerson.cookie } });
    expect(accept.statusCode).toBe(400);
    expect(accept.json().error).toMatch(/sent to/i);
  });

  it('non-owners cannot manage the team', async () => {
    const owner = await register('boss3@team.test', 'Team Three');
    const tId = owner.body.data.tenant.id;
    const invToken = (await app.inject({ method: 'POST', url: `/api/orgs/${tId}/invites`, headers: { cookie: owner.cookie }, payload: { email: 'std@team.test', role: 'Standard' } })).json().data.token;
    const member = await register('std@team.test', 'Std Personal');
    await app.inject({ method: 'POST', url: `/api/invites/${invToken}/accept`, headers: { cookie: member.cookie } });
    // the Standard member tries to invite someone — refused
    const attempt = await app.inject({ method: 'POST', url: `/api/orgs/${tId}/invites`, headers: { cookie: member.cookie }, payload: { email: 'x@team.test', role: 'Standard' } });
    expect(attempt.statusCode).toBe(403);
  });
});

describe('server: REST resources & docs', () => {
  it('exposes documented REST endpoints and an OpenAPI spec', async () => {
    const a = await register('rest@api.test', 'REST Co');
    const t = a.body.data.tenant.id;
    await rpc(a.cookie, t, 'contacts.save', [{ name: 'Rest Client', is_customer: true }]);
    const contacts = await app.inject({ method: 'GET', url: '/api/v1/contacts', headers: { cookie: a.cookie, 'x-tenant-id': String(t) } });
    expect(contacts.json().data.some((c: any) => c.name === 'Rest Client')).toBe(true);
    const tb = await app.inject({ method: 'GET', url: '/api/v1/reports/trial-balance', headers: { cookie: a.cookie, 'x-tenant-id': String(t) } });
    expect(tb.json().ok).toBe(true);
    const spec = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(spec.statusCode).toBe(200);
    expect(spec.json().info.title).toMatch(/Book of Business/);
  });
});

describe('server: idempotency & hardening', () => {
  it('an Idempotency-Key makes a retried RPC write run only once', async () => {
    const a = await register('idem@api.test', 'Idem Co');
    const t = a.body.data.tenant.id;
    const payload = { method: 'contacts.save', args: [{ name: 'Once Only', is_customer: true }], idempotency_key: 'srv-key-1' };
    const r1 = await app.inject({ method: 'POST', url: '/api/rpc', headers: { cookie: a.cookie, 'x-tenant-id': String(t) }, payload });
    const r2 = await app.inject({ method: 'POST', url: '/api/rpc', headers: { cookie: a.cookie, 'x-tenant-id': String(t) }, payload });
    expect(r1.json().data.id).toBe(r2.json().data.id); // same record returned
    const list = await app.inject({ method: 'POST', url: '/api/rpc', headers: { cookie: a.cookie, 'x-tenant-id': String(t) }, payload: { method: 'contacts.list', args: [{}] } });
    expect(list.json().data.filter((c: any) => c.name === 'Once Only')).toHaveLength(1);
  });

  it('locks out repeated failed logins', async () => {
    await register('lockme@api.test', 'Lock Co');
    let last: any;
    for (let i = 0; i < 6; i++) {
      last = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'lockme@api.test', password: 'wrong-password' } });
    }
    expect(last.statusCode).toBe(429); // too many attempts
  });
});
