/**
 * Money is ALWAYS integer minor units (cents) in this codebase.
 * Floating point never touches a stored amount; the only float math is the
 * intermediate multiply inside a calculation, which is immediately rounded
 * half-away-from-zero to a cent. The rounding policy (round per line, then
 * sum; push any residual to the Rounding account) is unit-tested.
 */

/** Round a (possibly fractional) cent value half-away-from-zero to an integer. */
export function roundCents(x: number): number {
  // A tiny epsilon absorbs binary-floating-point shortfall at the .5 boundary
  // (e.g. 1.005 * 100 = 100.4999999…, which would otherwise round DOWN to 100
  // instead of half-away-from-zero to 101). 1e-6 covers the rounding error of a
  // single multiply for amounts up to ~$10M while never flipping a genuine
  // non-half value.
  const r = Math.round(Math.abs(x) + 1e-6);
  return x < 0 ? -r : r;
}

/** quantity × unit cents × (1 − discount%) → net cents (rounded per line). */
export function lineNet(quantity: number, unitCents: number, discountPercent = 0): number {
  return roundCents(quantity * unitCents * (1 - discountPercent / 100));
}

/** Convert foreign cents to base cents at a rate (base units per foreign unit). */
export function toBase(cents: number, exchangeRate: number): number {
  return roundCents(cents * exchangeRate);
}

export function formatCents(cents: number, currency = 'USD', locale = 'en-US'): string {
  return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(cents / 100);
}

/** Parse a user-entered amount string ("1,234.56") to cents. Throws on garbage. */
export function parseCents(input: string | number): number {
  if (typeof input === 'number') return roundCents(input * 100);
  const clean = input.replace(/[,\s$€£]/g, '');
  if (!/^-?\d*(\.\d{0,4})?$/.test(clean) || clean === '' || clean === '-') {
    throw new Error(`Invalid amount: "${input}"`);
  }
  return roundCents(parseFloat(clean) * 100);
}
