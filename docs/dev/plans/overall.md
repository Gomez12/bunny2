# Overall Plan — Internal Agent Tool ("bunny2")

> Source: `originalplan.md` (Dutch brainstorm).
> Scope of this document: **overall plan only**. Per-phase detail
> plans live next to this file as `phase-XX-*.md`, each referenced
> from `docs/dev/tasklist.md`.

---

## 1. Context

The user wants an internal, self-hosted personal/team assistant that
behaves like a single product to its users (Electron-wrapped web UI),
but is in reality a portable multi-platform server with its own data
directory. The product is **entity-centric** (companies, contacts,
calendar, todos, etc.), **layered** (personal → project → group →
everyone), and **AI-enhanced**: a chat-driven assistant on top of the
entities that is **self-learning and self-healing**, with a user
verification gate before changes become active.

This overall plan exists to:

- Lock in the **vision, principles, and invariants** so phase plans
  cannot drift.
- Define the **phased delivery order** the user already proposed,
  with explicit dependencies between phases.
- Surface the **cross-cutting concerns** (i18n, telemetry,
  versioning, soft-delete, multi-tenant scoping, accessibility) that
  every phase must respect.
- Capture **open questions** so they get answered before phase 1
  detail planning starts.

---

## 2. Vision (one paragraph)

A portable, multi-user, multi-language internal assistant that owns
its data, exposes layered CRUD entities, keeps them in sync with
external systems and with each other through an event-sourced message
bus, and lets users talk to a chat assistant that routes intent, picks
the right entities, answers from real data, and over time proposes
new tools/skills/agents to improve itself — always with a
user-verified gate before activation.

---

## 3. Non-Goals (for v1)

- Cloud-hosted SaaS deployment. Server is portable and local-first.
- PostgreSQL on day one. SQLite first, Postgres is a future option
  (schema must stay compatible).
- Replacing the Electron wrapper with mobile clients.
- Fully autonomous self-modifying agent (phase 8 introduces
  threshold-based automation, but only after phase 7 builds the
  user-verified loop).
- Public API surface for third parties.
- Letting LanceDB ever surface content a user is not authorized to
  see (explicitly called out by user).

---

## 4. Technical Foundation

| Concern             | Choice                                                                                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime / package   | **Bun** (per `AGENTS.md`)                                                                                                                                                                                                                        |
| Language            | **TypeScript** end-to-end                                                                                                                                                                                                                        |
| Backend             | Bun HTTP server                                                                                                                                                                                                                                  |
| Frontend            | Vite + React + Tailwind + shadcn/ui                                                                                                                                                                                                              |
| Desktop wrapper     | Electron — **thin wrapper only**, no business logic                                                                                                                                                                                              |
| Primary DB          | SQLite (file in data-dir), designed for later Postgres                                                                                                                                                                                           |
| Vector DB           | LanceDB (file in data-dir), authorization filter applied **before** retrieval                                                                                                                                                                    |
| Messaging           | Thin internal `MessageBus` (in-memory adapter in phase 1; cross-process / durable transport revisited at phase 5). `bunqueue` was the originally proposed transport; superseded by [ADR 0005](../decisions/0005-event-sourcing-and-bunqueue.md). |
| Scheduler           | Internal scheduler for periodic AI enrichment, retries, translations, self-learning                                                                                                                                                              |
| IDs                 | UUID everywhere (future multi-server federation)                                                                                                                                                                                                 |
| Config              | File next to executable; data-dir co-located, configurable path                                                                                                                                                                                  |
| Multi-platform      | Single portable binary per OS (macOS, Linux, Windows)                                                                                                                                                                                            |
| LLM                 | **OpenAI-compatible interface**, endpoint + api_keys + models all configurable; one default at system level with per-component override                                                                                                          |
| Telemetry / logging | **100% message logging** on every LLM path (prompt, response, tokens, cost, model); stored in primary SQLite; **6-month retention**                                                                                                              |
| Auth                | Username + password (**argon2id**) to start; group-based authorization                                                                                                                                                                           |

---

## 5. Architectural Principles (invariants every phase must keep)

1. **Event-sourced core.** All state changes flow through the message
   bus as events. Read models are projections; the event log is the
   source of truth. This is what makes retries, audit, and the
   self-healing loop possible.
