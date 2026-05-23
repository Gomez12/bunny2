import { describe, expect, it } from 'bun:test';
import { dummyVerify, hashPassword, verifyPassword } from '../src/auth/password';

describe('auth/password', () => {
  it('hashes and verifies a password round-trip', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('rejects an incorrect password', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong password', hash)).toBe(false);
  });

  it('returns false for malformed hashes instead of throwing', async () => {
    expect(await verifyPassword('any', 'not-an-argon2-hash')).toBe(false);
  });

  it('produces a different hash each call for the same password (random salt)', async () => {
    const a = await hashPassword('same input');
    const b = await hashPassword('same input');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same input', a)).toBe(true);
    expect(await verifyPassword('same input', b)).toBe(true);
  });

  it('dummyVerify runs to completion without throwing', async () => {
    // First call: lazy-initializes the dummy hash. Second call: reuses it.
    await dummyVerify();
    await dummyVerify('anything');
    // Reaching here is the assertion.
    expect(true).toBe(true);
  });
});
