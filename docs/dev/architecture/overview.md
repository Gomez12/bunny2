# Architecture overview

> Status: living document.
> Owners: phase-1.7 introduced this as the final close-out doc; later
> phases extend it.

This is the single-page tour of bunny2's spine — config → data-dir →
SQLite + LanceDB → bus + event log → LLM client + telemetry → HTTP
API → renderer → Electron wrapper. Each subsection links to the deeper
document that owns the topic. If you only have five minutes, read this
file; if you have an hour, follow the links.

---

## 1. What the spine looks like

```
                +----------------------------------+
                |  Electron main (apps/desktop)    |
                |  - window + sidecar lifecycle    |
                |  - per-OS data-dir resolution    |
                +----------------+-----------------+
                                 |
                  spawns         | reads userData/config.json,
                  Bun process    | passes BUNNY2_DATA_DIR/PORT
                                 v
+----------------------------------------------------------------+
|  Bun server (apps/server)                                      |
|                                                                |
|  Config (zod schema, file + env)                               |
|    └── Data-dir bootstrap                                      |
|          ├── SQLite (bun:sqlite)                               |
|          │     ├── schema_migrations                           |
|          │     ├── events       (bus event log)                |
|          │     ├── llm_calls    (100% LLM telemetry)           |
|          │     └── kv_meta                                     |
|          └── LanceDB (empty scaffolding in phase 1)            |
|                                                                |
|  MessageBus (packages/bus, in-memory adapter)                  |
|    ├── correlationIdMiddleware                                 |
|    ├── telemetryMiddleware → events table                      |
|    └── errorCaptureMiddleware                                  |
|                                                                |
|  LLM client (apps/server/src/llm)                              |
|    ├── mock://  provider  (deterministic, tests + dev default) |
|    └── http(s)  provider  (OpenAI-compatible)                  |
|         └── wrapped by withTelemetry → llm_calls table         |
|                                                                |
|  HTTP API (Hono on Bun.serve)                                  |
|    ├── CORS (dev allowlist)                                    |
|    ├── Auth middleware (opaque session, cookie + Bearer)       |
|    ├── GET  /status   (public)                                 |
|    └── POST /chat     (auth-gated from 2.2)                    |
+----------------------------------------------------------------+
                                 ^
                                 | HTTP (CORS-allowlisted in dev)
                                 |
                +----------------+-----------------+
                |  Vite + React renderer (apps/web)|
                |  - i18n (i18next), Tailwind,     |
                |    shadcn/ui                     |
                |  - Status page, single-turn chat |
                +----------------------------------+
```

Single-process, single-writer. No IPC channel — the renderer and the
sidecar talk **only** over HTTP, which keeps Electron a thin wrapper
(ADR 0004).

---

## 2. Layer by layer

### 2.1 Config + data-dir

- Code: `apps/server/src/config/`.
- Schema: zod (`AppConfigSchema`) is authoritative; TS types are
  `z.infer<...>`.
- Resolution order for data-dir: `BUNNY2_DATA_DIR` env > `config.json`
  value > default `./.data`. `BUNNY2_CONFIG` env can point to an
  alternate config file. HTTP host/port have analogous env overrides.
- The data-dir is created on first run; everything else (SQLite,
  LanceDB) lives inside it.
- Deep dive: `docs/dev/setup/installation.md` and
  `docs/dev/architecture/packaging.md` (per-OS data-dir paths).

### 2.2 SQLite

- Code: `apps/server/src/storage/sqlite.ts` +
  `apps/server/src/storage/migrations/*.sql`.
- Driver: `bun:sqlite` (built into Bun). See [ADR 0002](../decisions/0002-sqlite-first-postgres-later.md).
- Migrations: hand-rolled SQL files + a tiny runner. The applied id is
  the filename without `.sql`; `/status` reports the latest as
  `sqlite.schemaVersion`.
- Tables in phase 1: `events`, `llm_calls`, `schema_migrations`,
  `kv_meta`.
- Postgres portability rules (no SQLite-only SQL, UUIDs as TEXT, ISO
  timestamps, foreign keys on, WAL mode) — see ADR 0002 §Schema rules.

### 2.3 LanceDB

- Code: `apps/server/src/storage/lancedb.ts`.
- Phase 1 ships **empty**; only the connection bootstrap runs. See
  [ADR 0003](../decisions/0003-lancedb.md).
- The overall plan invariant (`overall.md` §5.8) requires
  authorization-aware retrieval. Phase 4+ adds the first real table
  and an `auth_tag` column to enforce this pre-search.

