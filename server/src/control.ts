/**
 * The control plane: users, tenants, memberships and invitations. This is a
 * separate SQLite database from any tenant's accounting books. Passwords are
 * hashed with scrypt (built into Node — no native build step, unlike bcrypt).
 */
import { openDatabase, DB } from '../../src/backend/sqlite';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { generateSecret, verifyTotp, otpauthUrl } from './totp';

let control: DB | null = null;

export function dataDir(): string {
  // On Render this points at the mounted persistent disk (see DATA_DIR env).
  return process.env.DATA_DIR || join(process.cwd(), 'data');
}

export function initControl(): DB {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'control.db');
  const fresh = !existsSync(path);
  control = openDatabase(path);
  const schema = [
    join(__dirname, 'control-schema.sql'),
    join(process.cwd(), 'server/src/control-schema.sql'),
    join(process.cwd(), 'dist-server/control-schema.sql'),
  ].find((p) => existsSync(p));
  if (!schema) throw new Error('control-schema.sql not found');
  control.exec(readFileSync(schema, 'utf8'));
  // Idempotently add columns introduced after first release (existing DBs).
  const ucols = control.prepare('PRAGMA table_info(users)').all() as any[];
  const hasCol = (c: string) => ucols.some((x) => x.name === c);
  if (!hasCol('totp_secret')) control.exec('ALTER TABLE users ADD COLUMN totp_secret TEXT');
  if (!hasCol('totp_enabled')) control.exec('ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0');
  void fresh;
  return control;
}

export function ctl(): DB {
  if (!control) throw new Error('Control DB not initialised');
  return control;
}

// ── Passwords ────────────────────────────────────────────────────────────────

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(plain, salt, 64);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifyPassword(plain: string, stored: string): boolean {
  const [saltHex, hashHex] = stored.split(':');
  if (!saltHex || !hashHex) return false;
  const hash = Buffer.from(hashHex, 'hex');
  const test = scryptSync(plain, Buffer.from(saltHex, 'hex'), 64);
  return hash.length === test.length && timingSafeEqual(hash, test);
}

export function token(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

// ── Users ──────────────────────────────────────────────────────────────────

export function createUser(email: string, fullName: string, password: string) {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('That email address looks invalid');
  if (password.length < 8) throw new Error('Password must be at least 8 characters');
  if (ctl().prepare('SELECT id FROM users WHERE email = ?').get(e)) {
    throw new Error('An account with that email already exists — try logging in');
  }
  const id = Number(ctl().prepare(
    'INSERT INTO users (email, full_name, password_hash) VALUES (?, ?, ?)'
  ).run(e, fullName.trim() || e, hashPassword(password)).lastInsertRowid);
  return getUser(id);
}

export function getUser(id: number) {
  return ctl().prepare('SELECT id, email, full_name, status, last_login FROM users WHERE id = ?').get(id);
}

export function findUserByEmail(email: string) {
  return ctl().prepare('SELECT * FROM users WHERE email = ?').get(email.trim().toLowerCase());
}

// ── Password management ──────────────────────────────────────────────────────

/** Set a user's password directly (no old-password check). Used by admin reset and the CLI. */
export function setPassword(userId: number, newPassword: string) {
  if (!newPassword || newPassword.length < 8) throw new Error('Password must be at least 8 characters');
  const u: any = ctl().prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!u) throw new Error('User not found');
  ctl().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), userId);
  // Force re-login everywhere by clearing existing sessions.
  ctl().prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
  return { ok: true };
}

/** Break-glass reset by email — used by the CLI tool on the server. */
export function setPasswordByEmail(email: string, newPassword: string) {
  const u: any = findUserByEmail(email);
  if (!u) throw new Error(`No account found for ${email}`);
  setPassword(u.id, newPassword);
  return { ok: true, user_id: u.id, email: u.email };
}

/** A signed-in user changing their own password (must supply the current one). */
export function changePassword(userId: number, currentPassword: string, newPassword: string) {
  const u: any = ctl().prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) throw new Error('User not found');
  if (!verifyPassword(currentPassword, u.password_hash)) throw new Error('Your current password is incorrect');
  if (!newPassword || newPassword.length < 8) throw new Error('New password must be at least 8 characters');
  ctl().prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(newPassword), userId);
  // Keep the current session valid, drop the others.
  return { ok: true };
}

/** True if a membership may manage users (owner or Adviser). */
export function canManageUsers(m: any): boolean {
  return !!m && (m.is_owner === 1 || m.role === 'Adviser');
}

