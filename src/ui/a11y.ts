/**
 * Accessibility preferences. Kept deliberately small: a larger-text option
 * that some people need to read comfortably. The choice is remembered and
 * applied to the whole document by toggling a class, so it survives reloads.
 * Storage access is wrapped so a privacy-locked browser never throws.
 */

const TEXT_KEY = 'bob-a11y-large-text';

function safeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function safeSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* ignore */ }
}

export function largeTextEnabled(): boolean {
  return safeGet(TEXT_KEY) === '1';
}

export function setLargeText(on: boolean): void {
  safeSet(TEXT_KEY, on ? '1' : '0');
  applyLargeText(on);
}

export function applyLargeText(on: boolean = largeTextEnabled()): void {
  try {
    document.body.classList.toggle('text-lg', on);
  } catch { /* no document (e.g. tests) — ignore */ }
}
