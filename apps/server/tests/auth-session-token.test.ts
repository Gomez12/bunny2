import { describe, expect, it } from 'bun:test';
import { generateSessionToken, hashSessionToken } from '../src/auth/session-token';

describe('auth/session-token', () => {
  it('generates base64url tokens of at least 43 characters', () => {
    const token = generateSessionToken();
    // 32 bytes base64url-encoded ≈ 43 characters (no padding).
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces distinct tokens on repeated calls', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 32; i++) {
      tokens.add(generateSessionToken());
    }
    expect(tokens.size).toBe(32);
  });

  it('hashSessionToken is deterministic for the same input', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
  });

  it('hashSessionToken returns a 64-char hex string', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('different tokens produce different hashes', () => {
    const a = hashSessionToken(generateSessionToken());
    const b = hashSessionToken(generateSessionToken());
    expect(a).not.toBe(b);
  });
});
