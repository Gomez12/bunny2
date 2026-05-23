import { hash, verify } from '@node-rs/argon2';

/**
 * `@node-rs/argon2` exposes the algorithm choice as a `const enum`. Our
 * tsconfig enables `verbatimModuleSyntax`, which forbids importing const
 * enums (they don't survive type erasure). We therefore inline the numeric
 * value — `Algorithm.Argon2id === 2` per the library's `index.d.ts`.
 */
const ARGON2ID = 2 as const;

/**
 * Argon2id password hashing wrapper.
 *
 * Implementation: `@node-rs/argon2` (native N-API, prebuilt binaries for
 * macOS arm64/x64, Linux x64 gnu/musl, Windows x64). See
 * `docs/dev/decisions/0007-argon2-implementation.md` for the rationale.
 *
 * Parameters follow OWASP 2024 password storage guidance for argon2id:
 *   - memoryCost: 19 MiB (19456 KiB)
 *   - timeCost:   2 iterations
 *   - parallelism: 1
 *
 * These values balance security and login latency on the portable per-OS
 * build. Adjust here when hardware moves on; the encoded hash records the
 * parameters so old hashes keep verifying.
 */
const ARGON2_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(plaintext: string): Promise<string> {
  return hash(plaintext, ARGON2_OPTIONS);
}

export async function verifyPassword(plaintext: string, hashString: string): Promise<boolean> {
  try {
    return await verify(hashString, plaintext);
  } catch {
    // Malformed hash or other verification error: treat as no match.
    return false;
  }
}

/**
 * Lazily-computed dummy hash used by `dummyVerify` to equalize login timing
 * when a username is not found. We hash a constant the first time it's
 * needed; subsequent calls reuse the result.
 */
let dummyHashPromise: Promise<string> | null = null;

function getDummyHash(): Promise<string> {
  if (dummyHashPromise === null) {
    // The plaintext value is never returned and never compared; the dummy
    // hash exists solely to make `verify` spend roughly the same time it
    // would for a real user.
    dummyHashPromise = hash('bunny2-dummy-password', ARGON2_OPTIONS);
  }
  return dummyHashPromise;
}

/**
 * Runs an argon2 verify against a precomputed dummy hash. Used by the login
 * route (introduced in 2.3) when the supplied username does not exist, so
 * that response latency does not leak username existence.
 *
 * Always resolves without exposing the verify result — the caller must not
 * branch on the return value.
 */
export async function dummyVerify(plaintext = 'bunny2-dummy-password'): Promise<void> {
  const dummy = await getDummyHash();
  try {
    await verify(dummy, plaintext);
  } catch {
    // Swallow — the only purpose of this call is to spend CPU time.
  }
}
