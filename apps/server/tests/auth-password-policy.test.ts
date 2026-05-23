/**
 * Phase 2.5 — `validateNewPassword`.
 *
 * Unit-level coverage on the shared password-policy helper. Both
 * self-rotation (`/auth/password`) and admin reset
 * (`/admin/users/:id/reset-password`) call this — keeping it pure lets
 * us assert the boundary behaviour without a DB or HTTP fixture.
 */
import { describe, expect, it } from 'bun:test';
import { validateNewPassword, MIN_PASSWORD_LENGTH } from '../src/auth/password-policy';

describe('validateNewPassword', () => {
  it('rejects passwords shorter than the minimum length', () => {
    const result = validateNewPassword('Short1!'); // 7 chars
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKey).toBe('errors.auth.weakPassword');
  });

  it('rejects passwords that are all letters even when long enough', () => {
    const result = validateNewPassword('AllLettersNoDigitsHere'); // 22 chars, letters only
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKey).toBe('errors.auth.weakPassword');
  });

  it('accepts a password of exactly the minimum length with one digit', () => {
    const pw = 'a'.repeat(MIN_PASSWORD_LENGTH - 1) + '1';
    expect(pw.length).toBe(MIN_PASSWORD_LENGTH);
    expect(validateNewPassword(pw).ok).toBe(true);
  });

  it('accepts a password with a symbol as the non-letter requirement', () => {
    expect(validateNewPassword('correct-horse-battery!').ok).toBe(true);
  });

  it('accepts a password whose non-letter is a space', () => {
    expect(validateNewPassword('correct horse battery').ok).toBe(true);
  });

  it('rejects the empty string', () => {
    const result = validateNewPassword('');
    expect(result.ok).toBe(false);
  });
});
