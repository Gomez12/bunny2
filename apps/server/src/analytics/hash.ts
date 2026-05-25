import { createHash, createHmac } from 'node:crypto';

/**
 * Phase 6 of `docs/dev/plans/admin-observability-viewer.md` —
 * server-side `user_id` hashing for the `analytics_events` sink.
 *
 * Strategy (ADR 0031 D3 + `AGENTS.md §Privacy and Data Protection`):
 *   - If `BUNNY2_ENCRYPTION_KEY` is set, use HMAC-SHA256 with that
 *     key. A keyed hash makes a hostile reader who exfiltrates the
 *     `analytics_events` table unable to brute-force the small UUID
 *     space back to raw ids — they would also need the secret.
 *   - Absent the env, fall back to plain SHA-256. Documented in
 *     `docs/dev/observability/analytics.md` so an operator knows
 *     they should wire the encryption key for production deploys.
 *
 * The output is the hex digest, lowercase, no truncation. The admin
 * viewer truncates for display; storage keeps the full 64-char
 * digest so the (hash → row) mapping stays unambiguous across the
 * retention window.
 */

const ENCRYPTION_KEY_ENV_VAR = 'BUNNY2_ENCRYPTION_KEY';

/**
 * Hashes a raw user id for persistence in `analytics_events.user_id_hash`.
 * Returns `null` for an empty / null input so callers can pass the
 * `c.var.user.id` straight through; an unauthenticated request
 * would not reach this code in the first place.
 */
export function hashUserId(rawUserId: string | null): string | null {
  if (rawUserId === null || rawUserId === '') return null;
  const key = pickEncryptionKey();
  if (key !== null) {
    return createHmac('sha256', key).update(rawUserId, 'utf8').digest('hex');
  }
  return createHash('sha256').update(rawUserId, 'utf8').digest('hex');
}

function pickEncryptionKey(): string | null {
  const fromEnv = process.env[ENCRYPTION_KEY_ENV_VAR];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return null;
}

/**
 * Test-only — exported so the privacy-sanity tests can assert that
 * the same input yields the same hash twice under the same key.
 */
export function __hashUserIdForTest(rawUserId: string, key: string | null): string {
  if (key !== null) {
    return createHmac('sha256', key).update(rawUserId, 'utf8').digest('hex');
  }
  return createHash('sha256').update(rawUserId, 'utf8').digest('hex');
}