2. **Influenceable flows.** Cross-cutting behavior (logging, AI
   enrichment, translation, telemetry) is registered as flow
   middleware so changing it in one place changes it everywhere.
3. **One bus, no event storms.** The bus must coalesce / debounce /
   schedule so derived work (e.g. translation after edit, calendar
   sync after todo update) does not cascade uncontrollably.
4. **Layered scoping.** Every entity belongs to a layer
   (personal → group → everyone). A layer sees its own entities
   **and** everything in layers above it. Per layer, visibility can
   be declared top-down and/or bottom-up. Per layer you can also
   attach its own agents / skills / MCP servers.
5. **Soft-delete only.** Users and agents see deletes; only admins
   can hard-delete. Soft-delete must propagate through projections
   and vector indexes.
6. **Versioned entities with rich metadata.** Every entity carries
   version history and metadata (created/updated by, source, locale
   of origin, etc.).
7. **Multi-language by design.** Store the **original locale** with
   the content; translate to other configured locales on a schedule;
   only the original-locale field is user-editable (or the user
   re-declares the edit locale). The active locale set per layer is
   a subset of system-allowed locales.
8. **Authorization-aware retrieval.** Vector / semantic search must
   filter on the caller's effective layer/group access **before**
   retrieval, never after. (User's explicit requirement.)
9. **Self-learning with a verification gate (phase 7).** Improvement
   proposals carry: detected problem, proposed fix, expected impact,
   sandbox test evidence. Approval triggers a **re-plan**
   (capabilities may have changed since proposal) before activation.
10. **AI-augmented CRUD.** Entities support manual CRUD, but the
    system is expected to keep them current and enriched via
    scheduled agents, so users do as little CRUD as possible.
11. **External integrations are first-class.** Every entity type may
    have one or more external links (e.g. Google Calendar, KvK) and
    each link has its own sync state.
12. **English for code/docs/keys, i18n keys stable and hierarchical**
    (per `AGENTS.md` §i18n).

---

## 6. Core Domain (target v1+)

**Per-layer entity catalogue** (CRUD + scheduled enrichment +
external sync hooks + soul/memory slice per entity):

Companies, Contacts, Calendar, Todos, Kanban Boards, Workflows,
Whiteboards (Excalidraw), Journal, Diagrams, Documents, File Storage,
Knowledge Base, External News, Scheduled Tasks, Personal Messages
(email / chats archive).

**Per layer:**

- Own agents, skills, MCP servers.
- Own dashboard view summarizing the layer.
- Inherits from layers above.

**Chat assistant (the headline feature, phase 6):**

1. Intent router determines intent.
2. Entity resolver determines target entity types and instances.
3. Retrieval layer fetches data (authorization-filtered).
4. Answerer composes the response.
5. User feedback (thumbs up / thumbs down) is logged. Thumbs down
   may trigger a retry prompt.
6. A Kanban board visualizes the chat agent's working state for the
   user.

**Self-learning loop (phases 7–8):**

- Periodic agent reviews answers + feedback per layer.
- Generates improvement proposals (new tool / improved tool / new
  skill / new agent).
- Proposal includes: what was wrong, what to change, expected user
  and system impact, sandbox evidence.
- Phase 7: every proposal needs user approval; on approval the
  system re-evaluates current capabilities and rebuilds the plan
  before activating.
- Phase 8: proposals above a configurable confidence/impact
  threshold may activate without per-item approval (threshold is
  already wired in phase 7).

---

## 7. Cross-Cutting Concerns

| Concern       | Rule                                                                                                                                                                                        |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| i18n          | No hardcoded user-facing strings. Stable hierarchical keys. Original-locale tracked per record.                                                                                             |
| Telemetry     | Every LLM call logs prompt, response, model, tokens in + out, cost, latency, layer, user, flow id.                                                                                          |
| Auth          | Group-based. A user is in 0..N groups. Groups can be grouped (system / project / …). On install, seed `admin` group + `admin` user with password `change_me`, forced change on first login. |
| Soft delete   | `deleted_at` + `deleted_by`; projections + LanceDB respect it; admin-only hard delete.                                                                                                      |
| Versioning    | Every entity has a version chain + metadata.                                                                                                                                                |
| UUIDs         | Everywhere, for future federation.                                                                                                                                                          |
| Accessibility | Keyboard, focus, semantic HTML, labels (per `AGENTS.md`).                                                                                                                                   |
| Security      | Validate inputs, no secrets in logs, no client-only checks, vector retrieval is auth-aware.                                                                                                 |
| Docs          | Each phase updates `docs/dev/architecture/`, `docs/dev/plans/`, `docs/user/` where user-visible.                                                                                            |
| Tasklist      | Each phase has at least one tasklist entry referencing its plan doc.                                                                                                                        |

---

## 8. Phased Delivery (the spine of the project)

Each phase has its own future detailed plan document. This overall
plan only fixes the **order**, **goal per phase**, and
**exit-criteria** so phase plans stay aligned.

### Phase 1 — System foundation

- Bun server + Vite frontend + Electron wrapper skeleton.
- Portable build per OS, with config + data-dir.
- SQLite + LanceDB initialized in data-dir.
- Message bus + event log + minimal flow middleware.
- One configured LLM + per-call override mechanism.
- 100% LLM message logging.
- Minimal UI: status / "is alive" dashboard + a simple chat box that
  round-trips through the bus to the LLM and back, just to prove the
  pipeline end-to-end.
- **Exit:** a developer can install the portable build, see the UI,
  send a chat message, and find the full prompt/response in the log.
- **Status (as of 2026-05-23):** sub-phases 1.1–1.5 and 1.7 are
  `done`; 1.6 (Electron + per-OS portable build) is `needs-testing`
  on Linux/Windows. The CI matrix
  (`.github/workflows/release.yml`) is the verification path. See
  the close-out walkthrough in `phase-01-system-foundation.md` §14.

### Phase 2 — Users & groups

- Username/password auth.
- Group CRUD, user-in-group CRUD, group-of-groups.
- Seeded `admin` group + `admin` user with forced password change.
- Sessions; everything from here on is auth-gated.
- **Exit:** multiple users can log in, admin can manage groups.

### Phase 3 — Layers

- Layer CRUD (personal / project / group / everyone).
- Per-layer visibility rules (top-down, bottom-up, both).
- Per-layer attachment points for agents / skills / MCP servers
  (registration only; consumers come in later phases).
- Per-layer locale subset selection from system locales.
- Per-layer dashboard shell (empty widgets, filled in later phases).
- **Exit:** users can navigate layers and see scope context everywhere.

### Phase 4 — First entities (sub-phased, one entity at a time)

For each entity, the sub-phases are:

1. CRUD + versioning + soft delete + i18n + UUIDs.
2. External-link adapter pattern + at least one concrete connector.
3. Scheduled AI enrichment + scheduled translation.
4. Dashboard widget on the layer dashboard.

Phase-4 entity order (rest deferred to "later"):

4a. Companies
4b. Contacts
4c. Calendar
4d. Todos

Cross-entity sync — e.g. todo-with-due-date showing on calendar —
is delivered as part of 4c / 4d.

### Phase 5 — General scheduled tasks

- Generic scheduler UI + storage.
- Visibility per layer.
- Retry/backoff using event-sourced re-emission.
- **Exit:** non-entity scheduled jobs (digests, sweeps, health
  checks) can be defined and observed.

### Phase 6 — Super chat

- Intent router → entity resolver → retrieval → answerer pipeline.
- Auth-aware retrieval (including LanceDB filter).
- Thumbs up / thumbs down feedback capture.
- Chat-state Kanban visualization.
- Multi-message context per layer.
- **Exit:** the "wanneer heb ik de ontmoeting met 2ba"-class question
  is answered correctly from real entity data.

### Phase 7 — Self-learning, user-verified

- Per-layer scheduled review agent over feedback.
- Improvement proposals (problem, fix, impact, sandbox evidence).
- Proposal list UI with impact filter.
- Approval re-plans against current capabilities before building.
- Tool / skill / agent builder used by the loop.
- Threshold field already present on proposals (consumed in phase 8).
- **Exit:** at least one human-approved improvement makes it from
  proposal → sandbox → activation, and the chat can now use it.

### Phase 8 — Self-learning, threshold-automated

- Above-threshold proposals activate without per-item approval, with
  full audit trail and easy rollback.
- Tunable per layer.
- **Exit:** thresholded automation runs safely for a week with zero
  rollbacks needed in dogfood use.

### Later

- Remaining entities from §6.
- Postgres backend option.
- Federation between servers (UUIDs already in place).

---

## 9. Risks (initial — each will get a doc in `docs/dev/risks/`)

| Risk                                          | Likelihood | Impact | Initial mitigation                                                                        |
| --------------------------------------------- | ---------- | -----: | ----------------------------------------------------------------------------------------- |
| LanceDB leaks content across layers           | Med        |   High | Auth filter applied pre-retrieval; layer-tagged embeddings; tests for cross-layer queries |
| Event-bus storms when AI enrichment cascades  | Med        |    Med | Coalescing + debouncing + per-flow rate limits                                            |
| Token cost blowup from per-component LLMs     | Med        |    Med | 100% logging + per-layer budget + alerts                                                  |
| Self-learning loop ships a regression         | Med        |   High | User-verified gate (phase 7) + sandbox evidence + easy rollback in phase 8                |
| Electron wrapper accumulates logic            | Med        |    Med | "Wrapper only" rule documented and code-reviewed                                          |
| Translation drift between locales after edits | Med        |    Med | Original-locale flag + scheduled re-translation                                           |
| SQLite → Postgres migration pain              | Low        |    Med | Avoid SQLite-only SQL; integration test suite                                             |

---

## 10. Decisions (answered open questions)

1. **Message bus** → thin internal `MessageBus` interface. Phase 1.3
   shipped an in-memory adapter; a cross-process / durable transport
   is revisited at phase 5 (general scheduled tasks) when retries,
   cron, and DLQ semantics earn their keep. `bunqueue` was the
   originally proposed transport; the phase 1.3 fit-check found it is
   a job queue, not a pub/sub event bus with a middleware hook, and
   carries deps unrelated to phase 1 (MCP SDK, zod-4) — superseded by
   [ADR 0005](../decisions/0005-event-sourcing-and-bunqueue.md). The
   adapter-shaped interface keeps any future transport additive.
2. **LLM provider** → **OpenAI-compatible API**. Endpoint, api_keys,
   and model names are all configurable. One default LLM config at
   system level, per-component overrides everywhere. Any provider
   that exposes an OpenAI-compatible endpoint (incl. local
   Ollama/llama.cpp/vLLM) works without code changes.
3. **Auth password storage** → **argon2id**.
4. **Telemetry storage** → same SQLite as primary data. Retention =
   **6 months**, enforced by a scheduled prune job.
5. **Excalidraw + Kanban** → use **existing OSS components**.
   Picks confirmed in each entity's phase plan; do not build bespoke.
6. **Electron update channel** → **deferred** past v1. Manual
   re-install for now.
7. **Original-locale field** → **per record**, not per field.
8. **Dashboard layout** → **user-arrangeable** per layer. Layout
   stored per user × layer.

---

## 11. Documentation Outputs This Plan Triggers

When phase plans start landing, the following docs should appear
alongside them:

- `docs/dev/architecture/overview.md` ← realised architecture per
  phase.
- `docs/dev/architecture/event-bus.md`.
- `docs/dev/architecture/layers-and-auth.md`.
- `docs/dev/architecture/llm-and-telemetry.md`.
- `docs/dev/architecture/i18n.md`.
- `docs/dev/decisions/` ADRs for: SQLite-first, LanceDB choice,
  Electron-as-wrapper, event sourcing.
- `docs/dev/risks/` one file per row in §9.
- `docs/user/guides/getting-started.md` once phase 1 is shippable.

---

## 12. Verification (how we know this overall plan is "good enough")

This overall plan is verified by being able to answer **yes** to:

- Can a reader, knowing nothing else, explain the product and its
  shape in 5 minutes? — §1, §2, §6.
- Can a phase-1 detail plan be written from this without re-deciding
  vision or stack? — §4, §5, §8 (phase 1).
- Are the invariants explicit enough that a later phase can't
  quietly break them (e.g. someone shipping un-authorized
  retrieval)? — §5, §7.
- Are the deferred items clearly out of scope so phase plans don't
  drag them in? — §3, §8 ("Later").

Concrete next step: write
`docs/dev/plans/phase-01-system-foundation.md` using the decisions in
§10.
