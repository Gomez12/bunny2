# Phase 4 — First Entities (Companies, Contacts, Calendar, Todos)

> Parent: [`overall.md`](./overall.md) §8 Phase 4.
> Scope of this document: **detailed plan for phase 4 only**.
> Inherits from `overall.md` §4 (stack), §5 (event-sourced core,
> soft-delete, **versioned entities**, **layered scoping**,
> auth-aware retrieval, **multi-language**, AI-augmented CRUD,
> external integrations are first-class), §10.
> Builds on phase 3 ([`done/phase-03-layers.md`](./done/phase-03-layers.md))
> — every entity is born inside a layer, every read goes through
> `c.var.effectiveLayers`, every mutation publishes a bus event.

---

## 1. Goal

Introduce the first four user-facing **entities** of the product —
companies, contacts, calendar, todos — on top of a **single,
generalized Entity contract**. From phase 4 onward:

- Every entity kind in the catalogue (§ `overall.md` §6) is born
  inside a layer, soft-deletable, versioned, translatable, and
  syncable with external systems through a uniform connector API.
- The phase-6 chat agent (and any future cross-entity flow) talks
  to a single `EntityStore` interface. It can ask "what's visible
  in this layer?" / "search across all kinds" / "read this one
  entity" without knowing about companies vs. contacts vs. todos.
- Adding a new entity kind later (Kanban, Workflows, Whiteboards,
  Journal, Diagrams, Documents, …) means **registering an
  `EntityModule`**, not rewriting routers / agent / scheduler /
  translator / dashboard.

After phase 4 a developer should be able to:

1. Log in, open `/l/<slug>/companies`, create "AMI BV", paste a
   KvK number, see scheduled enrichment fill in legal name +
   address.
2. Open `/l/<slug>/contacts`, import a vCard, link a contact to
   AMI BV via the AI-suggested company.
3. Open `/l/<slug>/calendar`, OAuth into Google Calendar,
   see events sync in. Open a meeting, see attendees auto-linked
   to contacts.
4. Open `/l/<slug>/todos`, create "Bel AMI BV terug, due Friday",
   then switch to `/l/<slug>/calendar` and see the todo appear
   as a read-only event on Friday.

---

## 2. Scope

In scope:

- **§4.0 Entity contract foundation** — the single biggest new
  thing in this phase. See §4 below for the full sub-phase plan
  and §5 for the schema sketch.
- **§4a Companies** — CRUD, KvK connector, AI enrichment,
  dashboard widget, web UI.
- **§4b Contacts** — CRUD, vCard-import connector, AI enrichment
  (contact ↔ company suggestion), widget, UI.
- **§4c Calendar** — CRUD, Google Calendar connector, AI
  enrichment (meeting summary + attendee ↔ contact linking),
  widget, UI (uses OSS `react-big-calendar` per `overall.md` §10.5).
- **§4d Todos** — CRUD, no external connector in v1, AI
  enrichment (auto-priority, auto-due-suggest), widget, list +
  simple kanban UI. Cross-entity bridge: todos with `due_at`
  surface read-only on the calendar via a projection subscriber.

Out of scope (deferred):

- Remaining entities from `overall.md` §6 — Kanban Boards,
  Workflows, Whiteboards, Journal, Diagrams, Documents, File
  Storage, Knowledge Base, External News, Personal Messages.
  Those land in "Later" (`overall.md` §8) once the contract has
  proven itself with the four entities here.
- Phase-6 chat retrieval. Phase 4 writes LanceDB index rows so
  phase 6 can query them; phase 4 does **not** implement the
  pre-retrieval auth filter — that lives at the LanceDB call
  site in phase 6.
- Phase-7 self-learning. The `entity_souls` table is created
  empty; phase 7 fills it.
- Generic scheduled-task UI from phase 5 — phase-4 scheduled
  jobs (enrichment, translation, sync retries) are registered
  in code, not via UI.

---

## 3. Non-Goals (phase 4)

