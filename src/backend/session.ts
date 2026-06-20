/**
 * The active user for this app session. The browser/desktop UI is single-
 * seat, so "multi-user" here means named profiles with full audit
 * attribution: every journal, void, import and edit is recorded against
 * whoever is switched in. It is bookkeeping attribution, not access control
 * — anyone who can open the file can switch profiles.
 */
let currentUserId = 1;

export function currentUser(): number {
  return currentUserId;
}

export function setCurrentUser(id: number) {
  currentUserId = id;
}

import { getDb } from './db';

/** Permission codes granted to the active profile (via its roles). */
export function currentPermissions(): Set<string> {
  try {
    const rows = getDb().prepare(
      `SELECT DISTINCT p.code FROM user_roles ur
       JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id
       WHERE ur.user_id = ?`
    ).all(currentUserId) as Array<{ code: string }>;
    return new Set(rows.map((r) => r.code));
  } catch {
    return new Set();
  }
}

/** True if the active profile holds the permission (or holds the catch-all). */
export function can(permission: string): boolean {
  const perms = currentPermissions();
  // A profile with every permission is effectively an adviser/admin.
  const total = getDb().prepare('SELECT COUNT(*) AS n FROM permissions').get().n as number;
  if (perms.size >= total) return true;
  return perms.has(permission);
}