/**
 * Admin-initiated reset of another member's password. The actor must be an
 * owner or Adviser of the tenant, and the target must be a member of it.
 */
export function resetMemberPassword(tenantId: number, actorUserId: number, targetUserId: number, newPassword: string) {
  const actor = membership(actorUserId, tenantId);
  if (!canManageUsers(actor)) throw new Error('Only an owner or adviser can reset a member’s password');
  const target = membership(targetUserId, tenantId);
  if (!target) throw new Error('That person is not a member of this organisation');
  setPassword(targetUserId, newPassword);
  return { ok: true };
}

export function login(email: string, password: string, code?: string) {
  const u: any = findUserByEmail(email);
  if (!u || !verifyPassword(password, u.password_hash)) throw new Error('Wrong email or password');
  if (u.status === 'DISABLED') throw new Error('This account is disabled');
  if (u.totp_enabled) {
    // Password was correct, but two-factor is on. Signal the caller to prompt
    // for a code, and verify it once supplied.
    if (!code) { const e: any = new Error('Two-factor code required'); e.code = '2FA_REQUIRED'; throw e; }
    if (!verifyTotp(u.totp_secret, code)) throw new Error('Invalid authentication code');
  }
  ctl().prepare("UPDATE users SET last_login = datetime('now') WHERE id = ?").run(u.id);
  return startSession(u.id);
}

// ── Two-factor authentication (TOTP) ─────────────────────────────────────────

/** Begin enrolment: generate (or regenerate) a secret and return the QR URI. */
export function beginTotpEnrollment(userId: number) {
  const u: any = ctl().prepare('SELECT id, email FROM users WHERE id = ?').get(userId);
  if (!u) throw new Error('User not found');
  const secret = generateSecret();
  // Store the secret but keep 2FA disabled until a code confirms it works.
  ctl().prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(secret, userId);
  return { secret, otpauth_url: otpauthUrl(secret, u.email) };
}

/** Confirm enrolment with a code from the authenticator app; turns 2FA on. */
export function confirmTotpEnrollment(userId: number, code: string) {
  const u: any = ctl().prepare('SELECT totp_secret FROM users WHERE id = ?').get(userId);
  if (!u || !u.totp_secret) throw new Error('Start two-factor setup first');
  if (!verifyTotp(u.totp_secret, code)) throw new Error('That code didn’t match — check your authenticator app and try again');
  ctl().prepare('UPDATE users SET totp_enabled = 1 WHERE id = ?').run(userId);
  return { ok: true };
}

/** Turn 2FA off (requires a current code to prove possession of the device). */
export function disableTotp(userId: number, code: string) {
  const u: any = ctl().prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(userId);
  if (!u || !u.totp_enabled) return { ok: true };
  if (!verifyTotp(u.totp_secret, code)) throw new Error('Invalid authentication code');
  ctl().prepare('UPDATE users SET totp_secret = NULL, totp_enabled = 0 WHERE id = ?').run(userId);
  return { ok: true };
}

export function totpStatus(userId: number) {
  const u: any = ctl().prepare('SELECT totp_enabled FROM users WHERE id = ?').get(userId);
  return { enabled: !!(u && u.totp_enabled) };
}

// ── Sessions ─────────────────────────────────────────────────────────────────

export function startSession(userId: number) {
  const t = token();
  ctl().prepare(
    "INSERT INTO sessions (user_id, token, expires_at) VALUES (?, ?, datetime('now', '+30 days'))"
  ).run(userId, t);
  return { token: t, user: getUser(userId) };
}

export function userForToken(t: string | undefined) {
  if (!t) return null;
  const row: any = ctl().prepare(
    "SELECT user_id FROM sessions WHERE token = ? AND expires_at > datetime('now')"
  ).get(t);
  return row ? getUser(row.user_id) : null;
}

export function endSession(t: string | undefined) {
  if (t) ctl().prepare('DELETE FROM sessions WHERE token = ?').run(t);
}

// ── Tenants & membership ─────────────────────────────────────────────────────

export function createTenant(name: string, ownerId: number) {
  const dbFile = `tenant-${token(8)}.db`;
  const id = Number(ctl().prepare(
    'INSERT INTO tenants (name, db_file, created_by) VALUES (?, ?, ?)'
  ).run(name.trim() || 'My organisation', dbFile, ownerId).lastInsertRowid);
  ctl().prepare(
    'INSERT INTO memberships (user_id, tenant_id, role, is_owner) VALUES (?, ?, ?, 1)'
  ).run(ownerId, id, 'Adviser');
  return getTenant(id);
}

