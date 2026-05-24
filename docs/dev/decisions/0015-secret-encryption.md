# ADR 0015 — Server-side symmetric secret encryption

Status: accepted (2026-05-24).

## Context

Phase 4c.2 introduces the first OAuth-based connector (Google Calendar).
Refresh tokens and client secrets need to be stored on the server so the
poll runner can refresh per-link access tokens without an interactive
user. Storing them in plaintext inside `layer_attachments.config_json`
would leak the entire deployment if the SQLite DB were ever copied
unencrypted — a realistic risk on shared dev machines and backup tapes.

We need a primitive that:

- Works in Bun / Node without extra deps.
- Self-describes its key version so a future rotation is possible.
- Authenticates the ciphertext (the operator can detect tampering).
- Fails closed when no key is configured.
- Is reusable across every future OAuth connector (Google Contacts,
  Microsoft 365, Outlook, …) — i.e. lives in shared infra, NOT inside a
  per-connector file.

## Decision

Ship `apps/server/src/storage/secrets.ts`:

```ts
const ENVELOPE = 'enc:v1:<base64-iv>:<base64-ciphertext>:<base64-tag>';
encryptSecret(plaintext): string  // refuses to re-encrypt an envelope
decryptSecret(envelope):  string  // refuses to decrypt a plaintext
isEnvelope(value):        boolean
```

- AES-256-GCM via Node's built-in `crypto.createCipheriv` (Bun supports
  it natively — no Web Crypto async ceremony).
- 12-byte random IV per call (GCM standard).
- 16-byte authentication tag attached to the envelope.
- Single 32-byte key (Uint8Array). v1 supports one key; the version
  prefix leaves a seam for a rotation table in v2.
- Key is loaded from `config.secrets.encryptionKey` which boot reads
  from `BUNNY2_ENCRYPTION_KEY` env (base64 OR hex; we sniff the shape).
- When the key is absent, the service still constructs (`hasKey:
false`) so existing deployments boot. Any `encryptSecret` /
  `decryptSecret` call then throws `errors.secrets.keyMissing` — the
  per-attachment write path is the only caller, so the cost of a
  misconfigured deployment is "OAuth connectors don't work", not
  "server crashes".

## Alternatives considered

1. **Per-connector libsodium / age**. Two extra deps for one cipher; no
   gain over Node's built-in AES-GCM for our threat model.
2. **No encryption (plaintext in DB)**. Rejected — operator backup tapes
   become bearer tokens.
3. **OS-level keystore (Keychain / DPAPI)**. Bunny2 ships as an
   Electron-wrapped Bun sidecar across macOS / Linux / Windows. The
   per-OS keystore APIs differ enough that a single shared encryption
   helper is a better unification point now.
4. **Per-row keys**. Doable but solves a problem we don't yet have (the
   operator already has one master backup tape if they have the DB).
   Revisit if a multi-tenant deployment lands.

## Consequences

- Every new OAuth connector inherits the helper for free.
- Operators MUST `export BUNNY2_ENCRYPTION_KEY=$(openssl rand -base64
32)` before saving connector attachments. A boot warning in
  phase-5 will surface the absent key prominently — for now the
  per-route save fails closed, which is enough.
- Key rotation is out of scope for v1 (`v1` is the only version). When a
  customer asks for rotation, the envelope's version prefix becomes the
  hinge and the cost is a small migration over `layer_attachments`.

See implementation: `apps/server/src/storage/secrets.ts`. Test surface:
`apps/server/tests/storage/secrets.test.ts`.
