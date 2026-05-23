import { createHash } from 'node:crypto';

/**
 * Session-token primitives.
 *
 * - The plaintext token is 32 random bytes encoded as base64url. It travels
 *   over the wire (HttpOnly cookie for browsers, `Authorization: Bearer`
 *   for non-browser clients in 2.2+).
 * - The database stores only `SHA-256(token)` in hex. A leaked DB therefore
 *   cannot be used for session replay; the attacker would need the
 *   plaintext, which never lands on disk.
 *
 * Hash is unsalted on purpose: the input is already 256 bits of CSPRNG
 * output, so per-row salting adds no entropy. SHA-256 of a 256-bit random
 * value is collision/preimage-resistant for this use case.
 */

const TOKEN_BYTES = 32;

export function generateSessionToken(): string {
  const buf = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(buf);
  return base64urlEncode(buf);
}

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function base64urlEncode(bytes: Uint8Array): string {
  // Bun (and Node) provide Buffer; use it for fast base64 then transform.
  const base64 = Buffer.from(bytes).toString('base64');
  return base64.replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
}
