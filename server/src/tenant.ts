/**
 * Bridges an authenticated request to the existing Book of Business accounting
 * engine. Each tenant has its own SQLite file using the unmodified engine
 * schema; we open it once, cache it, and on each request swap it in as the
 * engine's active DB, set the acting user, then call straight into the same
 * registry the desktop/web editions use.
 *
 * This is safe despite a shared global DB handle because the engine is fully
 * synchronous: from setActive() through call() there is no await, so two
 * requests can never interleave mid-operation.
 */
import { openDatabase, DB } from '../../src/backend/sqlite';
import { setDb, runMigrations } from '../../src/backend/db';
import * as session from '../../src/backend/session';
import { call as engineCall } from '../../src/backend/registry';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tenantDbPath } from './control';

const cache = new Map<string, DB>();

function schemaSql(): string {
  const p = [
    join(process.cwd(), 'src/backend/schema.sql'),
    join(process.cwd(), 'dist-server/schema.sql'),
    join(__dirname, 'schema.sql'),
  ].find((x) => existsSync(x));
  if (!p) throw new Error('schema.sql not found');
  return readFileSync(p, 'utf8');
}

export function openTenantDb(dbFile: string): DB {
  const cached = cache.get(dbFile);
  if (cached) return cached;
  const path = tenantDbPath(dbFile);
  const fresh = !existsSync(path);
  const db = openDatabase(path);
  if (fresh) db.exec(schemaSql());
  runMigrations(db, path, fresh);
  cache.set(dbFile, db);
  return db;
}

/**
 * The accounting engine identifies the acting user by a numeric id from its
 * OWN users table (for audit attribution + permission checks). We keep that
 * table in sync per tenant: each control-plane user is mirrored into the
 * tenant DB on first use, carrying the membership role so the engine's
 * permission gate (already built) enforces what they may do.
 */
export function ensureEngineUser(db: DB, opts: { email: string; fullName: string; role: string }): number {
  const existing: any = db.prepare('SELECT id FROM users WHERE email = ?').get(opts.email.toLowerCase());
  let userId: number;
  if (existing) {
    userId = existing.id;
  } else {
    userId = Number(db.prepare(
      "INSERT INTO users (name, email, password_hash, status) VALUES (?, ?, 'external-auth', 'ACTIVE')"
    ).run(opts.fullName, opts.email.toLowerCase()).lastInsertRowid);
  }
  // Map the membership role to the engine's seeded role row, and (re)assign it.
  const roleRow: any = db.prepare('SELECT id FROM roles WHERE name = ?').get(opts.role);
  if (roleRow) {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(userId);
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, roleRow.id);
  }
  return userId;
}

/**
 * Engine calls a hosted tenant client must never make directly. The acting user
 * is fixed from the authenticated membership (below); allowing the client to
 * switch the engine's active user would let any member become the seeded
 * Administrator and bypass the entire role model (privilege escalation).
 */
const SERVER_DENIED_CALLS = new Set(['settings.setActiveUser']);

/**
 * Run one engine call in a tenant's context. Synchronous from start to finish.
 */
export function runInTenant(
  dbFile: string,
  acting: { email: string; fullName: string; role: string },
  path: string,
  args: unknown[],
  idempotencyKey?: string
): unknown {
  if (SERVER_DENIED_CALLS.has(path)) {
    throw new Error(`Operation not permitted: ${path}`);
  }
  const db = openTenantDb(dbFile);
  setDb(db);
  const uid = ensureEngineUser(db, acting);
  session.setCurrentUser(uid);
  try {
    return engineCall(path, args, idempotencyKey ? { idempotencyKey } : undefined);
  } finally {
    // Never leave an acting user on the shared global session between requests.
    session.setCurrentUser(0);
  }
}