### 2.4 Message bus + event log

- Code: `packages/bus/` (interface + in-memory adapter) +
  `apps/server/src/bus/event-log.ts` (SQLite writer).
- Adapter: in-memory only in phase 1. Bunqueue was the originally
  proposed transport and was rejected after a fit-check —
  [ADR 0005](../decisions/0005-event-sourcing-and-bunqueue.md).
- Middleware chain (outer→inner): correlation id → telemetry (writes
  to `events` before dispatch) → error capture → handler dispatch.
- Replay: `bun run replay` (`scripts/replay.ts`) re-emits the log to a
  fresh subscriber set — proves event sourcing is real.
- Deep dive: `docs/dev/architecture/event-bus.md`.

### 2.5 LLM client + telemetry

- Code: `apps/server/src/llm/`.
- One interface (`LlmClient.chat`), two providers (`mock://`,
  OpenAI-compatible HTTP). The endpoint URL scheme picks the provider.
- `withTelemetry(client, { log, pricing })` writes one row to
  `llm_calls` per call — success or failure. Cost is computed from
  `tokensIn`/`tokensOut` against a per-model pricing map; redacted
  payloads land in the DB.
- Retention: a daily prune job removes rows older than
  `config.llm.retentionDays` (default 180).
- Deep dive: `docs/dev/architecture/llm-and-telemetry.md`.

### 2.6 HTTP API

- Code: `apps/server/src/http/`.
- Router: Hono on Bun. See [ADR 0006](../decisions/0006-http-router-choice.md).
- Endpoints (phase 1): `GET /status`, `POST /chat`.
- Endpoints (phase 2.3 onward): `POST /auth/login`, `POST /auth/logout`,
  `GET /auth/me`, `POST /auth/password`.
- The factory shape (`createApp(deps)`) returns a Hono app and lets
  tests run the full pipeline in-process via `app.fetch(req)` — that
  is exactly what the smoke test and the chat tests do.
- CORS: dev-only allowlist for `localhost`/`127.0.0.1`/`null` (Electron
  `file://`); see ADR 0006 §CORS.
- Auth (from phase 2.2): every route is gated by `createAuthMiddleware`
  except a small public whitelist (`GET /status`, `POST /auth/login`,
  `POST /auth/logout`, and any CORS preflight). The middleware reads an
  opaque session token from `Authorization: Bearer` or the
  `bunny2_session` HttpOnly cookie, validates it through the session
  service, and attaches `c.var.session` + `c.var.user`. See
  [ADR 0008](../decisions/0008-session-strategy.md).
- Password-rotation gate (from phase 2.3): a second middleware
  (`requirePasswordCurrent`) runs after auth and returns
  `409 errors.auth.mustChangePassword` on every protected route
  except `POST /auth/password` and `POST /auth/logout` when the
  signed-in user still needs to rotate (e.g. the seeded admin on
  first login). Full narrative in
  [`auth-and-sessions.md`](./auth-and-sessions.md).
- Admin bootstrap (from phase 2.3): on first start against a fresh
  data-dir, `apps/server/src/auth/seed.ts` creates the `admin` group
  and the `admin` user, prints the initial password to stdout
  exactly once, and stamps `kv_meta.admin_seed_done = 'true'`. The
  seed runs before `Bun.serve` accepts the first request, and is
  idempotent on every subsequent boot.
- Group resolver + admin gate (from phase 2.4): a transitive group
  resolver (`apps/server/src/auth/group-resolver.ts`) lives on the
  request path. It answers "is user U transitively in group G?" via
  recursive-CTE walks of `user_group_memberships` and
  `group_group_memberships`, with an in-memory cache invalidated by
  bus subscribers on `group.*` and `user.*` events. The
  `requireAdmin` middleware
  (`apps/server/src/http/middleware/admin.ts`) is mounted on the
  `/admin/*` prefix and uses the resolver to gate the admin-group
  CRUD endpoints; `/auth/me.isAdmin` uses the same resolver so the
  answer is consistent across the gate and the client-facing flag.
- Admin user CRUD + forced password reset (from phase 2.5): the
  `/admin/users/*` routes
  (`apps/server/src/http/routes/admin-users.ts`) expose list, detail,
  create, patch, soft-delete and `reset-password` endpoints. They
  inherit auth + the password gate + `requireAdmin`. A "last
  administrator" safety net is enforced by the same pure-arithmetic
  guard on PATCH and DELETE (see `auth-and-sessions.md` §10), the
  seeded admin user is permanent (404 masking), and admins are
  forbidden from resetting their own password through this surface
  (they must use `POST /auth/password`). Sessions of a deleted or
  reset-target user are revoked through the session service, which
  publishes `session.expired { reason }` per killed row.

