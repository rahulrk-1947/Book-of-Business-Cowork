import { describe, it, expect } from 'vitest';
import { monthWindows, quarterWindows, halfWindows, yearWindows, sameLengthWindows, bsSnapshots } from '../src/shared/periods';

describe('comparison period math', () => {
  it('same-length windows tile backwards exactly', () => {
    const w = sameLengthWindows('2026-02-01', '2026-02-28', 2);
    expect(w[0]).toMatchObject({ from: '2026-01-04', to: '2026-01-31' });
    expect(w[1]).toMatchObject({ from: '2025-12-07', to: '2026-01-03' });
  });
  it('month windows are true calendar months', () => {
    const w = monthWindows('2026-02-10', 3);
    expect(w.map((x) => [x.from, x.to])).toEqual([
      ['2026-02-01', '2026-02-28'], // month containing the day before Feb 10
      ['2026-01-01', '2026-01-31'],
      ['2025-12-01', '2025-12-31'],
    ]);
    expect(w[2].label).toBe('Dec 2025');
    // when the range starts on the 1st, comparisons begin at the prior month
    expect(monthWindows('2026-03-01', 1)[0].to).toBe('2026-02-28');
  });
  it('quarter and half windows snap to calendar blocks', () => {
    expect(quarterWindows('2026-02-15', 2).map((x) => x.label)).toEqual(['Q1 2026', 'Q4 2025']);
    expect(quarterWindows('2026-04-01', 1)[0]).toMatchObject({ from: '2026-01-01', to: '2026-03-31', label: 'Q1 2026' });
    expect(halfWindows('2026-07-01', 2).map((x) => [x.from, x.to])).toEqual([
      ['2026-01-01', '2026-06-30'],
      ['2025-07-01', '2025-12-31'],
    ]);
  });
  it('year windows shift the same range back, handling leap days', () => {
    const w = yearWindows('2024-02-29', '2024-03-31', 1);
    expect(w[0]).toMatchObject({ from: '2023-02-28', to: '2023-03-31' });
    expect(yearWindows('2026-02-01', '2026-02-28', 2)[1].from).toBe('2024-02-01');
  });
  it('balance-sheet snapshots are period ends strictly before as_at', () => {
    expect(bsSnapshots('month_end', '2026-06-12', 2).map((s) => s.as_at)).toEqual(['2026-05-31', '2026-04-30']);
    expect(bsSnapshots('month_end', '2026-06-30', 1)[0].as_at).toBe('2026-05-31'); // own end excluded
    expect(bsSnapshots('quarter_end', '2026-06-12', 2).map((s) => s.label)).toEqual(['Q1 2026', 'Q4 2025']);
    expect(bsSnapshots('half_end', '2026-06-30', 1)[0].as_at).toBe('2025-12-31');
    expect(bsSnapshots('year_end', '2026-06-12', 2).map((s) => s.as_at)).toEqual(['2025-12-31', '2024-12-31']);
  });
});
