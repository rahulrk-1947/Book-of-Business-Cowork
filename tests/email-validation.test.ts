import { describe, it, expect, beforeEach } from 'vitest';
import { initDatabase } from '../src/backend/db';
import * as contacts from '../src/backend/services/contacts';
import { emailError } from '../src/ui/api';

describe('UI email validator', () => {
  it('accepts valid addresses and empty', () => {
    expect(emailError('name@example.com')).toBeNull();
    expect(emailError('a.b+tag@sub.domain.co')).toBeNull();
    expect(emailError('')).toBeNull();
    expect(emailError(null)).toBeNull();
  });
  it('rejects malformed addresses', () => {
    expect(emailError('not-an-email')).toMatch(/valid/i);
    expect(emailError('missing@domain')).toMatch(/valid/i);
    expect(emailError('@example.com')).toMatch(/valid/i);
    expect(emailError('has space@example.com')).toMatch(/valid/i);
  });
});

describe('contacts.save email guard', () => {
  beforeEach(() => initDatabase(':memory:'));
  it('rejects a malformed email', () => {
    expect(() => contacts.save({ name: 'Bad Email Co', email: 'nope', is_customer: true })).toThrow(/email/i);
  });
  it('accepts a valid email and no email', () => {
    expect(() => contacts.save({ name: 'Good Co', email: 'hi@good.test', is_customer: true })).not.toThrow();
    expect(() => contacts.save({ name: 'NoEmail Co', is_customer: true })).not.toThrow();
  });
});
