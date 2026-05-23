# Phase 1 — System Foundation

> Parent: [`overall.md`](./overall.md) §8 Phase 1.
> Scope of this document: **detailed plan for phase 1 only**.
> All decisions inherit from `overall.md` §4, §5, §7, §10.

---

## 1. Goal

Stand up the smallest end-to-end skeleton of the product, so a
developer can:

1. Install the portable build for their OS.
2. Open the Electron-wrapped UI.
3. Send a chat message.
4. See the response.
5. Find the full prompt/response/token record in telemetry.

Phase 1 is **not** about features. It is about proving the spine:
config + data-dir → SQLite + LanceDB → bunqueue + event log → LLM
client with full telemetry → HTTP API → Vite UI → Electron wrapper →
portable per-OS build.

Once phase 1 lands, every later phase plugs into a working pipeline
and never has to re-invent foundation.

---

## 2. Scope

In scope:

- Repo skeleton (monorepo of `server`, `web`, `desktop`, `shared`).
- Bun + TypeScript + lint/format/typecheck/test scripts.
- Config loader (file beside executable, env overrides).
- Data-dir bootstrap (created on first run, schema-versioned).
- SQLite driver + migrations runner + base tables
  (`events`, `llm_calls`, `kv_meta`).
- LanceDB initialization in data-dir (empty, scaffolding only).
- `bunqueue` integration behind a thin internal `MessageBus`
  interface, with event-log persistence + middleware chain.
- Flow middleware: telemetry, error capture, correlation id.
- LLM client (OpenAI-compatible) with configurable endpoint, keys,
  default model, and per-call override; **100% logging** of every
  call to `llm_calls`.
- HTTP API skeleton with two endpoints: `GET /status`, `POST /chat`.
- Vite + React + Tailwind + shadcn/ui frontend with:
  - i18n bootstrap (English base, key namespace conventions).
  - Status page ("is alive" + config + data-dir + DB versions).
  - Single-turn chat box (no history persistence yet).
- Electron wrapper that loads the built web UI and spawns the Bun
  server as a sidecar process.
- Portable build pipeline producing per-OS executables + sample
  config + empty data-dir.
- Smoke test that exercises the full round-trip.
- Initial dev docs: setup, architecture overview, run, build.

Out of scope (deferred to their own phases):

- Users, auth, groups (phase 2).
- Layers, per-layer agents/skills/MCP (phase 3).
- Entities, dashboards, sync (phase 4+).
- Multi-turn chat history, intent routing, retrieval (phase 6).
- Self-learning loop (phases 7–8).
- Electron auto-update channel (deferred per `overall.md` §10.6).

---

## 3. Non-Goals (phase 1)

- Production-grade observability (a structured log file + the
  `llm_calls` table is enough).
- Performance tuning.
- Optimised bundle size.
- Localisation beyond an English base + a placeholder second locale
  to prove the i18n pipeline works.
- Real LLM provider selection — the OpenAI-compatible client should
  work against OpenAI, a local Ollama, and a mock server. Phase 1
  ships with **mock + OpenAI-compatible**, no provider-specific code.
- Building the agent / skill / MCP infrastructure. Phase 1 only
  proves the bus and the LLM call.

---

## 4. Approach

### 4.1 Repo layout (monorepo)

```txt
.
├── apps/
│   ├── server/        # Bun HTTP + bus + DB + LLM
│   ├── web/           # Vite + React UI
│   └── desktop/       # Electron wrapper
├── packages/
│   ├── shared/        # Cross-cutting types, schemas, i18n keys
│   └── bus/           # MessageBus interface + bunqueue adapter
├── docs/
├── scripts/           # build, package, migrate, seed
└── …
```

Bun workspaces, single `tsconfig` base extended per package, one
shared `eslint` + `prettier` config.

### 4.2 Sub-phases (delivery order within phase 1)

Each sub-phase is one PR (or small set of PRs) and gets its own
tasklist row.

**1.1 — Repo + tooling**
Bun workspaces, TypeScript, lint, format, typecheck, test runner,
CI baseline that runs the recommended checks from `AGENTS.md`
§Pull Requests. Hello-world server + hello-world web + hello-world
Electron exist and start.

**1.2 — Config + data-dir + storage bootstrap**
Config loader (file path resolution, env overrides, validation with
zod), data-dir auto-create, SQLite driver + migrations runner +
initial migration creating `events`, `llm_calls`, `kv_meta` tables.
LanceDB initialized in data-dir (empty, with a hidden "auth_tag"
schema field reserved for layer scoping later).
Status endpoint reports versions of: app, schema, LanceDB.

