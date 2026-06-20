/**
 * Tax-on-line maths (spec §5.3 / §13).
 *
 * EXCLUSIVE: net = qty × unit × (1 − disc%); tax = net × rate; total = net + tax
 * INCLUSIVE: gross = qty × unit × (1 − disc%); net = gross / (1 + rate); tax = gross − net
 * NOTAX:     tax = 0
 *
 * Rates may have multiple components; compound components apply on top of
 * net + all previous components. Everything is rounded per line to a cent.
 */
import { lineNet, roundCents } from './money';

export type LineAmountType = 'EXCLUSIVE' | 'INCLUSIVE' | 'NOTAX';

export interface TaxComponent {
  percent: number;
  is_compound: 0 | 1 | boolean;
}

export interface LineInput {
  quantity: number;
  unit_amount: number; // cents
  discount_percent?: number;
  components?: TaxComponent[]; // empty/undefined ⇒ 0%
}

export interface LineResult {
  net: number; // cents
  tax: number; // cents
  gross: number; // cents
}

/** Effective total rate as a fraction, honouring compounding. */
export function effectiveRate(components: TaxComponent[] = []): number {
  let simple = 0;
  let factor = 1;
  for (const c of components) {
    if (c.is_compound) factor *= 1 + c.percent / 100;
    else simple += c.percent / 100;
  }
  // Non-compound components apply to net; compound ones apply to (net + previous).
  // Effective: net × (1 + simple) compounded by each compound component.
  return (1 + simple) * factor - 1;
}

export function calcLine(input: LineInput, mode: LineAmountType): LineResult {
  const amount = lineNet(input.quantity, input.unit_amount, input.discount_percent ?? 0);
  if (mode === 'NOTAX') return { net: amount, tax: 0, gross: amount };

  const rate = effectiveRate(input.components);
  if (mode === 'EXCLUSIVE') {
    const tax = roundCents(amount * rate);
    return { net: amount, tax, gross: amount + tax };
  }
  // INCLUSIVE
  const net = roundCents(amount / (1 + rate));
  return { net, tax: amount - net, gross: amount };
}

export interface DocTotals {
  subtotal: number;
  total_tax: number;
  total: number;
  lines: LineResult[];
}

/** Round per line, then sum (the documented rounding policy). */
export function calcDocument(lines: LineInput[], mode: LineAmountType): DocTotals {
  const results = lines.map((l) => calcLine(l, mode));
  return {
    subtotal: results.reduce((s, r) => s + r.net, 0),
    total_tax: results.reduce((s, r) => s + r.tax, 0),
    total: results.reduce((s, r) => s + r.gross, 0),
    lines: results,
  };
}
