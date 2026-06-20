/**
 * Book of Business — server edition.
 *
 * Exposes the existing accounting engine over HTTP with real accounts,
 * password login, multi-tenant isolation and team invitations. The single
 * generic RPC endpoint instantly surfaces the whole engine (the web/desktop
 * UI can point straight at it); the hand-written REST resources are a clean,
 * documented surface for outside integrations. Everything is described in
 * OpenAPI at /docs.
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import fstatic from '@fastify/static';
import { join } from 'node:path';
import { existsSync, createReadStream } from 'node:fs';
import { openTenantDb } from './tenant';
import {
  initControl, createUser, login, userForToken, endSession, startSession,
  createTenant, tenantsForUser, membership, tenantMembers, setMemberRole, removeMember,
  createInvite, listInvites, revokeInvite, inviteByToken, acceptInvite, getTenant,
  changePassword, resetMemberPassword,
  beginTotpEnrollment, confirmTotpEnrollment, disableTotp, totpStatus,
} from './control';
import { runInTenant } from './tenant';

const COOKIE = 'bob_session';
const isProd = process.env.NODE_ENV === 'production';

export function buildServer() {
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  // The cookie secret signs session cookies. In production it MUST be set
  // explicitly — refuse to boot with the dev fallback so a misconfigured deploy
  // fails loudly instead of running with a guessable secret.
  const cookieSecret = process.env.COOKIE_SECRET;
  if (!cookieSecret && process.env.NODE_ENV === 'production') {
    throw new Error('COOKIE_SECRET must be set in production (it signs session cookies).');
  }
  app.register(cookie, { secret: cookieSecret || 'dev-only-secret-change-me' });

  app.register(swagger, {
    openapi: {
      info: { title: 'Book of Business API', version: '1.0.0', description: 'Multi-tenant double-entry accounting API.' },
      components: {
        securitySchemes: { cookieAuth: { type: 'apiKey', in: 'cookie', name: COOKIE } },
      },
    },
  });
  app.register(swaggerUi, { routePrefix: '/docs' });

  // ── Auth helpers ───────────────────────────────────────────────────────────
  function currentUser(req: any): any {
    return userForToken(req.cookies?.[COOKIE]);
  }
  function setSessionCookie(reply: any, token: string) {
    reply.setCookie(COOKIE, token, {
      // 'strict' (was 'lax') so the session cookie isn't sent on cross-site
      // top-level navigations — closes the CSRF / backup-exfiltration surface
      // on state-changing POSTs and the GET backup endpoint.
      httpOnly: true, sameSite: 'strict', secure: isProd, path: '/', maxAge: 60 * 60 * 24 * 30,
    });
  }
  /** Resolve the acting membership for a tenant the user actually belongs to. */
  function requireTenant(req: any, reply: any): { user: any; tenant: any; role: string } | null {
    const user = currentUser(req);
    if (!user) { reply.code(401).send({ ok: false, error: 'Please log in' }); return null; }
    const tenantId = Number(req.headers['x-tenant-id'] || req.query?.tenant_id || 0);
    if (!tenantId) { reply.code(400).send({ ok: false, error: 'No organisation selected' }); return null; }
    const m = membership(user.id, tenantId);
    if (!m) { reply.code(403).send({ ok: false, error: "You don't have access to that organisation" }); return null; }
    const tenant: any = getTenant(tenantId);
    return { user, tenant, role: m.role };
  }
  const acting = (user: any, role: string) => ({ email: user.email, fullName: user.full_name, role });

  // ── Health ───────────────────────────────────────────────────────────────
  app.get('/healthz', async () => ({ ok: true, ts: new Date().toISOString() }));

  // ── Account & session ──────────────────────────────────────────────────────
  app.post('/api/auth/register', {
    schema: {
      tags: ['auth'], summary: 'Create an account and a first organisation',
      body: { type: 'object', required: ['email', 'password', 'full_name', 'org_name'],
        properties: { email: { type: 'string' }, password: { type: 'string' }, full_name: { type: 'string' }, org_name: { type: 'string' } } },
    },
  }, async (req: any, reply) => {
    try {
      const { email, password, full_name, org_name } = req.body;
      const user: any = createUser(email, full_name, password);
      const tenant: any = createTenant(org_name, user.id);
      const { token } = startSession(user.id);
      setSessionCookie(reply, token);
      return { ok: true, data: { user, tenant } };
    } catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  // ── Login throttling ────────────────────────────────────────────────────
  // Simple in-memory backoff: after several failed attempts for an
  // email+IP pair, lock that pair out for a cooldown. Deters password
  // guessing without a database or external service.
  const MAX_ATTEMPTS = 5;
  const LOCKOUT_MS = 15 * 60 * 1000;
  const attempts = new Map<string, { count: number; first: number; lockedUntil?: number }>();
  function throttleKey(req: any): string {
    const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.ip || 'unknown').trim();
    return `${String(req.body?.email ?? '').toLowerCase()}|${ip}`;
  }
  function checkLockout(key: string): number | null {
    const rec = attempts.get(key);
    if (rec?.lockedUntil && rec.lockedUntil > Date.now()) return Math.ceil((rec.lockedUntil - Date.now()) / 60000);
    return null;
  }
  function recordFailure(key: string) {
    const now = Date.now();
    const rec = attempts.get(key) ?? { count: 0, first: now };
    if (now - rec.first > LOCKOUT_MS) { rec.count = 0; rec.first = now; rec.lockedUntil = undefined; }
    rec.count += 1;
    if (rec.count >= MAX_ATTEMPTS) rec.lockedUntil = now + LOCKOUT_MS;
    attempts.set(key, rec);
  }

  app.post('/api/auth/login', {
    schema: { tags: ['auth'], summary: 'Log in', body: { type: 'object', required: ['email', 'password'], properties: { email: { type: 'string' }, password: { type: 'string' }, code: { type: 'string' } } } },
  }, async (req: any, reply) => {
    const key = throttleKey(req);
    const mins = checkLockout(key);
    if (mins != null) return reply.code(429).send({ ok: false, error: `Too many attempts. Try again in about ${mins} minute(s).` });
    try {
      const { token, user } = login(req.body.email, req.body.password, req.body.code);
      attempts.delete(key); // success clears the counter
      setSessionCookie(reply, token);
      return { ok: true, data: { user, tenants: tenantsForUser((user as any).id) } };
    } catch (e: any) {
      // Correct password but 2FA needed: tell the client to prompt for a code
      // (without counting it as a failed attempt).
      if (e.code === '2FA_REQUIRED') return reply.code(401).send({ ok: false, totp_required: true, error: 'Enter your authentication code' });
      recordFailure(key);
      return reply.code(401).send({ ok: false, error: e.message });
    }
  });

  app.post('/api/auth/logout', { schema: { tags: ['auth'], summary: 'Log out' } }, async (req: any, reply) => {
    endSession(req.cookies?.[COOKIE]);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', { schema: { tags: ['auth'], summary: 'Current user and their organisations' } }, async (req: any, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ ok: false, error: 'Not logged in' });
    return { ok: true, data: { user, tenants: tenantsForUser(user.id) } };
  });

  // ── Organisations & team ─────────────────────────────────────────────────
  app.post('/api/orgs', { schema: { tags: ['orgs'], summary: 'Create an organisation', body: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } } } }, async (req: any, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ ok: false, error: 'Please log in' });
    return { ok: true, data: createTenant(req.body.name, user.id) };
  });

  app.get('/api/orgs/:id/members', { schema: { tags: ['orgs'], summary: 'List members' } }, async (req: any, reply) => {
    const ctx = requireTenant({ ...req, headers: { ...req.headers, 'x-tenant-id': req.params.id } }, reply);
    if (!ctx) return;
    return { ok: true, data: tenantMembers(ctx.tenant.id) };
  });

  function ownerOnly(ctx: { role: string; user: any; tenant: any }, reply: any): boolean {
    const m = membership(ctx.user.id, ctx.tenant.id);
    if (!m?.is_owner && ctx.role !== 'Adviser') { reply.code(403).send({ ok: false, error: 'Only an owner or adviser can manage the team' }); return false; }
    return true;
  }

  app.post('/api/orgs/:id/invites', {
    schema: { tags: ['orgs'], summary: 'Invite a teammate by email', body: { type: 'object', required: ['email', 'role'], properties: { email: { type: 'string' }, role: { type: 'string' } } } },
  }, async (req: any, reply) => {
    const ctx = requireTenant({ ...req, headers: { ...req.headers, 'x-tenant-id': req.params.id } }, reply);
    if (!ctx || !ownerOnly(ctx, reply)) return;
    try {
      const inv = createInvite(ctx.tenant.id, req.body.email, req.body.role, ctx.user.id);
      const base = process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`;
      return { ok: true, data: { ...inv, link: `${base}/invite/${inv.token}` } };
    } catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  app.get('/api/orgs/:id/invites', { schema: { tags: ['orgs'], summary: 'List pending invites' } }, async (req: any, reply) => {
    const ctx = requireTenant({ ...req, headers: { ...req.headers, 'x-tenant-id': req.params.id } }, reply);
    if (!ctx || !ownerOnly(ctx, reply)) return;
    const base = process.env.PUBLIC_URL || `${req.protocol}://${req.headers.host}`;
    return { ok: true, data: listInvites(ctx.tenant.id).map((i: any) => ({ ...i, link: `${base}/invite/${i.token}` })) };
  });

  app.delete('/api/orgs/:id/invites/:inviteId', { schema: { tags: ['orgs'], summary: 'Revoke an invite' } }, async (req: any, reply) => {
    const ctx = requireTenant({ ...req, headers: { ...req.headers, 'x-tenant-id': req.params.id } }, reply);
    if (!ctx || !ownerOnly(ctx, reply)) return;
    revokeInvite(ctx.tenant.id, Number(req.params.inviteId));
    return { ok: true };
  });

  app.put('/api/orgs/:id/members/:userId', { schema: { tags: ['orgs'], summary: 'Change a member\'s role', body: { type: 'object', required: ['role'], properties: { role: { type: 'string' } } } } }, async (req: any, reply) => {
    const ctx = requireTenant({ ...req, headers: { ...req.headers, 'x-tenant-id': req.params.id } }, reply);
    if (!ctx || !ownerOnly(ctx, reply)) return;
    try { setMemberRole(ctx.tenant.id, Number(req.params.userId), req.body.role); return { ok: true }; }
    catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  app.delete('/api/orgs/:id/members/:userId', { schema: { tags: ['orgs'], summary: 'Remove a member' } }, async (req: any, reply) => {
    const ctx = requireTenant({ ...req, headers: { ...req.headers, 'x-tenant-id': req.params.id } }, reply);
    if (!ctx || !ownerOnly(ctx, reply)) return;
    try { removeMember(ctx.tenant.id, Number(req.params.userId)); return { ok: true }; }
    catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  // ── Passwords ─────────────────────────────────────────────────────────────
  app.post('/api/auth/change-password', {
    schema: { tags: ['auth'], summary: 'Change your own password', body: { type: 'object', required: ['current_password', 'new_password'], properties: { current_password: { type: 'string' }, new_password: { type: 'string' } } } },
  }, async (req: any, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ ok: false, error: 'Please log in' });
    try { changePassword(user.id, req.body.current_password, req.body.new_password); return { ok: true }; }
    catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  // ── Two-factor authentication ─────────────────────────────────────────────
  app.get('/api/auth/2fa/status', { schema: { tags: ['auth'], summary: 'Whether 2FA is enabled' } }, async (req: any, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ ok: false, error: 'Please log in' });
    return { ok: true, data: totpStatus(user.id) };
  });

  app.post('/api/auth/2fa/setup', { schema: { tags: ['auth'], summary: 'Begin 2FA enrolment (returns QR URI)' } }, async (req: any, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ ok: false, error: 'Please log in' });
    try { return { ok: true, data: beginTotpEnrollment(user.id) }; }
    catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  app.post('/api/auth/2fa/confirm', { schema: { tags: ['auth'], summary: 'Confirm 2FA enrolment', body: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } }, async (req: any, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ ok: false, error: 'Please log in' });
    try { confirmTotpEnrollment(user.id, req.body.code); return { ok: true }; }
    catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  app.post('/api/auth/2fa/disable', { schema: { tags: ['auth'], summary: 'Turn 2FA off', body: { type: 'object', required: ['code'], properties: { code: { type: 'string' } } } } }, async (req: any, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ ok: false, error: 'Please log in' });
    try { disableTotp(user.id, req.body.code); return { ok: true }; }
    catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  app.post('/api/orgs/:id/members/:userId/reset-password', {
    schema: { tags: ['orgs'], summary: "Reset a member's password (owner/adviser only)", body: { type: 'object', required: ['new_password'], properties: { new_password: { type: 'string' } } } },
  }, async (req: any, reply) => {
    const ctx = requireTenant({ ...req, headers: { ...req.headers, 'x-tenant-id': req.params.id } }, reply);
    if (!ctx || !ownerOnly(ctx, reply)) return;
    try { resetMemberPassword(ctx.tenant.id, ctx.user.id, Number(req.params.userId), req.body.new_password); return { ok: true }; }
    catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  // ── Invitations (public lookup + accept) ─────────────────────────────────
  app.get('/api/invites/:token', { schema: { tags: ['invites'], summary: 'Look up an invitation' } }, async (req: any, reply) => {
    const inv = inviteByToken(req.params.token);
    if (!inv) return reply.code(404).send({ ok: false, error: 'This invitation is no longer valid' });
    return { ok: true, data: { email: inv.email, role: inv.role, org_name: inv.tenant_name } };
  });

  app.post('/api/invites/:token/accept', { schema: { tags: ['invites'], summary: 'Accept an invitation (must be logged in as the invited email)' } }, async (req: any, reply) => {
    const user = currentUser(req);
    if (!user) return reply.code(401).send({ ok: false, error: 'Log in (or create an account) with the invited email first' });
    try { return { ok: true, data: acceptInvite(req.params.token, user.id) }; }
    catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  // ── Backup: download this organisation's database file ─────────────────────
  app.get('/api/orgs/:id/backup', { schema: { tags: ['orgs'], summary: "Download this organisation's database (backup)" } }, async (req: any, reply) => {
    const ctx = requireTenant({ ...req, headers: { ...req.headers, 'x-tenant-id': req.params.id } }, reply);
    if (!ctx || !ownerOnly(ctx, reply)) return;
    // Flush WAL into the main file by opening (cached) then stream it.
    openTenantDb(ctx.tenant.db_file);
    const path = require('./control').tenantDbPath(ctx.tenant.db_file);
    if (!existsSync(path)) return reply.code(404).send({ ok: false, error: 'No data yet' });
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-disposition', `attachment; filename="${ctx.tenant.name.replace(/[^a-z0-9]+/gi, '-')}.db"`);
    return reply.send(createReadStream(path));
  });

  // ── Generic engine RPC: the whole accounting engine over HTTP ──────────────
  app.post('/api/rpc', {
    schema: {
      tags: ['engine'], summary: 'Call any engine method (service.method) in the selected organisation',
      headers: { type: 'object', properties: { 'x-tenant-id': { type: 'string' }, 'idempotency-key': { type: 'string' } } },
      body: { type: 'object', required: ['method'], properties: { method: { type: 'string' }, args: { type: 'array' }, idempotency_key: { type: 'string' } } },
    },
  }, async (req: any, reply) => {
    const ctx = requireTenant(req, reply);
    if (!ctx) return;
    // An idempotency key (header or body) makes a retried write safe to repeat.
    const idemKey = req.headers['idempotency-key'] || req.body.idempotency_key;
    try {
      const data = runInTenant(ctx.tenant.db_file, acting(ctx.user, ctx.role), req.body.method, req.body.args ?? [], idemKey);
      return { ok: true, data };
    } catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
  });

  // ── A few clean REST resources for integrations (all documented) ───────────
  const rest = (method: 'get' | 'post', url: string, engineMethod: (req: any) => { m: string; a: unknown[] }, tag: string, summary: string) => {
    (app as any)[method](url, { schema: { tags: [tag], summary } }, async (req: any, reply: any) => {
      const ctx = requireTenant(req, reply);
      if (!ctx) return;
      try {
        const { m, a } = engineMethod(req);
        return { ok: true, data: runInTenant(ctx.tenant.db_file, acting(ctx.user, ctx.role), m, a) };
      } catch (e: any) { return reply.code(400).send({ ok: false, error: e.message }); }
    });
  };
  rest('get', '/api/v1/contacts', () => ({ m: 'contacts.list', a: [{}] }), 'rest', 'List contacts');
  rest('post', '/api/v1/contacts', (req) => ({ m: 'contacts.save', a: [req.body] }), 'rest', 'Create or update a contact');
  rest('get', '/api/v1/invoices', (req) => ({ m: 'invoices.list', a: [{ type: req.query.type || 'ACCREC' }] }), 'rest', 'List invoices/bills');
  rest('post', '/api/v1/invoices', (req) => ({ m: 'invoices.saveDraft', a: [req.body] }), 'rest', 'Create a draft invoice/bill');
  rest('get', '/api/v1/reports/trial-balance', (req) => ({ m: 'reports.trialBalance', a: [{ as_at: req.query.as_at || new Date().toISOString().slice(0, 10) }] }), 'rest', 'Trial balance as at a date');
  rest('get', '/api/v1/reports/profit-and-loss', (req) => ({ m: 'reports.profitAndLoss', a: [{ from: req.query.from, to: req.query.to, basis: req.query.basis }] }), 'rest', 'Profit & loss for a period');
  rest('get', '/api/v1/reports/balance-sheet', (req) => ({ m: 'reports.balanceSheet', a: [{ as_at: req.query.as_at || new Date().toISOString().slice(0, 10) }] }), 'rest', 'Balance sheet as at a date');

  // ── Static SPA (hosted edition UI) ─────────────────────────────────────────
  const uiDir = [
    join(process.cwd(), 'dist-server-ui'),
    join(__dirname, '..', '..', '..', 'dist-server-ui'),
  ].find((d) => existsSync(d));
  if (uiDir) {
    app.register(fstatic, { root: uiDir, prefix: '/' });
    // SPA fallback: any non-API GET that isn't a real asset returns index.html
    // (so deep links like /invite/<token> load the app).
    app.setNotFoundHandler((req: any, reply: any) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/docs')) {
        return reply.type('text/html').send(createReadStream(join(uiDir, 'server-ui.html')));
      }
      return reply.code(404).send({ ok: false, error: 'Not found' });
    });
  }

  return app;
}

export async function start() {
  initControl();
  const app = buildServer();
  const port = Number(process.env.PORT || 3000);
  await app.listen({ port, host: '0.0.0.0' });
  // eslint-disable-next-line no-console
  console.log(`Book of Business server listening on :${port}  (docs at /docs)`);
}

if (require.main === module) {
  start().catch((e) => { console.error(e); process.exit(1); });
}