**1.3 — Bus + event log + flow middleware**
`MessageBus` interface in `packages/bus` with two implementations:
the bunqueue-backed one and an in-memory test double.
Every published event is persisted to `events` (id UUID, type,
payload JSON, occurred_at, correlation_id, flow_id). Middleware
chain supports: correlation id injection, telemetry, error capture.
A replay command (`bun run replay`) can re-emit events from the log
to a fresh subscriber — proves event sourcing is real.

**1.4 — LLM client with 100% logging**
`LlmClient` with OpenAI-compatible request shape. Config:
`{ endpoint, apiKey, defaultModel, models: Record<string, ModelCfg> }`.
Every call is wrapped by middleware that writes a row to `llm_calls`
with: request payload, response payload, model, tokens in/out, cost
estimate, latency ms, correlation id, flow id, started_at, ended_at,
error if any. Includes a `mock://` provider for tests and CI.
Telemetry retention prune job scheduled (6-month window) — runs on
startup and daily.

**1.5 — HTTP API + frontend skeleton + chat round-trip**
HTTP server (Bun.serve + lightweight router; pick Hono or hand-roll
during 1.5 implementation, documented in an ADR).
Endpoints: `GET /status`, `POST /chat { message, model? }`.
`POST /chat` publishes a `chat.requested` event, the chat handler
calls the LLM, publishes `chat.responded`, and returns the response.
Web app: Tailwind + shadcn/ui, i18n via i18next + react-i18next with
English base and a placeholder `nl` locale, status page, single-turn
chat box. All strings come from i18n keys; no hardcoded user text.

**1.6 — Electron wrapper + portable build**
Electron app loads the built web bundle. The Bun server is spawned
as a sidecar child process with config + data-dir paths injected.
Packaging produces per-OS portable artifacts (macOS, Linux, Windows)
each containing: app executable, sample config, empty data-dir.
Single `bun run package` script.