### 2.7 Renderer

- Code: `apps/web/`.
- Stack: Vite + React + Tailwind + shadcn/ui + i18next.
- Phase 1.5 shipped two screens: status page (status data from
  `/status`) and a single-turn chat box (posts to `/chat`). Phase 2.6
  adds a routing-less app shell with login, forced-password-change, a
  user-menu chip, and admin Users / Groups pages (only visible to
  members of the `admin` group). Top-level state lives in
  `apps/web/src/lib/session.ts`; pages live under `apps/web/src/pages/`
  and `…/pages/admin/`. See
  [`auth-and-sessions.md`](./auth-and-sessions.md) §11.
- API base URL: in Electron, the preload exposes
  `window.bunny2.apiBase` (ADR 0004 §5); in dev, `VITE_API_BASE` from
  Vite env; otherwise the schema default `http://127.0.0.1:4317`.
- All visible strings come from i18n keys. Missing-key + hardcoded-
  string enforcement is in `bun run i18n:check`.
- Deep dive: `docs/dev/architecture/i18n.md`.

### 2.8 Electron wrapper

- Code: `apps/desktop/src/`.
- Owns: window, sidecar lifecycle, per-OS data-dir resolution, first-
  run config seed. Nothing else.
- Server source never imports Electron. The renderer never reads disk
  directly. See [ADR 0004](../decisions/0004-electron-as-thin-wrapper.md).
- Deep dive: `docs/dev/architecture/packaging.md`.

---

## 3. Cross-cutting concerns

### 3.1 Correlation across stores

Every chat request mints a `correlationId` and a `flowId`. Both are
propagated to:

- `events` rows for `chat.requested`, `chat.responded` /
  `chat.failed`.
- `llm_calls` row for the LLM call.
- The HTTP response body (`correlationId`) so the frontend can show /
  log it.

This makes any post-hoc investigation a `JOIN` on `correlation_id`.

### 3.2 Errors

The HTTP layer returns localized error **keys** (e.g.
`errors.chat.upstream`), not English sentences. The renderer resolves
the key in the user's locale. `AGENTS.md` §Errors forbids leaking
stack traces, secrets, or internal details to the user.

### 3.3 Tests

- `bun test` is the single test runner.
- The smoke test (`apps/server/tests/smoke.test.ts`) is the phase-1
  spine test — it exercises every layer above.
- Unit + integration tests live next to their target.

### 3.4 Build artifacts

- Server: `bun build --target=bun --outdir=...` produces an `index.js`
  - a native LanceDB `.node` next to it.
- Renderer: `vite build` produces a Vite-classic static bundle.
- Electron main+preload: `tsc -p .` → `apps/desktop/dist/`.
- Portable artifact: `electron-builder` wraps everything plus a
  vendored Bun runtime; see `docs/dev/architecture/packaging.md`.

---

## 4. What's not here yet

Phase 1 deliberately ships the foundation only. The following are
phase-2+ deliverables:

- Authentication, sessions, users, groups (phase 2).
- Layers (personal / project / group / everyone) and per-layer
  scoping (phase 3).
- Entities (Companies, Contacts, Calendar, Todos) and the dashboard
  shell (phase 4).
- Scheduled tasks UI + retry/backoff (phase 5).
- Super chat (intent router → entity resolver → retrieval → answerer)
  with auth-aware LanceDB retrieval (phase 6).
- Self-learning loop, user-verified then threshold-automated
  (phases 7–8).

See `docs/dev/plans/overall.md` §8 for the full phased roadmap.

---

## 5. Related docs

- `docs/dev/setup/installation.md` — prerequisites + install.
- `docs/dev/setup/running.md` — scripts + dev modes.
- `docs/dev/architecture/event-bus.md` — bus / middleware / replay.
- `docs/dev/architecture/llm-and-telemetry.md` — LLM client +
  telemetry + retention.
- `docs/dev/architecture/i18n.md` — i18n pipeline + enforcement.
- `docs/dev/architecture/packaging.md` — build pipeline + per-OS
  data-dir paths.
- `docs/dev/testing/phase-01-electron-manual.md` — manual per-OS
  checklist for the packaged Electron path.
- `docs/dev/decisions/0001`–`0006` — the foundational ADRs.
- `docs/user/guides/getting-started.md` — end-user-facing
  walkthrough.
