/**
 * Phase 4c.2 — symmetric secret encryption helper.
 *
 * Round-trip, envelope-shape, idempotency, and forward-compatibility
 * tests for `createSecretsService` in `apps/server/src/storage/secrets.ts`.
 * No env vars are read here — every test constructs the service with an
 * explicit key so we never leak a test key into `process.env`.
 */
import { describe, expect, it } from 'bun:test';
import {
  ENC_ENVELOPE_PREFIX,
  SECRETS_ERROR_KEYS,
  createSecretsService,
  generateEncryptionKey,
  parseEncryptionKey,
} from '../../src/storage/secrets';

function makeService() {
  const key = generateEncryptionKey();
  return createSecretsService({ key });
}

describe('secrets :: round trip', () => {
  it('encrypts and decrypts a plaintext to itself', () => {
    const svc = makeService();
    const enc = svc.encryptSecret('hello world');
    expect(enc.startsWith(ENC_ENVELOPE_PREFIX)).toBe(true);
    expect(svc.decryptSecret(enc)).toBe('hello world');
  });

  it('produces a different ciphertext for the same plaintext (random IV)', () => {
    const svc = makeService();
    const a = svc.encryptSecret('same input');
    const b = svc.encryptSecret('same input');
    expect(a).not.toBe(b);
    expect(svc.decryptSecret(a)).toBe(svc.decryptSecret(b));
  });

  it('handles unicode plaintext', () => {
    const svc = makeService();
    const enc = svc.encryptSecret('hello — 世界 🚀');
    expect(svc.decryptSecret(enc)).toBe('hello — 世界 🚀');
  });
});

describe('secrets :: envelope shape', () => {
  it('rejects malformed envelopes', () => {
    const svc = makeService();
    expect(() => svc.decryptSecret('enc:v1:bad')).toThrow(SECRETS_ERROR_KEYS.EnvelopeMalformed);
    expect(() => svc.decryptSecret('enc:v9:aa:bb:cc')).toThrow(
      SECRETS_ERROR_KEYS.EnvelopeMalformed,
    );
    expect(() => svc.decryptSecret('not-an-envelope')).toThrow(SECRETS_ERROR_KEYS.NotEncrypted);
  });

  it('refuses to decrypt a plaintext', () => {
    const svc = makeService();
    expect(() => svc.decryptSecret('plain-text')).toThrow(SECRETS_ERROR_KEYS.NotEncrypted);
  });

  it('isEnvelope returns true only for the prefixed shape', () => {
    const svc = makeService();
    expect(svc.isEnvelope('plain')).toBe(false);
    expect(svc.isEnvelope(svc.encryptSecret('x'))).toBe(true);
  });
});

describe('secrets :: idempotency safety', () => {
  it('refuses to re-encrypt an envelope', () => {
    const svc = makeService();
    const enc = svc.encryptSecret('hello');
    expect(() => svc.encryptSecret(enc)).toThrow(SECRETS_ERROR_KEYS.AlreadyEncrypted);
  });
});

describe('secrets :: key absence', () => {
  it('constructs without a key and surfaces missing-key errors on use', () => {
    // Force the helper to NOT read process.env by pointing it at a
    // non-existent env var name.
    const svc = createSecretsService({ envVar: 'BUNNY2_NEVER_SET_ENV_KEY_XXX' });
    expect(svc.hasKey).toBe(false);
    expect(() => svc.encryptSecret('x')).toThrow(SECRETS_ERROR_KEYS.KeyMissing);
    expect(() => svc.decryptSecret('enc:v1:a:b:c')).toThrow(SECRETS_ERROR_KEYS.KeyMissing);
  });

  it('parseEncryptionKey accepts base64 and hex but rejects wrong lengths', () => {
    const key = generateEncryptionKey();
    const b64 = Buffer.from(key).toString('base64');
    const hex = Buffer.from(key).toString('hex');
    expect(parseEncryptionKey(b64)?.byteLength).toBe(32);
    expect(parseEncryptionKey(hex)?.byteLength).toBe(32);
    expect(parseEncryptionKey('too-short')).toBeNull();
    expect(parseEncryptionKey('')).toBeNull();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => createSecretsService({ key: new Uint8Array(16) })).toThrow(
      SECRETS_ERROR_KEYS.KeyInvalid,
    );
  });
});

describe('secrets :: forward-compatible versioning', () => {
  it('parses a v1 envelope and rejects an unknown version', () => {
    const svc = makeService();
    const enc = svc.encryptSecret('hello');
    expect(enc.split(':')[1]).toBe('v1');
    // Tamper with the version segment.
    const parts = enc.split(':');
    parts[1] = 'v2';
    const tampered = parts.join(':');
    expect(() => svc.decryptSecret(tampered)).toThrow(SECRETS_ERROR_KEYS.EnvelopeMalformed);
  });

  it('authenticated-encryption: tampering with ciphertext fails decrypt', () => {
    const svc = makeService();
    const enc = svc.encryptSecret('hello');
    const parts = enc.split(':');
    // Flip a base64 byte in the ciphertext segment.
    const ct = parts[3]!;
    const flipped = ct.charAt(0) === 'A' ? 'B' + ct.slice(1) : 'A' + ct.slice(1);
    parts[3] = flipped;
    expect(() => svc.decryptSecret(parts.join(':'))).toThrow(SECRETS_ERROR_KEYS.DecryptFailed);
  });
});