**1.7 — End-to-end smoke test + docs**
Automated smoke test (Playwright or Bun's test runner driving HTTP):
launches the server in a temp data-dir against a mock LLM, hits
`/status`, hits `/chat`, asserts the `llm_calls` row exists.
Manual checklist in `docs/dev/testing/phase-01-smoke.md` for the
Electron-wrapped path on each OS.
Dev docs written: `docs/dev/setup/`, `docs/dev/architecture/overview.md`,
`docs/dev/architecture/event-bus.md`, `docs/dev/architecture/llm-and-telemetry.md`,
`docs/dev/architecture/i18n.md`, plus user-facing
`docs/user/guides/getting-started.md`.

---

## 5. Affected Modules

| Module                 | What changes                                                                      |
| ---------------------- | --------------------------------------------------------------------------------- |
| `apps/server`          | Bun HTTP + routes + handlers + startup wiring                                     |
| `apps/web`             | Vite + React + Tailwind + shadcn/ui + i18n + status + chat                        |
| `apps/desktop`         | Electron main + preload + packaging config                                        |
| `packages/shared`      | Zod schemas (config, events, LLM payloads), i18n key constants                    |
| `packages/bus`         | `MessageBus` interface, bunqueue adapter, in-memory test double, middleware types |
| `scripts/`             | `migrate`, `replay`, `package`, `dev`                                             |
| `docs/dev/*`           | Architecture overview, setup, testing notes, ADRs                                 |
| `docs/user/guides/`    | `getting-started.md`                                                              |
| `docs/dev/tasklist.md` | One row per sub-phase (1.1 … 1.7)                                                 |

---

## 6. Tests

- **Unit:** config loader, migrations runner, `MessageBus` adapter
  contract test (run against both bunqueue and in-memory),
  `LlmClient` (against `mock://`), telemetry middleware writes the
  expected row shape, prune job removes only rows older than 6
  months.
- **Integration:** server startup populates data-dir, `POST /chat`
  produces one `chat.requested`, one `llm_calls`, one
  `chat.responded` (assert via direct DB read), replay command
  re-emits to a fresh subscriber in the same order.
- **Component (web):** status page renders backend data, chat box
  posts and shows response, all visible text comes from i18n keys
  (assert no hardcoded strings via a lint rule or test).
- **i18n:** missing-key test fails the build (per `AGENTS.md`).
- **Accessibility:** chat box keyboard-navigable, status page passes
  axe-core on default render.
- **Smoke (e2e):** full round-trip against mock LLM as described in
  1.7.

---

## 7. Docs Impact

New docs:

- `docs/dev/setup/installation.md`
- `docs/dev/setup/running.md`
- `docs/dev/architecture/overview.md`
- `docs/dev/architecture/event-bus.md`
- `docs/dev/architecture/llm-and-telemetry.md`
- `docs/dev/architecture/i18n.md`
- `docs/dev/testing/phase-01-smoke.md`
- `docs/dev/decisions/0001-bun-and-typescript.md`
- `docs/dev/decisions/0002-sqlite-first-postgres-later.md`
- `docs/dev/decisions/0003-lancedb.md`
- `docs/dev/decisions/0004-electron-as-thin-wrapper.md`
- `docs/dev/decisions/0005-event-sourcing-and-bunqueue.md`
- `docs/dev/decisions/0006-http-router-choice.md`
  (Hono vs hand-rolled — picked during 1.5)
- `docs/user/guides/getting-started.md`

Update `docs/dev/tasklist.md` after each sub-phase.

---

## 8. i18n Impact

- Set up `i18next` + `react-i18next`.
- Establish key namespaces:
  `status.*`, `chat.*`, `common.*`, `errors.*`.
- English (`en`) is base. Add `nl` as a placeholder to prove the
  pipeline (even if mostly stub).
- Missing-key check wired into `bun run i18n:check`.
- No hardcoded user-facing strings — enforced by ESLint rule
  (`react/jsx-no-literals` with allowlist, or a custom rule).

---

## 9. Accessibility Impact

Phase 1 only ships two screens, but both must:

- Use semantic HTML (`<main>`, `<form>`, `<button>`, labels for
  inputs).
- Be fully keyboard-navigable with visible focus rings.
- Pass axe-core with zero violations on default render.
- Use shadcn/ui defaults (already accessible) rather than custom
  primitives.

Document the baseline accessibility expectations in
`docs/dev/styleguide/accessibility.md` so later phases inherit them.

---

## 10. Risks (phase 1 specific)

| Risk                                                         | Likelihood | Impact | Mitigation                                                                                                                                     |
| ------------------------------------------------------------ | ---------- | -----: | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `bunqueue` lacks event-log persistence / middleware / replay | Med        |   High | Thin `MessageBus` interface; phase 1.3 includes a fit-check spike before integration, plus the in-memory implementation as a backstop          |
| LanceDB Bun support is rough on one or more OSes             | Med        |    Med | Initialize behind a feature wrapper; if blocked, defer LanceDB **schema scaffolding only** to phase 4 (still listed as risk, not as deferral)  |
| Electron + Bun sidecar packaging breaks on Windows           | Med        |    Med | Spike on Windows during 1.6; document workaround or fall back to bundling Bun runtime alongside the executable                                 |
| Telemetry table grows fast even before features              | Low        |    Med | 6-month prune job (decision §10.4) + indices on `started_at`                                                                                   |
| 100% LLM logging leaks secrets into DB                       | Med        |   High | Redaction middleware before insert: drop known secret keys + mask values matching obvious patterns; opt-in raw-mode behind dev-only flag       |
| OpenAI-compatible abstraction leaks provider-specific quirks | Med        |    Med | Stick to documented OpenAI Chat Completions shape; add provider matrix test against mock + at least one real local endpoint before phase close |

---

## 11. Open Questions (phase 1)

1. **HTTP router**: Hono on Bun, or hand-rolled with `Bun.serve`?
   Decide in sub-phase 1.5, write ADR `0006`.
2. **SQLite driver**: `bun:sqlite` (built-in) vs `better-sqlite3`
   (more mature, requires Node compat shim). Lean `bun:sqlite`
   unless missing feature blocks us.
3. **Migrations tooling**: hand-rolled SQL files + a small runner,
   or `drizzle` / `kysely` with migrations? Lean hand-rolled for
   phase 1 to avoid early lock-in to an ORM; revisit at phase 4
   when entity CRUD lands.
4. **Cost estimation**: how do we estimate cost without per-model
   price tables? Decision: store `tokens_in`, `tokens_out`, and
   `model`; compute cost on read using a small JSON pricing config
   that the user can edit. Mark uncertain values explicitly.
5. **Mock LLM shape**: deterministic echo vs scripted scenarios?
   Start with deterministic echo; add scripted mode if smoke tests
   need it.

---

## 12. Definition of Done (phase 1)

Per `AGENTS.md` §Done Means Done, plus phase-specific:

- All sub-phase tasklist rows are `done`.
- `bun install && bun run dev` brings up server + web for a fresh
  clone on macOS, Linux, Windows.
- `bun run package` produces working portable artifacts for all
  three OSes (CI matrix builds them; manual sanity check per OS
  logged in `docs/dev/testing/phase-01-smoke.md`).
- Round-trip chat against the mock LLM works in the Electron app on
  the developer's primary OS, with a `llm_calls` row visible after
  the call.
- All checks pass: `format:check`, `lint`, `typecheck`, `test`,
  `build`, `docs:check`, `i18n:check`.
- All ADRs listed in §7 exist.
- `overall.md` and this file remain accurate; if reality diverged,
  update both before marking phase 1 done.

---

## 13. Concrete Next Step

Open `docs/dev/tasklist.md`, add the sub-phase rows (1.1 → 1.7) as
`open`, then start sub-phase **1.1 — Repo + tooling**.
