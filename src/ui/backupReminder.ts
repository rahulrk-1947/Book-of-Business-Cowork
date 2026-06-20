/**
 * Backup safety. Because the whole ledger lives in this browser, the worst
 * thing that can happen is losing it — a cleared browser, a dead laptop. There
 * is no cloud catching you. So we remember when you last backed up and give a
 * gentle, dismissible nudge once it's been a while (or if you've never done it
 * and there's real data to lose).
 *
 * The decision logic is a pure function so it can be tested without a browser;
 * the storage helpers are wrapped so they never throw if storage is blocked.
 */

const KEY = 'bob-last-backup';
const DISMISS_KEY = 'bob-backup-nudge-dismissed';
export const BACKUP_REMINDER_DAYS = 7;

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* storage blocked — ignore */ }
}

/** Call right after a successful backup. */
export function recordBackup(when: Date = new Date()): void {
  safeSet(KEY, when.toISOString());
  // A fresh backup clears any "dismissed for now" so the next nudge is honest.
  try { localStorage.removeItem(DISMISS_KEY); } catch { /* ignore */ }
}

export function lastBackup(): Date | null {
  const raw = safeGet(KEY);
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

export function daysSinceBackup(now: Date = new Date()): number | null {
  const last = lastBackup();
  if (!last) return null;
  return Math.floor((now.getTime() - last.getTime()) / 86_400_000);
}

export function dismissNudge(now: Date = new Date()): void {
  safeSet(DISMISS_KEY, now.toISOString().slice(0, 10)); // dismissed for today
}

function dismissedToday(now: Date = new Date()): boolean {
  return safeGet(DISMISS_KEY) === now.toISOString().slice(0, 10);
}

/**
 * Should we show the backup nudge? Pure so it's testable.
 * - Never nudge an empty book (nothing to lose yet).
 * - Nudge if never backed up but there's data.
 * - Nudge if it's been at least `thresholdDays` since the last backup.
 */
export function shouldRemind(opts: {
  lastBackupISO: string | null;
  hasData: boolean;
  now?: Date;
  thresholdDays?: number;
}): boolean {
  const { lastBackupISO, hasData } = opts;
  const now = opts.now ?? new Date();
  const threshold = opts.thresholdDays ?? BACKUP_REMINDER_DAYS;
  if (!hasData) return false;
  if (!lastBackupISO) return true;
  const last = new Date(lastBackupISO);
  if (isNaN(last.getTime())) return true;
  const days = Math.floor((now.getTime() - last.getTime()) / 86_400_000);
  return days >= threshold;
}

/** The live check the UI uses (reads storage, respects today's dismissal). */
export function shouldShowNudge(hasData: boolean, now: Date = new Date()): boolean {
  if (dismissedToday(now)) return false;
  return shouldRemind({ lastBackupISO: safeGet(KEY), hasData, now });
}
