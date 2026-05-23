# ADR 0007 — Argon2id implementation: `@node-rs/argon2`

- Status: accepted
- Date: 2026-05-23
- Phase: 2.1
- Related: `docs/dev/plans/done/phase-02-users-and-groups.md` §11.1; `apps/server/src/auth/password.ts`.

---

## Context

Phase 2.1 introduces password hashing. `overall.md` §4 fixes the algorithm
(argon2id). The remaining open question, recorded in
`phase-02-users-and-groups.md` §11.1, is the implementation library.

Constraints:

1. **Bun + N-API or pure WASM.** The portable per-OS build runs on Bun
   1.3 across macOS arm64/x64, Linux x64, Windows x64. A native dep is
   acceptable only if prebuilt binaries cover every target — we will not
   ship a build that demands a Rust toolchain on the user's machine.
2. **OWASP 2024 argon2id parameters** must be reachable: m ≥ 19 MiB,
   t ≥ 2, p ≥ 1.
3. **Login latency on a developer laptop** stays below ~150 ms for the
   chosen parameters; argon2 is intentionally slow, not annoying.
4. **Constant-time login regardless of user existence** — the library
   must let us run a verify against a dummy hash when the username is
   missing.

Candidates evaluated:

- **`@node-rs/argon2`** v2.0.2 — RustCrypto argon2 binding via N-API.
- **`oslo` / `@oslojs/password`** — pure WASM (or Web Crypto where
  available). Used by the Lucia auth ecosystem.

---

## Decision

Adopt **`@node-rs/argon2`**.

The npm metadata for `@node-rs/argon2@2.0.2` ships optional dependencies
for every platform we need:

| Target           | Prebuilt package                 |
| ---------------- | -------------------------------- |
| macOS arm64      | `@node-rs/argon2-darwin-arm64`   |
| macOS x64        | `@node-rs/argon2-darwin-x64`     |
| Linux x64 (gnu)  | `@node-rs/argon2-linux-x64-gnu`  |
| Linux x64 (musl) | `@node-rs/argon2-linux-x64-musl` |
| Windows x64      | `@node-rs/argon2-win32-x64-msvc` |

A `wasm32-wasi` fallback (`@node-rs/argon2-wasm32-wasi`) is also
published. Bun supports N-API loading, and the library is used widely
with Bun (Lucia/Oslo ecosystem benchmarks). No source-compile step is
required at `bun install` time on any of our targets.

### Parameters

```ts
algorithm:   Argon2id
memoryCost:  19456 KiB    // 19 MiB — OWASP 2024 minimum
timeCost:    2
parallelism: 1
```

These match OWASP 2024 "Password Storage Cheat Sheet" guidance for
argon2id and give roughly 70–110 ms per hash/verify on a modern laptop.
The encoded argon2 hash (`$argon2id$v=19$m=19456,t=2,p=1$...$...`)
records the parameters, so future upgrades verify against old hashes
without migration scripts.

### Constant-time verify

`apps/server/src/auth/password.ts` exports `dummyVerify()`. It lazily
hashes a constant string on first call and caches the result, then runs
`verify(dummyHash, plaintext)` whenever the login route encounters an
unknown username. The dummy hash is generated once per process; the
verify call is what equalizes latency.

The helper is introduced in 2.1 (where the password module lives) and
consumed by the login route in 2.3. Tests in 2.1 cover hash/verify
round-trip, wrong-password rejection, salt randomness, and that
`dummyVerify()` runs to completion without throwing.

---

## Why not `oslo` / `@oslojs/password`

- Pure WASM avoids the prebuild question, but performance is meaningfully
  worse: WASM argon2 is roughly 2–3× slower than the native binding at
  equivalent parameters, and we cannot afford to raise the cost knob
  much further on a portable single-machine deployment.
- Bundle / archive size for the per-OS portable build is comparable
  either way — the platform-specific N-API `.node` files are a few
  hundred KiB; the WASM bundle is in the same ballpark.
- The Lucia ecosystem actively uses both; our preference is native here
  because every target has a prebuild and login latency matters.

If `@node-rs/argon2` ever loses Windows or Linux prebuilds, the fallback
to `@oslojs/password` is the established escape hatch. The wrapper's
public API (`hashPassword`, `verifyPassword`, `dummyVerify`) is library-
agnostic, so the swap is contained to one file.

---

## Consequences

**Positive**

- Native speed, OWASP-aligned parameters, prebuilt binaries for every
  target. No Rust toolchain on user machines.
- Library is maintained, widely deployed, and N-API stable.
- Wrapper is one file — swapping the underlying lib is a contained change.

**Negative / accepted**

- We adopt a native dep. Acceptable because: prebuilds cover every
  target, the binary is small, and the fallback (WASM) is documented.
- The `@node-rs/argon2-*` platform packages are downloaded via npm's
  optional-deps mechanism. Bun's installer handles this transparently;
  CI matrices on all three OSes verify the lockfile resolves correctly.

---

## Alternatives considered

1. **`oslo` / `@oslojs/password`** — pure WASM. Rejected primarily on
   per-hash latency. Kept as the documented fallback if a prebuild ever
   goes missing.
2. **`argon2` (the `node-argon2` package by Ranisalt)** — requires a C
   toolchain to compile on platforms where its prebuilds lag. Rejected
   for the portable-build constraint.
3. **Hand-rolled argon2** — never. Always use a vetted implementation
   for password hashing.

---

## Follow-ups

- 2.3 wires `dummyVerify()` into the login route. The latency-equalize
  test lives with the login HTTP test.
- If we ever need to rotate parameters (e.g. m ≥ 64 MiB on more capable
  hardware), the encoded hashes still verify; the upgrade path is to
  re-hash on next successful login.
