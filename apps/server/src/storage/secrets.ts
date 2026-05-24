import * as crypto from 'node:crypto';

/**
 * Phase 4c.2 — symmetric secret encryption helper.
 *
 * Wraps Node/Bun's `node:crypto` AES-256-GCM primitive in a small,
 * self-describing envelope:
 *
 *   enc:v1:<base64-iv>:<base64-ciphertext>:<base64-authTag>
 *
 * The `v1` version segment leaves a forward-compatible seam for key
 * rotation — when a `v2` arrives, decryption tries each registered key
 * version in order. v1 only supports a single key (loaded from
 * `config.secrets.encryptionKey`).
 *
 * Why a shared helper here (vs. baking encryption into the Google
 * Calendar connector): every future OAuth connector (Google Contacts,
 * Microsoft 365, Outlook, …) will need exactly the same primitive.
 * Centralising the envelope format + scrub rules keeps the entire
 * codebase to one cipher, one IV strategy, and one place that handles
 * absent keys. See ADR `0015-secret-encryption.md`.
 *
 * Boot semantics:
 *  - If no `encryptionKey` is configured, the helper still loads. Both
 *    `encryptSecret` and `decryptSecret` throw a stable error key when
 *    called. Existing tests that never touch encryption stay green.
 *  - `BUNNY2_ENCRYPTION_KEY` env var is the runtime knob. It must be a
 *    32-byte key encoded as base64 (44 chars incl. padding) OR as hex
 *    (64 chars). Other lengths fail boot via the config schema.
 *
 * Secrets discipline:
 *  - `encryptSecret` REFUSES to re-encrypt a string that already starts
 *    with the `enc:v1:` envelope prefix. This makes the round-trip
 *    "load + save" idempotent and prevents nested envelopes that would
 *    fail to decrypt.
 *  - `decryptSecret` REFUSES to decrypt plaintext (no envelope prefix);
 *    callers that need "leave-alone" semantics must check `isEnvelope`
 *    first.
 *  - The returned plaintext is held in memory only by the caller. The
 *    helper itself owns no global state aside from the key.
 *
 * Test injection:
 *  - The default singleton reads `BUNNY2_ENCRYPTION_KEY` lazily on first
 *    use. Tests pass a key directly via `createSecretsService({ key })`
 *    to avoid leaking test keys into the process env.
 */

const ENVELOPE_PREFIX = 'enc:v1:';
const KEY_BYTES = 32;
const IV_BYTES = 12; // GCM standard nonce length.
const TAG_BYTES = 16;

export const SECRETS_ERROR_KEYS = {
  KeyMissing: 'errors.secrets.keyMissing',
  KeyInvalid: 'errors.secrets.keyInvalid',
  EnvelopeMalformed: 'errors.secrets.envelopeMalformed',
  AlreadyEncrypted: 'errors.secrets.alreadyEncrypted',
  NotEncrypted: 'errors.secrets.notEncrypted',
  DecryptFailed: 'errors.secrets.decryptFailed',
} as const;

export interface SecretsService {
  /**
   * Encrypts a UTF-8 string and returns the self-describing envelope.
   * Refuses to re-encrypt a string that's already an envelope.
   */
  encryptSecret(plaintext: string): string;
  /**
   * Decrypts an envelope produced by `encryptSecret`. Refuses anything
   * that isn't an envelope.
   */
  decryptSecret(envelope: string): string;
  /** Cheap shape check — `true` if the string looks like an envelope. */
  isEnvelope(value: string): boolean;
  /** `true` once a usable key is loaded. Boot logs read this. */
  readonly hasKey: boolean;
}

export interface CreateSecretsServiceOptions {
  /**
   * Optional explicit key (Uint8Array, 32 bytes). Tests pass this so the
   * helper does not consult `process.env`. When omitted the helper reads
   * `BUNNY2_ENCRYPTION_KEY` (base64 or hex).
   */
  readonly key?: Uint8Array;
  /**
   * Env var name to read when `key` is undefined. Defaults to
   * `BUNNY2_ENCRYPTION_KEY`. Override exists so a future phase can read
   * a per-service key without growing the env surface.
   */
  readonly envVar?: string;
}

/**
 * Parses a base64 or hex string into a 32-byte key. Returns `null` if
 * the string is unparseable or has the wrong length; the caller decides
 * how to surface the failure (boot warning vs. throw).
 */