- No bespoke calendar / kanban widgets. Use established OSS
  pieces (`react-big-calendar`; a small kanban list view, not
  the full `@dnd-kit` board yet — that's the Kanban-entity phase).
- No real-time push from external systems. Connectors poll on a
  scheduled cadence; webhooks are a follow-up.
- No multi-row bulk import UI beyond vCard for contacts. CSV /
  spreadsheet import is "Later".
- No federation between servers. Cross-server entity sync stays
  deferred (`overall.md` §8 "Later").
- No per-field translation. **Per-record `originalLocale`**, full
  payload re-translated per locale (decision §10.7 in
  `overall.md`).

---

## 4. Approach

### 4.1 Sub-phases (delivery order — one tasklist row each)

#### 4.0 — Entity contract foundation _(prerequisite for 4a..4d)_

Goal: ship the universal `Entity`-contract + generic store +
generic router + connector base + translator runner + contract
test suite. **No** concrete entity kind is added in 4.0.

- Migration `0005_entities_base.sql` (see §5).
- `packages/shared/src/entity.ts` — cross-package types (see §6).
- `apps/server/src/entities/`:
  - `module.ts` — `EntityModule<P>` interface
  - `registry.ts` — `registerEntityModule(...)` + lookup
  - `store.ts` — generic `EntityStore` over the shared tables
  - `router.ts` — `mountEntityRoutes(app, module)` factory
  - `events.ts` — `entity.*` event type registry + payload shapes
  - `translator.ts` — scheduled per-locale re-translator
  - `connectors/base.ts` — `EntityConnector<P>` interface +
    sync-state helpers
- `apps/server/tests/entity-contract/` — reusable contract
  tests that every future `EntityModule` MUST pass:
  - CRUD round-trip via the generic router
  - version bump on update
  - soft-delete propagates to summary listing
  - translation lifecycle (`entity.translation.requested` →
    `entity.translation.completed`)
  - summary search returns layer-scoped results only
  - cross-layer isolation (entity in layer A not visible in
    layer B unless visibility edge exists)
- ADR `0011 — entity contract` (per-kind table + shared
  cross-cutting tables; module registry; connector pattern;
  translation lifecycle).
- `docs/dev/architecture/entities.md` — new doc covering the
  contract, the registry, the store, the router factory, the
  translator, and the connector base. Becomes the canonical
  reference for §4a..§4d.
- Update `docs/dev/architecture/event-bus.md` with the
  `entity.*` event taxonomy.
- No smoke-test extension yet (no concrete entity to smoke).
- **One commit.** Conventional commit:
  `feat(entities): introduce universal entity contract (phase 4.0)`.

#### 4a — Companies _(PR block)_

| Sub-phase | What ships                                                                                                                                                  | Commit subject                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 4a.1      | Per-kind migration `0006_companies.sql`, `companyModule` registration, `packages/shared/src/companies.ts` zod payload                                       | `feat(companies): schema + module (phase 4a.1)`         |
| 4a.2      | KvK connector (`apps/server/src/entities/companies/kvk-connector.ts`) on top of the §4.0 connector base; minimal config in the per-layer `attachments` slot | `feat(companies): kvk connector (phase 4a.2)`           |
| 4a.3      | AI-enrichment scheduled job (summary + fill-missing-fields); uses the system-default LLM with per-call override; 100% logged per `overall.md` §4            | `feat(companies): scheduled AI enrichment (phase 4a.3)` |
| 4a.4      | `CompaniesWidget` registered in the dashboard widget registry from phase 3.5                                                                                | `feat(companies): dashboard widget (phase 4a.4)`        |
| 4a.5      | Web UI `/l/:slug/companies` (list, detail, edit) — generic CRUD shell + company-specific fields                                                             | `feat(companies): web UI (phase 4a.5)`                  |
| 4a.6      | i18n keys `entity.companies.*`, `connectors.kvk.*`, tests, smoke uses Companies as the canonical "create-edit-delete-search" flow                           | `test(companies): smoke + i18n (phase 4a.6)`            |

PR: `feat(companies): companies entity (phase 4a)`.

#### 4b — Contacts _(PR block)_

| Sub-phase | What ships                                                                                                                                         | Commit subject                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 4b.1      | Migration `0007_contacts.sql`, `contactModule`, `packages/shared/src/contacts.ts` payload (name, emails[], phones[], links to `entity_id` company) | `feat(contacts): schema + module (phase 4b.1)`  |
| 4b.2      | vCard-import connector (parser + upload endpoint behind `/l/:slug/contacts/import-vcard`)                                                          | `feat(contacts): vcard import (phase 4b.2)`     |
| 4b.3      | AI enrichment: given a contact, propose a `companyId` link based on email domain + existing companies in the layer                                 | `feat(contacts): enrichment (phase 4b.3)`       |
| 4b.4      | `ContactsWidget`                                                                                                                                   | `feat(contacts): dashboard widget (phase 4b.4)` |
| 4b.5      | UI `/l/:slug/contacts`                                                                                                                             | `feat(contacts): web UI (phase 4b.5)`           |
| 4b.6      | i18n + tests + smoke                                                                                                                               | `test(contacts): smoke + i18n (phase 4b.6)`     |

PR: `feat(contacts): contacts entity (phase 4b)`.

#### 4c — Calendar _(PR block)_

| Sub-phase | What ships                                                                                                                                                                                      | Commit subject                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| 4c.1      | Migration `0008_calendar.sql`, `calendarEventModule`, `packages/shared/src/calendar.ts` payload (start, end, all_day, location, attendees[], rrule_string for v1 — opaque string, no expansion) | `feat(calendar): schema + module (phase 4c.1)`  |
| 4c.2      | Google Calendar connector (OAuth tokens stored encrypted in `entity_external_links.payload_json`; poll every N minutes)                                                                         | `feat(calendar): google connector (phase 4c.2)` |
| 4c.3      | AI enrichment: meeting summary + attendee-string → contact-resolution scheduled job                                                                                                             | `feat(calendar): enrichment (phase 4c.3)`       |
| 4c.4      | `CalendarWidget` (this week / next 7 events)                                                                                                                                                    | `feat(calendar): dashboard widget (phase 4c.4)` |
| 4c.5      | UI `/l/:slug/calendar` using `react-big-calendar` (month / week / day)                                                                                                                          | `feat(calendar): web UI (phase 4c.5)`           |
| 4c.6      | i18n + tests + smoke                                                                                                                                                                            | `test(calendar): smoke + i18n (phase 4c.6)`     |

PR: `feat(calendar): calendar entity (phase 4c)`.

#### 4d — Todos + cross-entity bridge _(PR block)_

| Sub-phase | What ships                                                                                                                                                                                                                                                                          | Commit subject                                         |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 4d.1      | Migration `0009_todos.sql`, `todoModule`, `packages/shared/src/todos.ts` payload (title, status, priority, due_at, `linked_entity_ref` to a contact/company)                                                                                                                        | `feat(todos): schema + module (phase 4d.1)`            |
| 4d.2      | Connector placeholder — no external system in v1; the registry slot exists so a future "Trello import" connector lands additively                                                                                                                                                   | `feat(todos): connector placeholder (phase 4d.2)`      |
| 4d.3      | AI enrichment: auto-priority + auto-due suggestion when title contains a date phrase                                                                                                                                                                                                | `feat(todos): enrichment (phase 4d.3)`                 |
| 4d.4      | `TodosWidget`                                                                                                                                                                                                                                                                       | `feat(todos): dashboard widget (phase 4d.4)`           |
| 4d.5      | UI `/l/:slug/todos` — list view + simple per-status kanban (NOT the full Kanban-entity; that's later)                                                                                                                                                                               | `feat(todos): web UI (phase 4d.5)`                     |
| 4d.6      | **Bridge subscriber**: on `entity.todo.{created,updated}` with non-null `due_at`, emit a read-only `calendar.projection.todo` row visible in the calendar UI as a non-editable event. No second source of truth. On `entity.todo.deleted` or `due_at = null`, the projection drops. | `feat(todos): calendar projection bridge (phase 4d.6)` |
| 4d.7      | i18n + tests + smoke                                                                                                                                                                                                                                                                | `test(todos): smoke + i18n (phase 4d.7)`               |

PR: `feat(todos): todos entity + calendar bridge (phase 4d)`.

### 4.2 Per sub-phase Definition of Done

Every sub-phase commit must satisfy the `AGENTS.md` DoD checklist
applicable to that change. The minimum bar:

- Tasklist row updated (status → `done`).
- `bun run format && lint && typecheck && test` green locally.
- For schema changes: a `tests/integration/` test asserts the
  migration applies cleanly to a fresh DB and is forward-only.
- For HTTP additions: a route-level integration test with a real
  bus, real event log, and a telemetry-wrapped LLM client (per
  ADR 0006).
- For UI additions: a component test + an `apps/web/tests/`
  end-to-end smoke for the happy path.
- i18n keys present in **all** configured locales; missing keys
  fail `bun run i18n:check` (per `AGENTS.md`).
- Soft-delete + version bump + UUID + `originalLocale` honored
  for every mutation (asserted by the contract test suite).
- Auth via `effectiveLayers`; non-member sees `404
errors.layer.notVisible` (same contract as phase 3).

### 4.3 Open questions resolved before start

1. **One polymorphic `entities` table vs per-kind tables.** →
   **Per-kind tables** for indexable columns (
   `companies.kvk_number`, `calendar_events.starts_at`,
   `todos.due_at`). Shared cross-cutting concerns live in
   `entity_external_links`, `entity_translations`,
   `entity_versions`, `entity_souls`. Rationale: SQLite filters
   poorly over JSON; Postgres-port (`overall.md` §8 "Later")
   stays straightforward.
2. **Connector framework lands in 4.0 or 4a.** → Interface +
   sync-state schema in 4.0; **first concrete connector** in
   4a.2 (KvK).
3. **Todo ↔ Calendar bridge: projection or shared FK.** →
   **Projection via subscriber** in 4d.6. Read-only event on
   the calendar; no duplicate storage; deletes / due-date
   clears propagate via the same subscriber.
4. **Contacts external connector.** → **vCard import** (4b.2).
   Google Contacts is a follow-up.
5. **Subagent execution.** → Subagent runs
   `bun run format && lint && typecheck && test` before every
   commit and ships one conventional commit per sub-phase.
6. **PR cadence.** → **One PR per entity block** (4.0, 4a, 4b,
   4c, 4d). Not one PR per micro-sub-phase.

---

## 5. Schema sketch (the §4.0 foundation tables)

```sql
-- 0005_entities_base.sql

-- Per-entity version history. Per-kind tables (companies, contacts, ...)
-- write a row here on every mutation so the version chain is uniform
-- across kinds without forcing JSON in the indexable tables.
CREATE TABLE entity_versions (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL,
  entity_kind   TEXT NOT NULL,
  version       INTEGER NOT NULL,
  payload_json  TEXT NOT NULL,         -- snapshot of kind-specific payload
  meta_json     TEXT NOT NULL,         -- {createdBy, updatedBy, originalLocale, ...}
  created_at    TEXT NOT NULL,
  created_by    TEXT NOT NULL REFERENCES users(id),
  UNIQUE (entity_id, version)
);
CREATE INDEX idx_entity_versions_lookup ON entity_versions(entity_kind, entity_id);

-- Per-locale translation of an entity's payload. Original-locale
-- payload always lives in the per-kind table; this table holds
-- everything else.
CREATE TABLE entity_translations (
  entity_id     TEXT NOT NULL,
  entity_kind   TEXT NOT NULL,
  locale        TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  source_version INTEGER NOT NULL,     -- version this translation was built from
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (entity_id, locale)
);
CREATE INDEX idx_entity_translations_kind ON entity_translations(entity_kind, locale);

-- Connector-managed link to an external system.
CREATE TABLE entity_external_links (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL,
  entity_kind   TEXT NOT NULL,
  connector     TEXT NOT NULL,         -- 'google.calendar', 'kvk.nl', 'vcard.import', ...
  external_id   TEXT NOT NULL,
  sync_state    TEXT NOT NULL CHECK (sync_state IN ('idle','syncing','error')),
  synced_at     TEXT,
  error         TEXT,
  payload_json  TEXT NOT NULL DEFAULT '{}',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (connector, external_id)
);
CREATE INDEX idx_entity_external_links_entity ON entity_external_links(entity_kind, entity_id);

-- Phase-7 hook: per-entity memory slice. Empty in phase 4; populated
-- by the self-learning loop in phase 7.
CREATE TABLE entity_souls (
  entity_id     TEXT NOT NULL,
  entity_kind   TEXT NOT NULL,
  memory_json   TEXT NOT NULL DEFAULT '{}',
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (entity_id)
);
```

Per-kind tables (`companies`, `contacts`, `calendar_events`,
`todos`) share this shape — defined in their own sub-phase
migrations:

```sql
-- shape every per-kind table follows
CREATE TABLE <kind>s (
  id              TEXT PRIMARY KEY,
  layer_id        TEXT NOT NULL REFERENCES layers(id),
  slug            TEXT NOT NULL,                 -- unique within (layer_id, kind)
  title           TEXT NOT NULL,                 -- denormalized for summary listing
  searchable_text TEXT NOT NULL,                 -- for LanceDB index writes
  original_locale TEXT NOT NULL,
  payload_json    TEXT NOT NULL,                 -- kind-specific zod-validated payload
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL REFERENCES users(id),
  deleted_at      TEXT,
  deleted_by      TEXT REFERENCES users(id),
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (layer_id, slug),
  -- plus kind-specific indexed columns:
  --   companies: kvk_number TEXT, website TEXT
  --   calendar_events: starts_at TEXT, ends_at TEXT
  --   todos: due_at TEXT, status TEXT, priority INTEGER
  ...
);
CREATE INDEX idx_<kind>_layer ON <kind>s(layer_id);
CREATE INDEX idx_<kind>_deleted_at ON <kind>s(deleted_at);
```

---

## 6. Shared types (`packages/shared/src/entity.ts`)

```ts
export interface EntityRef {
  readonly id: string; // UUID
  readonly kind: string; // 'company' | 'contact' | 'calendar_event' | 'todo' | <future>
  readonly layerId: string;
  readonly slug: string; // unique within (layerId, kind)
}

export interface EntityMeta {
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly deletedAt: string | null;
  readonly deletedBy: string | null;
  readonly version: number;
  readonly originalLocale: string;
}

export interface EntitySummary extends EntityRef {
  readonly meta: EntityMeta;
  readonly title: string;
  readonly subtitle: string | null;
  readonly searchableText: string;
}

export interface EntityExternalLink {
  readonly id: string;
  readonly connector: string;
  readonly externalId: string;
  readonly syncState: 'idle' | 'syncing' | 'error';
  readonly syncedAt: string | null;
  readonly error: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface Entity<Payload = unknown> extends EntitySummary {
  readonly payload: Payload;
  readonly externalLinks: readonly EntityExternalLink[];
  readonly translations?: Readonly<Record<string, Payload>>;
}
```

Server-side `EntityModule<P>` and `EntityStore` interfaces, plus
the connector base, are defined under
`apps/server/src/entities/` (server-internal — not in the shared
package, because they pull in `bun:sqlite` / `MessageBus` /
`LlmClient`).

---

## 7. Events

The §4.0 commit registers the following event taxonomy
(`apps/server/src/entities/events.ts`):

```
entity.<kind>.created
entity.<kind>.updated
entity.<kind>.deleted
entity.<kind>.restored
entity.translation.requested
entity.translation.completed
entity.connector.sync.requested
entity.connector.sync.succeeded
entity.connector.sync.failed
```

Per-kind events are emitted by the generic store (via
`mountEntityRoutes`). Connector events are emitted by the
generic connector base. Subscribers in phase 4 are:

- The translator scheduled job — listens for
  `entity.<kind>.{created,updated}` and enqueues
  re-translation per layer locale.
- The LanceDB index writer (write-side only; phase-6 reads
  apply the pre-retrieval auth filter).
- The todo→calendar projection (§4d.6) — listens for
  `entity.todo.{created,updated,deleted}`.

---

## 8. Authorization

Phase 4 reuses the phase-3 contract verbatim:

- Layer scope = URL slug. Every entity route mounts under
  `/l/:slug/<kind>/*` and uses `createRequireLayer()` so a
  non-member gets `404 errors.layer.notVisible`.
- Inside the layer: anyone in `effectiveLayers` can **read**;
  edit / delete requires either layer ownership (mirroring
  `canEditLayer`) or being the entity's `createdBy` (the v1
  per-record ACL — a richer per-entity RBAC is a follow-up,
  consistent with phase 3.3's non-goal of "fine-grained per-
  route permissions").

LanceDB pre-retrieval auth filter remains a phase-6 concern.
Phase 4 only writes auth-tagged rows (every embedding row
carries `layerId` so phase 6 can filter pre-retrieval).

---

## 9. Tests

Phase 4 lands three new test surfaces:

1. **Contract tests** (`apps/server/tests/entity-contract/`).
   Reusable suite parameterized over an `EntityModule`. Every
   per-entity sub-phase (4a.1, 4b.1, 4c.1, 4d.1) imports this
   suite, registers its module against a real DB + bus, and
   runs the full battery: CRUD, version bump, soft-delete,
   translation lifecycle, summary search, cross-layer
   isolation, auth gates, event emission.
2. **Per-connector tests** with the external network stubbed
   at the connector boundary (no real KvK / Google calls in
   CI). Sync-state transitions tested directly.
3. **Extended smoke** (`apps/server/tests/smoke.test.ts`).
   Phase-3 smoke is extended sub-phase by sub-phase:
   4a → create company. 4b → import vCard + AI-suggest link.
   4c → poll Google (stub) + meeting summary. 4d → create todo
   with due_at, assert it appears on the calendar projection.

---

## 10. Docs impact

- New: `docs/dev/architecture/entities.md` (4.0).
- New: per-entity sections under `docs/user/features/` as each
  block lands.
- Updated:
  - `docs/dev/architecture/overview.md` — add an "entities"
    band to the spine diagram.
  - `docs/dev/architecture/event-bus.md` — `entity.*` taxonomy.
  - `docs/dev/architecture/layers-and-auth.md` — short paragraph
    showing how entity routes hang off `requireLayer`.
- New ADRs:
  - `0011 — entity contract` (4.0).
  - `0012 — KvK connector` (4a.2) — only if non-trivial
    decisions are made (auth model, rate limits).
  - `0013 — Google Calendar connector` (4c.2) — token storage
    choice (per-link encrypted blob) deserves an ADR.

---

## 11. i18n impact

New namespaces:

- `entity.common.*` — generic CRUD labels, errors, empty
  states reused by every entity UI.
- `entity.companies.*`, `entity.contacts.*`, `entity.calendar.*`,
  `entity.todos.*` — per-entity strings.
- `connectors.kvk.*`, `connectors.vcard.*`, `connectors.google.calendar.*`.
- `errors.entity.*` — generic entity errors (`notFound`,
  `notInLayer`, `slugTaken`, `translationFailed`, `syncFailed`).

English is the primary fallback (per `AGENTS.md`). Missing keys
fail `bun run i18n:check`.

---

## 12. Accessibility impact

Every new view (list, detail/edit, calendar, kanban) follows
`AGENTS.md §Accessibility`: semantic HTML, keyboard
navigation, visible focus, labels, screen-reader-friendly
errors. The calendar component (`react-big-calendar`) is
audited at 4c.5: if its day-cell focus model is insufficient,
a follow-up issue is filed rather than a bespoke wrapper.

---

## 13. Risks

| Risk                                                                           | Likelihood | Impact | Mitigation                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ---------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Generic router becomes a leaky abstraction (kind-specific edge cases creep in) | Med        | High   | Keep `EntityModule` minimal; kind-specific extensions go in per-kind modules, not the factory. Contract tests defend the boundary.                                          |
| Connector tokens leak via event log                                            | Low        | High   | Connector base scrubs secrets before `bus.publish`; `entity_external_links.payload_json` is the only home for the encrypted token.                                          |
| Translation cost blows up on layers with many locales × many entities          | Med        | Med    | Per-call LLM logging from phase 1.4; per-layer rate limit + coalescing on the translator job. Re-translate only when `source_version` < entity version.                     |
| Todo→Calendar projection diverges from the calendar's own data model           | Med        | Med    | Subscriber only emits; the calendar UI knows the row is a projection (different visual treatment, no edit). One subscriber, one direction.                                  |
| LanceDB index drift: deletes don't propagate                                   | Med        | Med    | Soft-delete subscriber rewrites the index row with a "deleted" flag; phase-6 filter excludes it. Contract test asserts.                                                     |
| Google Calendar OAuth complexity blows phase-4c scope                          | Med        | Med    | Token storage in `entity_external_links.payload_json` (encrypted with the same key already used for telemetry secrets); refresh on poll; manual reauth UI if refresh fails. |

---

## 14. Plan close-out (filled in when phase 4 ships)

Each sub-phase's commit updates this section with: what shipped,
where the developer narrative now lives, which ADRs landed,
which follow-ups remain. On all sub-phases `done`, the plan
moves to `docs/dev/plans/done/phase-04-first-entities.md` and
the tasklist `Related document` paths follow.

### 4.0 shipped (2026-05-23)

**What landed**

- Migration
  `apps/server/src/storage/migrations/0005_entities_base.sql` with
  the four shared cross-cutting tables (`entity_versions`,
  `entity_translations`, `entity_external_links`, `entity_souls`)
  and all CHECK / UNIQUE / index constraints from §5. The phase-1
  migrations test asserts the schema lands on a fresh DB.
- Shared types in `packages/shared/src/entity.ts` — `EntityRef`,
  `EntityMeta`, `EntitySummary`, `EntityExternalLink`,
  `Entity<Payload>`, `EntitySyncState`, zod schemas and the
  `entitySchema(payloadSchema)` factory.
- Server-side foundation under `apps/server/src/entities/`:
  - `module.ts` — `EntityModule<Payload>` contract.
  - `registry.ts` — process-local registry with duplicate-kind
    rejection and a test-only reset escape hatch.
  - `store.ts` — `createEntityStore` factory: CRUD + version bump
    per mutation + soft-delete + restore + summary listing +
    summary search + external-link helpers + translation record;
    every mutation emits `entity.<kind>.<action>` AFTER tx commit.
  - `router.ts` — `mountEntityRoutes(app, { module, store, bus, db })`
    factory producing `/l/:slug/<kind>/*` routes; all gated by
    `createRequireLayer`; localized error keys throughout.
  - `events.ts` — `ENTITY_EVENT_TYPES` + `entityEventType(kind, action)`
    helper + payload interfaces for every event.
  - `translator.ts` — per-kind translator runner: subscribes to
    `entity.<kind>.{created,updated}`, source-version-driven
    re-translation, injectable `translate` callback for tests.
  - `connectors/base.ts` — `EntityConnector<Payload>` interface +
    `markSyncing` / `markSucceeded` / `markFailed` sync-state
    helpers + `insertExternalLink` / `listExternalLinks` /
    `removeExternalLink` repo-style accessors +
    `scrubConnectorPayload` secret-key filter.
- Reusable contract test suite
  `apps/server/tests/entity-contract/suite.ts` exporting
  `runEntityContractSuite({...})` plus
  `apps/server/tests/entity-contract/fixture-module.test.ts` which
  registers a fake `FixtureEntityModule` (kind = `fixture`) and
  runs the full battery against it, including the translator
  lifecycle and the 0005 migration assertion.
- ADR `docs/dev/decisions/0011-entity-contract.md` covering the
  per-kind + shared-table split, the `EntityModule` registry, the
  connector pattern, the translation lifecycle, and authz
  inheritance from phase 3.
- Architecture doc
  `docs/dev/architecture/entities.md`: contract overview, schema,
  module / store / router / translator / connector, future-extension
  recipe.
- Updates to
  `docs/dev/architecture/overview.md`,
  `docs/dev/architecture/event-bus.md`, and
  `docs/dev/architecture/layers-and-auth.md`.
- i18n keys `errors.entity.*` (notFound, notInLayer, slugTaken,
  validation, translationFailed, syncFailed) and `entity.common.*`
  (generic CRUD labels) in `en.json` + `nl.json`.

**No per-kind code shipped.** Companies, Contacts, Calendar, and
Todos all hang off the now-stable foundation. `mountEntityRoutes`
is exported but intentionally unused in 4.0; phase 4a.1 is the
first caller.

**ADR**

- `0011-entity-contract.md` — accepted.

**Follow-ups noted**

- Per-field translations (vs. per-record) — re-evaluate after we
  have real translation-cost data. Open thread in `overall.md §10.7`.
- Per-record edit ACL beyond "layer owner OR `created_by`" — file a
  follow-up the first time a user reports the rule mismatches their
  workflow. Phase-3.3's non-goal on fine-grained per-route
  permissions still applies.
- The translator runs the LLM call inline in 4.0. Phase 5 swaps
  the inline call for a queue push; the event surface is stable.

### 4a.1 shipped (2026-05-23)

**What landed**

- Migration `apps/server/src/storage/migrations/0006_companies.sql` —
  the first per-kind table. Follows §5 shape exactly: shared columns
  (`id`, `layer_id`, `slug`, `title`, `searchable_text`,
  `original_locale`, `payload_json`, audit columns, `version`) plus
  `kvk_number TEXT` and `website TEXT`. Indexes:
  `idx_companies_layer`, `idx_companies_deleted_at`,
  `idx_companies_kvk` (sparse; KvK number is nullable).
  `apps/server/tests/migrations.test.ts` asserts the schema lands on a
  fresh DB and that the migration list ends at `0006_companies`.
- Cross-package zod schemas in `packages/shared/src/companies.ts`:
  `CompanyAddressSchema`, `CompanyPayloadSchema` (8-digit KvK,
  URL website, 4000-char description cap, every field optional),
  `CreateCompanyRequestSchema`, `UpdateCompanyRequestSchema`. Slug
  validation matches `CreateLayerRequestSchema` (`^[a-z0-9-]+$`).
  Re-exported from `packages/shared/src/index.ts`.
- `companyModule` (`apps/server/src/entities/companies/module.ts`)
  with `kind = 'company'`, `tableName = 'companies'`, the new
  `indexedColumns` declaration for `kvk_number` + `website`, a
  lowercase searchable-text digest, and a `subtitle` that picks the
  KvK number first, the website second.
- Wire-up helper `apps/server/src/entities/companies/index.ts` —
  exports `registerCompanyModule()` (idempotent per process so
  `makeTestApp`-rebuilt tests do not collide on the registry) and
  `mountCompanyRoutes(app, { db, bus, llm })`. Wired into the
  production app from `apps/server/src/http/router.ts`.
- Contract suite for the kind:
  `apps/server/tests/entities/companies-contract.test.ts` runs the
  §4.0 reusable suite against `companyModule` and adds two
  per-kind assertions for the indexed-column path (write on
  create/update; clear writes `NULL`).
- i18n: `entity.companies.*` and `errors.entity.companies.*` in
  both `en.json` and `nl.json`.
- Docs: §2 of `docs/dev/architecture/entities.md` documents the new
  `indexedColumns` mechanism; new §10a "First consumer: companies
  (4a.1)" walks through the registered module shape.

**Foundation tweak**

- `EntityModule<Payload>` gained an optional
  `indexedColumns: readonly EntityIndexedColumn<Payload>[]` field.
  The generic `EntityStore` (`apps/server/src/entities/store.ts`)
  validates each `name` against `/^[a-z_][a-z0-9_]*$/`, rejects
  collisions with the reserved-column set, rejects duplicates within
  the array, and appends the columns + placeholders to the INSERT
  and UPDATE SQL it builds once per factory call. The `extract`
  callback projects payload values into `string | number | null` —
  the type space SQLite stores natively.
  This was extracted into the contract once (instead of patched
  per kind) because all four phase-4 entities need an indexed
  column: companies (`kvk_number`, `website`), calendar
  (`starts_at`, `ends_at`), todos (`due_at`, `status`, `priority`).
  See §4.3 question 1 above.

**Follow-ups noted**

- Per-kind route prefix is `/l/:slug/company` (singular) per the
  §4.0 router's `/<kind>/*` convention. The phase-4a.5 web UI will
  surface a friendlier `/l/:slug/companies` page that calls this
  URL underneath; if the discrepancy ever bothers a future kind,
  expose an optional `routeSegment` on `EntityModule` then. Not
  worth touching the foundation again now.
