/** Renderer-side API. Every call routes through the Electron preload bridge. */

declare global {
  interface Window {
    bridge?: {
      api: (path: string, ...args: unknown[]) => Promise<{ ok: boolean; data?: any; error?: string }>;
      exportPdf: (html: string, name: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      saveCsv: (csv: string, name: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
      backup: () => Promise<{ ok: boolean; path?: string; error?: string }>;
      restore: () => Promise<{ ok: boolean; error?: string }>;
    };
  }
}

export class ApiError extends Error {}

export async function api<T = any>(path: string, ...args: unknown[]): Promise<T> {
  if (!window.bridge) throw new ApiError('Backend bridge unavailable — run inside the desktop app (npm run dev)');
  const res = await window.bridge.api(path, ...args);
  if (!res.ok) throw new ApiError(res.error ?? 'Unknown error');
  return res.data as T;
}

export const exportPdf = (html: string, name: string) => window.bridge!.exportPdf(html, name);
export const saveCsv = (csv: string, name: string) => window.bridge!.saveCsv(csv, name);
export const backupDb = () => window.bridge!.backup();
export const restoreDb = () => window.bridge!.restore();

/** Format integer cents for display. */
export function money(cents: number | null | undefined, currency = 'USD'): string {
  if (cents == null) return '—';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(cents / 100);
}

/** Parse a user-entered amount to cents (mirrors backend parseCents). */
export function toCents(input: string): number {
  const clean = input.replace(/[,\s$€£]/g, '');
  if (clean === '' || clean === '-') return 0;
  const f = parseFloat(clean);
  if (Number.isNaN(f)) return 0;
  return Math.round(f * 100);
}

export function fromCents(cents: number): string {
  return (cents / 100).toFixed(2);
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function addDays(d: string, days: number): string {
  const dt = new Date(d + 'T00:00:00Z');
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

/**
 * Validate an email address. Returns a human message, or null if it's fine.
 * Empty is allowed (emails are optional) — required-ness is handled per form.
 * Deliberately permissive: something@something.tld with no spaces.
 */
export function emailError(value: string | null | undefined, label = 'email address'): string | null {
  if (!value || !value.trim()) return null;
  const ok = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
  return ok ? null : `That doesn’t look like a valid ${label} (e.g. name@example.com).`;
}
export function dateError(value: string | null | undefined, label = 'date'): string | null {
  if (!value) return null; // emptiness is handled by each form's "required" check
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return `That ${label} isn’t valid — please use the date picker (YYYY-MM-DD).`;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1900 || y > 2200) return `The year in that ${label} must be between 1900 and 2200.`;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return `That ${label} isn’t a real calendar date (for example, 30 February doesn’t exist).`;
  }
  return null;
}

/** Inline numeric validator: returns a friendly message or null. Empty is allowed unless required. */
export function numberError(
  value: string | number | null | undefined,
  opts: { label?: string; min?: number; max?: number; integer?: boolean; allowNegative?: boolean; required?: boolean } = {},
): string | null {
  const { label = 'number', min, max, integer = false, allowNegative = true, required = false } = opts;
  const raw = typeof value === 'number' ? String(value) : (value ?? '').trim();
  if (!raw) return required ? `Please enter a ${label}.` : null;
  if (!/^-?(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return `That ${label} isn’t a valid number.`;
  const n = Number(raw);
  if (!Number.isFinite(n)) return `That ${label} isn’t a valid number.`;
  if (!allowNegative && n < 0) return `The ${label} can’t be negative.`;
  if (integer && !Number.isInteger(n)) return `The ${label} must be a whole number.`;
  if (min !== undefined && n < min) return `The ${label} must be at least ${min}.`;
  if (max !== undefined && n > max) return `The ${label} must be ${max} or less.`;
  return null;
}

/** Required free-text guard: returns a message when empty/blank, else null. */
export function requiredError(value: string | null | undefined, label = 'value'): string | null {
  return value && value.trim() ? null : `Please enter a ${label}.`;
}