export function parseEncryptionKey(raw: string): Uint8Array | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  // hex first — 64 hex chars is unambiguous.
  if (/^[0-9a-fA-F]+$/.test(trimmed) && trimmed.length === KEY_BYTES * 2) {
    try {
      return new Uint8Array(Buffer.from(trimmed, 'hex'));
    } catch {
      return null;
    }
  }
  // base64 fallback. A 32-byte buffer is 44 base64 chars (with padding).
  try {
    const buf = Buffer.from(trimmed, 'base64');
    if (buf.length === KEY_BYTES) return new Uint8Array(buf);
  } catch {
    /* fall through */
  }
  return null;
}

export function createSecretsService(opts: CreateSecretsServiceOptions = {}): SecretsService {
  let key: Uint8Array | null = null;
  if (opts.key !== undefined) {
    if (opts.key.byteLength !== KEY_BYTES) {
      throw new Error(SECRETS_ERROR_KEYS.KeyInvalid);
    }
    key = opts.key;
  } else {
    const envVar = opts.envVar ?? 'BUNNY2_ENCRYPTION_KEY';
    const raw = process.env[envVar];
    if (raw !== undefined && raw.length > 0) {
      const parsed = parseEncryptionKey(raw);
      if (parsed === null) {
        // Mirrors KvK invalid-config semantics: a misconfigured key
        // throws an i18n-keyed error rather than silently disabling
        // encryption (which would defeat the purpose).
        throw new Error(SECRETS_ERROR_KEYS.KeyInvalid);
      }
      key = parsed;
    }
  }

  function isEnvelope(value: string): boolean {
    return typeof value === 'string' && /^enc:v\d+:/.test(value);
  }

  function encryptSecret(plaintext: string): string {
    if (key === null) throw new Error(SECRETS_ERROR_KEYS.KeyMissing);
    // Cheap shape check on plaintext: refuse anything that already
    // looks like an envelope (idempotency safety).
    if (isEnvelope(plaintext)) throw new Error(SECRETS_ERROR_KEYS.AlreadyEncrypted);
    const iv = new Uint8Array(crypto.randomBytes(IV_BYTES));
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [
      'enc',
      'v1',
      Buffer.from(iv).toString('base64'),
      ciphertext.toString('base64'),
      tag.toString('base64'),
    ].join(':');
  }

  function decryptSecret(envelope: string): string {
    if (key === null) throw new Error(SECRETS_ERROR_KEYS.KeyMissing);
    if (!isEnvelope(envelope)) throw new Error(SECRETS_ERROR_KEYS.NotEncrypted);
    const parts = envelope.split(':');
    // ['enc', 'v1', iv, ciphertext, tag]
    if (parts.length !== 5) throw new Error(SECRETS_ERROR_KEYS.EnvelopeMalformed);
    const [, version, ivB64, ctB64, tagB64] = parts;
    if (version !== 'v1') throw new Error(SECRETS_ERROR_KEYS.EnvelopeMalformed);
    if (ivB64 === undefined || ctB64 === undefined || tagB64 === undefined) {
      throw new Error(SECRETS_ERROR_KEYS.EnvelopeMalformed);
    }
    let iv: Buffer;
    let ct: Buffer;
    let tag: Buffer;
    try {
      iv = Buffer.from(ivB64, 'base64');
      ct = Buffer.from(ctB64, 'base64');
      tag = Buffer.from(tagB64, 'base64');
    } catch {
      throw new Error(SECRETS_ERROR_KEYS.EnvelopeMalformed);
    }
    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      throw new Error(SECRETS_ERROR_KEYS.EnvelopeMalformed);
    }
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const out = Buffer.concat([decipher.update(ct), decipher.final()]);
      return out.toString('utf8');
    } catch {
      throw new Error(SECRETS_ERROR_KEYS.DecryptFailed);
    }
  }

  return {
    encryptSecret,
    decryptSecret,
    isEnvelope,
    get hasKey() {
      return key !== null;
    },
  };
}

/**
 * Generate a fresh 32-byte key (Uint8Array). Used by tests to inject a
 * stable per-process key without committing one to the repo; production
 * operators run `openssl rand -base64 32` and paste the result into
 * `BUNNY2_ENCRYPTION_KEY` (see `docs/dev/setup/getting-started.md`).
 */
export function generateEncryptionKey(): Uint8Array {
  return new Uint8Array(crypto.randomBytes(KEY_BYTES));
}

/**
 * Re-export the prefix so connector code can do a cheap shape check on
 * untrusted input (rejecting a plaintext refresh token before it ever
 * reaches the DB).
 */
export const ENC_ENVELOPE_PREFIX = ENVELOPE_PREFIX;
