import { describe, it, expect } from 'vitest';
import { shouldRemind } from '../src/ui/backupReminder';

const day = (n: number) => new Date(Date.UTC(2026, 5, n)).toISOString();
const NOW = new Date(Date.UTC(2026, 5, 20));

describe('backup reminder logic', () => {
  it('never nags an empty book', () => {
    expect(shouldRemind({ lastBackupISO: null, hasData: false, now: NOW })).toBe(false);
    expect(shouldRemind({ lastBackupISO: day(1), hasData: false, now: NOW })).toBe(false);
  });

  it('nags when there is data but no backup ever', () => {
    expect(shouldRemind({ lastBackupISO: null, hasData: true, now: NOW })).toBe(true);
  });

  it('nags only after the threshold since the last backup', () => {
    expect(shouldRemind({ lastBackupISO: day(18), hasData: true, now: NOW, thresholdDays: 7 })).toBe(false); // 2 days ago
    expect(shouldRemind({ lastBackupISO: day(12), hasData: true, now: NOW, thresholdDays: 7 })).toBe(true);  // 8 days ago
    expect(shouldRemind({ lastBackupISO: day(13), hasData: true, now: NOW, thresholdDays: 7 })).toBe(true);  // exactly 7
  });

  it('treats a corrupt timestamp as "needs backup"', () => {
    expect(shouldRemind({ lastBackupISO: 'garbage', hasData: true, now: NOW })).toBe(true);
  });
});
