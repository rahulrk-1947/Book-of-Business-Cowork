/**
 * Period math for report comparisons. Pure functions over ISO dates so both
 * the UI and tests can rely on identical calendar behaviour.
 */

export type Win = { from: string; to: string; label: string };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const iso = (d: Date) => d.toISOString().slice(0, 10);
const parse = (s: string) => new Date(s + 'T00:00:00Z');
const monthEnd = (y: number, m: number) => new Date(Date.UTC(y, m + 1, 0)); // m: 0-based

/** k preceding windows of the same length as [from, to]. */
export function sameLengthWindows(from: string, to: string, k: number): Win[] {
  const span = parse(to).getTime() - parse(from).getTime() + 86400000;
  return Array.from({ length: k }, (_, i) => {
    const end = parse(from).getTime() - 86400000 - i * span;
    const start = end - span + 86400000;
    const f = iso(new Date(start));
    const t = iso(new Date(end));
    return { from: f, to: t, label: `${f} – ${t}` };
  });
}

/** k full calendar months ending before [from]. */
export function monthWindows(from: string, k: number): Win[] {
  const d = parse(from);
  d.setUTCDate(d.getUTCDate() - 1); // the day before the range starts
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const out: Win[] = [];
  for (let i = 0; i < k; i++) {
    out.push({
      from: iso(new Date(Date.UTC(y, m, 1))),
      to: iso(monthEnd(y, m)),
      label: `${MONTHS[m]} ${y}`,
    });
    m -= 1;
    if (m < 0) { m = 11; y -= 1; }
  }
  return out;
}

/** k full calendar quarters ending before [from]. */
export function quarterWindows(from: string, k: number): Win[] {
  const d = parse(from);
  d.setUTCDate(d.getUTCDate() - 1);
  let y = d.getUTCFullYear();
  let q = Math.floor(d.getUTCMonth() / 3); // quarter containing the day before
  const out: Win[] = [];
  for (let i = 0; i < k; i++) {
    out.push({
      from: iso(new Date(Date.UTC(y, q * 3, 1))),
      to: iso(monthEnd(y, q * 3 + 2)),
      label: `Q${q + 1} ${y}`,
    });
    q -= 1;
    if (q < 0) { q = 3; y -= 1; }
  }
  return out;
}

/** k calendar half-years (Jan–Jun, Jul–Dec) ending before [from]. */
export function halfWindows(from: string, k: number): Win[] {
  const d = parse(from);
  d.setUTCDate(d.getUTCDate() - 1);
  let y = d.getUTCFullYear();
  let h = d.getUTCMonth() < 6 ? 0 : 1;
  const out: Win[] = [];
  for (let i = 0; i < k; i++) {
    out.push({
      from: iso(new Date(Date.UTC(y, h * 6, 1))),
      to: iso(monthEnd(y, h * 6 + 5)),
      label: `H${h + 1} ${y}`,
    });
    h -= 1;
    if (h < 0) { h = 1; y -= 1; }
  }
  return out;
}

/** The same [from, to] range shifted back i years, for i = 1..k (year on year). */
export function yearWindows(from: string, to: string, k: number): Win[] {
  const shift = (s: string, years: number) => {
    const d = parse(s);
    const y = d.getUTCFullYear() - years;
    const m = d.getUTCMonth();
    const day = Math.min(d.getUTCDate(), monthEnd(y, m).getUTCDate()); // Feb 29 → Feb 28
    return iso(new Date(Date.UTC(y, m, day)));
  };
  return Array.from({ length: k }, (_, i) => {
    const f = shift(from, i + 1);
    const t = shift(to, i + 1);
    return { from: f, to: t, label: `${f} – ${t}` };
  });
}

export function plWindows(basis: string, from: string, to: string, k: number): Win[] {
  switch (basis) {
    case 'period': return sameLengthWindows(from, to, k);
    case 'month': return monthWindows(from, k);
    case 'quarter': return quarterWindows(from, k);
    case 'half': return halfWindows(from, k);
    case 'year': return yearWindows(from, to, k);
    default: return [];
  }
}

export type Snap = { as_at: string; label: string };

/** k period-end snapshot dates strictly before [as_at]. */
export function bsSnapshots(basis: string, as_at: string, k: number): Snap[] {
  const d = parse(as_at);
  const out: Snap[] = [];
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  const push = (yy: number, mm: number, label: string) => out.push({ as_at: iso(monthEnd(yy, mm)), label });
  if (basis === 'month_end') {
    // last month-end strictly before as_at
    if (iso(monthEnd(y, m)) >= as_at) { m -= 1; if (m < 0) { m = 11; y -= 1; } }
    for (let i = 0; i < k; i++) {
      push(y, m, `${MONTHS[m]} ${y}`);
      m -= 1; if (m < 0) { m = 11; y -= 1; }
    }
  } else if (basis === 'quarter_end') {
    let q = Math.floor(m / 3);
    if (iso(monthEnd(y, q * 3 + 2)) >= as_at) { q -= 1; if (q < 0) { q = 3; y -= 1; } }
    for (let i = 0; i < k; i++) {
      push(y, q * 3 + 2, `Q${q + 1} ${y}`);
      q -= 1; if (q < 0) { q = 3; y -= 1; }
    }
  } else if (basis === 'half_end') {
    let h = m < 6 ? 0 : 1;
    if (iso(monthEnd(y, h * 6 + 5)) >= as_at) { h -= 1; if (h < 0) { h = 1; y -= 1; } }
    for (let i = 0; i < k; i++) {
      push(y, h * 6 + 5, `H${h + 1} ${y}`);
      h -= 1; if (h < 0) { h = 1; y -= 1; }
    }
  } else if (basis === 'year_end') {
    if (iso(monthEnd(y, 11)) >= as_at) y -= 1;
    for (let i = 0; i < k; i++) { push(y, 11, `Dec ${y}`); y -= 1; }
  }
  return out;
}
