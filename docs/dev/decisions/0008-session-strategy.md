# ADR 0008 — Session strategy: opaque server-side tokens

- Status: accepted
- Date: 2026-05-23
- Phase: 2.2
- Related: `docs/dev/plans/done/phase-02-users-and-groups.md` §11.2;
  `apps/server/src/auth/sessions.ts`,
  `apps/server/src/auth/session-token.ts`,
  `apps/server/src/auth/cookie.ts`,
  `apps/server/src/http/middleware/auth.ts`.

---

## Context

Phase 2.2 introduces authenticated sessions. The phase-2 plan §11.2
records the open question: opaque session id stored server-side, or a
signed/encrypted JWT held client-side. The plan's default is opaque.
This ADR confirms the default and writes down the trade-offs.

Constraints driving the choice:

1. **Cheap revocation.** Logout, admin "kill session", group-membership
   change, password reset, and soft-delete all need to invalidate live
   sessions immediately. The plan §10 lists soft-delete as a hard
   invariant: a soft-deleted user must not be able to keep using a
   live session.
2. **Local-first, single-writer.** The portable Bunny2 build is one
   process talking to one SQLite file. There is no horizontal fleet
   to coordinate, so stateful sessions are essentially free — one
   indexed row lookup per request.
3. **Two transports.** Browsers (Electron renderer, Vite dev) get an
   HttpOnly cookie; non-browser clients (smoke tests, future CLI/MCP
   pieces) carry the same token in `Authorization: Bearer`. A single
   token shape that works in both contexts simplifies the middleware
   and the test surface.
4. **Defence against DB leak.** A snapshot of `bunny2.sqlite` must
   not be enough to impersonate users. The plaintext token only ever
   lives in the cookie/header; the DB stores `SHA-256(token)` (hex).

---

## Decision

Use **opaque, server-side session tokens**:

- 32 random bytes (`crypto.getRandomValues`) encoded as base64url
  produce the plaintext token (`generateSessionToken` in
  `apps/server/src/auth/session-token.ts`).
- The DB row stores only `SHA-256(token)` in `sessions.token_hash`
  (already present in `0002_users_groups.sql`).
- Transport is dual: an HttpOnly + SameSite=Lax cookie
  (`bunny2_session`) for browsers and `Authorization: Bearer <token>`
  for non-browser clients. The auth middleware prefers `Authorization`
  when both are present.
- Expiry has two knobs:
  - **Absolute TTL** — `sessions.expires_at`, enforced in SQL by
    `findSessionByTokenHash(... , now)`.
  - **Idle window** — checked in the session service against
    `last_seen_at`. The middleware touches `last_seen_at` after a
    successful resolve (fire-and-forget) so the window slides.
- Defaults: `sessionTtlMinutes = 14 days`, `sessionIdleMinutes = 24
hours`. Both live in `AuthConfigSchema` so an operator can override
  them via `config.json`.
- Soft-delete invalidates immediately: the session service rejects
  resolutions where the owning user's `deleted_at` is set.

The session service is the single seam between the HTTP layer and
the persistence layer. It returns only the safe `User` shape from
`@bunny2/shared/auth` — `passwordHash` never crosses the boundary.

---

## Consequences

**Positive**

- One DB row per session, one indexed lookup per request. Cost is
  negligible on a local-first build.
- Logout, admin kill, password change, soft-delete are all O(1) writes
  that take effect on the next request — no token-blacklist plumbing.
- DB snapshot does not enable replay (hashed at rest).
- Same token shape works for cookies and Bearer; the middleware does
  not need two code paths for resolve, only for extraction.

**Negative / accepted**

- Stateful sessions need replication / sticky routing if Bunny2 ever
  moves to a multi-process fleet. Acceptable: the portable
  single-process build is the v1 target; a future durable bus +
  multi-writer move (see overall plan §10) would require a
  cross-process session store regardless of token shape.
- Federation (Bunny2-to-Bunny2 over the bus, overall plan §10) will
  need a separate token-issuance protocol. Logged as a follow-up.

---

## Alternatives considered

1. **Signed JWT** — stateless, but cannot be invalidated cheaply.
   Logout requires either a server-side blacklist (which re-introduces
   the state we were trying to avoid) or a short TTL with refresh
   tokens (which is more moving parts than this project needs).
   Soft-delete revocation becomes "wait for the JWT to expire" — not
   acceptable per plan §11.5.
2. **Encrypted-cookie session store** (e.g. iron-session) — moves all
   state into the cookie. Rotating the server secret invalidates every
   live session at once, and the cookie balloons relative to a 32-byte
   token. No revocation primitive without a server-side state anyway.
3. **Session in LanceDB** — wrong tool. Sessions are exact-match
   lookups by hash, not vector search.

---

## Follow-ups

- 2.3 emits `session.created` and `session.expired` events on the bus
  (the login + logout routes are the producers). The session service
  itself stays bus-agnostic so it can be reused outside HTTP later.
- Federation token format: deferred to the phase that introduces
  cross-instance sync. Logged at
  `docs/dev/follow-ups/federation-session-token.md` if it lands.
- Cookie rotation on privilege change (login after
  `mustChangePassword`, group membership change) — handled in 2.3 /
  2.4 by `revokeAllForUser` + a fresh `createSession`.
