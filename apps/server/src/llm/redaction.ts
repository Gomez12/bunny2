/**
 * Redaction rules applied to the JSON payload that telemetry persists for
 * each LLM call. We err on the side of dropping/masking obvious secrets
 * because phase 1.4 logs 100% of calls — a leaked key here lands in the
 * SQLite file on disk.
 *
 * Exact rule:
 *
 *  1. **Key match (case-insensitive, exact name).** When a key in any
 *     object inside the request equals one of {`apiKey`, `api_key`,
 *     `authorization`, `bearer`, `password`, `secret`, `token`}, the value
 *     is replaced with the string `"[REDACTED]"`. Match is exact (not a
 *     substring) to avoid clobbering benign names like `tokenizer` or
 *     `secretSantaNote`.
 *  2. **Value pattern (anywhere).** Any string value that matches an
 *     obvious provider-key shape is replaced with `"[REDACTED]"`, even if
 *     its key is innocuous (e.g. a user pasting a key into a chat
 *     `content` field). Current shapes:
 *       - `sk-[A-Za-z0-9_-]{16,}` (OpenAI-style)
 *       - `sk-ant-[A-Za-z0-9_-]{16,}` (Anthropic-style)
 *       - `Bearer\s+[A-Za-z0-9_\-\.=]{16,}`
 *
 * Walk is recursive (objects and arrays). Non-object/non-array values are
 * passed through unchanged except for the value-pattern check on strings.
 *
 * We never mutate the input. The result is a fresh JSON tree safe to
 * `JSON.stringify` straight into the `request` column.
 */

const REDACTED = '[REDACTED]';

const SECRET_KEY_NAMES = new Set(
  ['apiKey', 'api_key', 'authorization', 'bearer', 'password', 'secret', 'token'].map((s) =>
    s.toLowerCase(),
  ),
);

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{16,}/g,
  /sk-[A-Za-z0-9_-]{16,}/g,
  /Bearer\s+[A-Za-z0-9_\-.=]{16,}/g,
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_NAMES.has(key.toLowerCase());
}

function maskStringValue(value: string): string {
  let out = value;
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, REDACTED);
  }
  return out;
}

export function redact(input: unknown): unknown {
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return maskStringValue(input);
  if (typeof input !== 'object') return input;

  if (Array.isArray(input)) {
    return input.map((v) => redact(v));
  }

  const source = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(source)) {
    if (isSecretKey(k)) {
      out[k] = REDACTED;
      continue;
    }
    out[k] = redact(v);
  }
  return out;
}