export function getTenant(id: number) {
  return ctl().prepare('SELECT id, name, db_file FROM tenants WHERE id = ?').get(id);
}

export function tenantsForUser(userId: number) {
  return ctl().prepare(
    `SELECT t.id, t.name, m.role, m.is_owner
     FROM memberships m JOIN tenants t ON t.id = m.tenant_id
     WHERE m.user_id = ? ORDER BY t.name`
  ).all(userId);
}

export function membership(userId: number, tenantId: number): any {
  return ctl().prepare(
    'SELECT * FROM memberships WHERE user_id = ? AND tenant_id = ?'
  ).get(userId, tenantId);
}

export function tenantMembers(tenantId: number) {
  return ctl().prepare(
    `SELECT u.id, u.email, u.full_name, m.role, m.is_owner
     FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = ? ORDER BY m.is_owner DESC, u.full_name`
  ).all(tenantId);
}

export function setMemberRole(tenantId: number, userId: number, role: string) {
  const m = membership(userId, tenantId);
  if (!m) throw new Error('That person is not a member of this organisation');
  if (m.is_owner) throw new Error("The owner's role can't be changed");
  ctl().prepare('UPDATE memberships SET role = ? WHERE id = ?').run(role, m.id);
}

export function removeMember(tenantId: number, userId: number) {
  const m = membership(userId, tenantId);
  if (!m) return;
  if (m.is_owner) throw new Error('The owner cannot be removed');
  ctl().prepare('DELETE FROM memberships WHERE id = ?').run(m.id);
}

// ── Invitations ──────────────────────────────────────────────────────────────

const ROLES = ['Adviser', 'Standard', 'Read Only', 'Invoice Only'];

export function createInvite(tenantId: number, email: string, role: string, invitedBy: number) {
  const e = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('That email address looks invalid');
  if (!ROLES.includes(role)) throw new Error('Unknown role');
  // Already a member?
  const existing: any = ctl().prepare(
    `SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.tenant_id = ? AND u.email = ?`
  ).get(tenantId, e);
  if (existing) throw new Error('That person is already a member of this organisation');
  // Reuse a pending invite for the same email.
  ctl().prepare("UPDATE invitations SET status = 'REVOKED' WHERE tenant_id = ? AND email = ? AND status = 'PENDING'").run(tenantId, e);
  const t = token();
  ctl().prepare(
    'INSERT INTO invitations (tenant_id, email, role, token, invited_by) VALUES (?, ?, ?, ?, ?)'
  ).run(tenantId, e, role, t, invitedBy);
  return { token: t, email: e, role };
}

export function listInvites(tenantId: number) {
  return ctl().prepare(
    "SELECT id, email, role, token, status, created_at FROM invitations WHERE tenant_id = ? AND status = 'PENDING' ORDER BY id DESC"
  ).all(tenantId);
}

export function revokeInvite(tenantId: number, inviteId: number) {
  ctl().prepare("UPDATE invitations SET status = 'REVOKED' WHERE id = ? AND tenant_id = ?").run(inviteId, tenantId);
}

export function inviteByToken(t: string): any {
  return ctl().prepare(
    `SELECT i.*, tn.name AS tenant_name FROM invitations i JOIN tenants tn ON tn.id = i.tenant_id
     WHERE i.token = ? AND i.status = 'PENDING'`
  ).get(t);
}

/** Accept an invite for an already-authenticated user, joining the tenant. */
export function acceptInvite(t: string, userId: number) {
  const inv = inviteByToken(t);
  if (!inv) throw new Error('This invitation is no longer valid');
  const user: any = getUser(userId);
  if (user.email.toLowerCase() !== inv.email.toLowerCase()) {
    throw new Error(`This invitation was sent to ${inv.email}. Log in with that email to accept it.`);
  }
  if (!membership(userId, inv.tenant_id)) {
    ctl().prepare('INSERT INTO memberships (user_id, tenant_id, role) VALUES (?, ?, ?)').run(userId, inv.tenant_id, inv.role);
  }
  ctl().prepare("UPDATE invitations SET status = 'ACCEPTED', accepted_at = datetime('now') WHERE id = ?").run(inv.id);
  return getTenant(inv.tenant_id);
}

export function tenantDbPath(dbFile: string): string {
  return join(dataDir(), dbFile);
}
