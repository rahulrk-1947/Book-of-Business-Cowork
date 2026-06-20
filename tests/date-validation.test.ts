import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/backend/db';
import * as settings from '../src/backend/services/settings';
import { dateError } from '../src/ui/api';

describe('UI date validator (dateError)', () => {
  it('accepts valid ISO dates', () => {
    expect(dateError('2026-02-28')).toBeNull();
    expect(dateError('2024-02-29')).toBeNull(); // leap year
    expect(dateError('2026-12-31')).toBeNull();
    expect(dateError('')).toBeNull();           // empty handled by required checks
    expect(dateError(null)).toBeNull();
  });

  it('rejects impossible calendar dates', () => {
    expect(dateError('2026-02-30')).toMatch(/real calendar date/i); // the screenshot bug
    expect(dateError('2026-04-31')).toMatch(/real calendar date/i);
    expect(dateError('2025-02-29')).toMatch(/real calendar date/i); // not a leap year
    expect(dateError('2026-13-01')).toMatch(/valid|calendar/i);
    expect(dateError('2026-00-10')).toMatch(/valid|calendar/i);
  });

  it('rejects malformed and out-of-range values', () => {
    expect(dateError('02/30/2026')).toMatch(/date picker|valid/i); // text fallback format
    expect(dateError('not-a-date')).toMatch(/valid/i);
    expect(dateError('1899-12-31')).toMatch(/between 1900 and 2200/i);
    expect(dateError('2201-01-01')).toMatch(/between 1900 and 2200/i);
  });

  it('uses the provided label in the message', () => {
    expect(dateError('2026-02-30', 'due date')).toMatch(/due date/i);
  });
});

describe('setLockDate validates its dates', () => {
  beforeEach(() => initDatabase(':memory:'));
  it('rejects an impossible lock date', () => {
    expect(() => settings.setLockDate('2026-02-30', null)).toThrow(/calendar date/i);
    expect(() => settings.setLockDate(null, '2026-13-01')).toThrow(/month|calendar/i);
  });
  it('accepts a valid lock date and clears it', () => {
    expect(() => settings.setLockDate('2026-03-31', null)).not.toThrow();
    expect(() => settings.setLockDate(null, null)).not.toThrow();
  });
});
