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

### 4a.2 shipped (2026-05-24)

**What landed**

- KvK connector
  (`apps/server/src/entities/companies/kvk-connector.ts`) on top of
  the §4.0 connector base. `createKvkConnector(deps)` exposes
  `verify` (strict zod over `apiKey`, optional `endpoint`,
  `pollIntervalMinutes` ≥ 60 / default 1440), `pull(ctx, { externalId })`
  (Basisprofiel fetch → `CompanyPayload` patch), and a no-op `push`.
  Errors surface as `errors.connectors.kvk.{kvkUnreachable,
kvkUnauthorized, kvkNotFound, kvkInvalidResponse, invalidConfig}`.
- New migration
  `apps/server/src/storage/migrations/0007_layer_attachments_connector_kind.sql`
  extends `layer_attachments.kind` CHECK to accept `'connector'`
  via the SQLite table-rebuild dance.
  `LayerAttachmentKindSchema` in `packages/shared/src/layer.ts`
  mirrors the new enum value.
- New shared infrastructure under `apps/server/src/entities/`:
  - `connector-dispatcher.ts` — `createConnectorDispatcher({ db, bus,
[resolveConfig], [lookup], [clock] })`. Subscribes to
    `entity.connector.sync.requested`, resolves the connector +
    per-layer config, transitions the link via `setSyncingState`,
    runs `connector.pull`, calls `markSucceeded` / `markFailed`.
    Exposes `handle(payload)` for synchronous tests.
  - `connector-runner.ts` — `createConnectorRunner({ db, bus,
[intervalMs], [clock], [listConnectors], [resolveConfig] })`. On
    every `tickOnce()` (or interval tick), iterates registered
    `(kind, connector)` pairs, finds external links whose
    `synced_at` is older than the per-layer `pollIntervalMinutes`,
    publishes `entity.connector.sync.requested` for each one. Skips
    `syncing` / `error` rows.
  - `registry.ts` gained `getConnector(kind, id)` and
    `listConnectorsForKind(kind)`. Connector index is rebuilt on
    every `registerEntityModule`.
- `entities/router.ts` POST `/external-links` now validates
  `body.connector` against `getConnector(module.kind, id)`. Unknown
  id → 400 `errors.entity.connectorUnknown` with NO row persisted.
  Known id → row stored, `entity.connector.sync.requested`
  published, 201 returned with the link in `sync_state='idle'`.
- `entities/connectors/base.ts` foundation tweak: `markSyncing` was
  split into `setSyncingState` (DB-only state write) +
  `publishSyncRequested` (publish only). `EntityConnector.pull`
  signature is now `pull(ctx, { ref, externalId })`. `ConnectorContext`
  gained a `config` field (the per-attachment config the dispatcher
  resolves from `layer_attachments`). `ConnectorPullInput` is the
  new public type the dispatcher hands to `pull`.
- `companyModule` exports a `createCompanyModule(opts)` factory that
  accepts a custom connectors list (tests inject a stub-fetch KvK
  connector). The default singleton `companyModule` registers the
  production KvK connector.
- Boot wiring (`apps/server/src/index.ts`) instantiates the
  dispatcher + runner exactly once, gated by
  `config.connectors.runnerEnabled` (default `true`) and
  `config.connectors.tickMs` (default 60_000ms).
- `AppConfigSchema` (`apps/server/src/config/schema.ts`) gained
  `connectors: { runnerEnabled: boolean, tickMs: number }`.

**Foundation tweaks (extending §4.0 inline in this commit)**

- Registry gained `getConnector(kind, id)` + `listConnectorsForKind`.
- Router POST `/external-links` dispatches via the bus instead of
  silently persisting orphan rows.
- Connector base split sync-state transitions from publish (avoids
  double-publish from the request subscriber).
- `EntityConnector.pull` now receives the externalId per-call;
  `ConnectorContext` carries the per-attachment config.
- New per-process dispatcher + interval poll runner.
- `LayerAttachmentKindSchema` extended to include `'connector'`
  - matching SQL CHECK migration.

**Tests**

- `apps/server/tests/entities/companies-kvk-connector.test.ts` —
  happy path (stubbed Basisprofiel → link transitions to `idle`
  with `synced_at`, `succeeded` emitted), error paths (401 / 404 /
  5xx / network → `error` state, `failed` emitted with the right
  i18n key), `verify` config validation (missing apiKey, empty
  apiKey, too-short interval, extra keys, defaults), and the
  **secret-stripping invariant** (no event payload anywhere on the
  bus contains the literal apiKey across both success + failure
  paths). Includes the response-mapping assertions for
  `mapBasisprofielToCompanyPayload`.
- `apps/server/tests/entities/connector-runner.test.ts` — `tickOnce`
  with a fake clock: emits requested per stale link, treats
  `synced_at IS NULL` as stale, skips `syncing` / `error` rows,
  respects per-layer `pollIntervalMinutes`.
- `apps/server/tests/entities/companies-external-links-http.test.ts`
  — HTTP-level `POST /l/:slug/company/:companySlug/external-links`:
  unknown connector returns 400 `errors.entity.connectorUnknown`
  and persists nothing; known connector returns 201 with `idle`
  link and emits one `requested` event.
- `apps/server/tests/migrations.test.ts` updated for `0007`,
  including a probe INSERT that exercises the extended CHECK.

**ADR**

- `0012-kvk-connector.md` — accepted. Covers the four design
  questions: where connector config lives, sync vs. async dispatch,
  who polls, and the secret-stripping invariants. KvK-specific
  endpoint + auth choices included.

**i18n**

- `errors.entity.connectorUnknown` (en + nl).
- `errors.connectors.notConfigured` (en + nl).
- `errors.connectors.kvk.{kvkUnreachable, kvkUnauthorized,
kvkNotFound, kvkInvalidResponse, invalidConfig}` (en + nl).
- `connectors.kvk.{label, description, fields.*}` (en + nl).

**Docs**

- `docs/dev/architecture/entities.md` §10b "Connectors (4a.2)"
  documents the dispatch model and the secret-stripping invariant.
- `docs/dev/decisions/0012-kvk-connector.md` (new ADR).
- `docs/dev/tasklist.md` 4a.2 row → `done`.

**Follow-ups noted**

- Rate-limiting (KvK enforces 60 req/min per apikey) is NOT yet
  implemented. A follow-up adds a token-bucket inside the
  dispatcher when a second rate-limited connector lands.
- The HTTP response of `POST /external-links` does not surface the
  connector-produced patch. 4a.5 web UI re-fetches; future
  long-running connectors (Google Calendar OAuth in 4c.2) will
  likely add an SSE / event-stream for live status — out of 4a.2
  scope.
- A connector that throws a non-`errors.` message ends up surfaced
  as `errors.entity.syncFailed`. This is intentional — see the
  dispatcher comment — but worth flagging for future connector
  authors.

### 4a.3 shipped (2026-05-24)

**What landed**

- Generic enrichment runner under
  `apps/server/src/entities/enrichment-runner.ts`. Same shape as the
  4a.2 connector runner: `createEnrichmentRunner({ db, bus, llm,
pricing, config, resolveStore })` exposes `start()`, `stop()`, and
  `tickOnce()`. `start()` subscribes once per registered module that
  declares `enrichmentJobs` (to `entity.<kind>.{created,updated}`) plus
  one subscription to `entity.connector.sync.succeeded`. Tests call
  `tickOnce()` instead of fake timers for the debounce half.
- `EntityModule<Payload>` gained an optional
  `enrichmentJobs?: readonly EnrichmentJob<Payload>[]` field (foundation
  tweak — reused by 4b.3, 4c.3, 4d.3). `EnrichmentJob`,
  `EnrichmentJobContext`, `EnrichmentResult`, and `EnrichmentTrigger`
  are exported from `apps/server/src/entities/module.ts`.
- Four new event types in
  `apps/server/src/entities/events.ts`:
  `entity.enrichment.{started,succeeded,failed,deferred}` with closed
  payload shapes (no `prompt` / `response` field). The succeeded event
  carries `tokensIn`, `tokensOut`, and `costUsd` so dashboards do not
  need to join `llm_calls`.
- `ConnectorContext.onPayloadPatch?` (new) lets the dispatcher capture
  a connector's mapped payload patch. The dispatcher's implementation
  runs `scrubConnectorPayload(...)` and writes the result to
  `entity_external_links.payload_json` as `{ lastPatch, lastPatchedAt }`
  via a new helper `persistConnectorPayloadPatch(...)`. The
  `companies.fillFields` job reads `link.payload.lastPatch` as KvK
  ground-truth — closing the 4a.2 ADR's open thread.
- Two production jobs in
  `apps/server/src/entities/companies/enrichment.ts`:
  - `companies.summary` (runs on `created` / `updated` /
    `sync.succeeded`) — generates a ≤300-char description via the
    telemetry-wrapped LLM client.
  - `companies.fillFields` (runs on `sync.succeeded` only) — asks the
    LLM to fill missing structured fields (`legalName`, `tradeName`,
    `industry`, `description`) using `link.payload.lastPatch` as
    ground-truth. Null-valued fields are skipped.
- Both jobs registered on `companyModule.enrichmentJobs` (override-able
  via `createCompanyModule({ enrichmentJobs })` for tests).
- Boot wiring (`apps/server/src/index.ts`) constructs + starts the
  enrichment runner once at boot, gated by
  `config.enrichment.runnerEnabled` (default `true`). The runner uses
  the telemetry-wrapped `llmClient` and the same `PricingMap` the
  wrapper consumes.
- `AppConfigSchema` gained
  `enrichment: { runnerEnabled, debounceMs, maxRunsPerLayerPerMinute }`
  (defaults `true`, `5_000`, `30`).

**Foundation tweaks (extending §4.0 and 4a.2 inline in this commit)**

- `EntityModule.enrichmentJobs` (optional, new).
- `EnrichmentJob<P>` / `EnrichmentResult<P>` / `EnrichmentJobContext<P>`
  / `EnrichmentTrigger` exports.
- `ConnectorContext.onPayloadPatch?` + the
  `persistConnectorPayloadPatch` helper. The KvK connector now calls
  both `deps.onPayloadPatch` (test-only, preserves 4a.2 assertion)
  and `ctx.onPayloadPatch` (dispatcher path).
- Four new `entity.enrichment.*` event types + payload interfaces.
- `EnrichmentConfigSchema` in `apps/server/src/config/schema.ts`.

**Tests**

- `apps/server/tests/entities/enrichment-runner.test.ts` — generic
  runner tests driven against a `FixtureEntityModule`: subscribes,
  debounces (multiple events for one entity collapse to one run),
  applies a patch + bumps version, refuses to overwrite non-empty
  user fields (except `description`), publishes the new events,
  handles failure gracefully, and enforces the per-layer rate limit
  with a deferred event when the cap hits.
- `apps/server/tests/entities/companies-enrichment.test.ts` — four
  companies-specific scenarios: summary on `created` (description
  applied + tokens/cost in event), fillFields on `sync.succeeded`
  (patch applied + version bump), LLM failure (`failed` event, no
  patch, no version bump), and the secret-strip invariant (configured
  KvK apiKey appears in NO LLM prompt and in NO bus event).

**ADR**

- `0013-entity-enrichment.md` — accepted. Covers the four design
  questions (per-kind vs. generic runner, event-driven vs. polling,
  where the connector patch lives, how cost surfaces).

**i18n**

- `entity.enrichment.{summary,fillFields,deferred,running,idle}` (en + nl).
- `errors.entity.enrichment.{failed,rateLimited}` (en + nl).

**Docs**

- `docs/dev/architecture/entities.md` §10c "Enrichment (4a.3)"
  documents the `EnrichmentJob` contract, the runner lifecycle, the
  rate-limit + coalescing model, and the secret-strip invariant.
- `docs/dev/architecture/event-bus.md` §12 table extended with the
  four new event types; anti-leak list extended with the
  enrichment-only invariant ("quantitative metadata only — the full
  prompt + response lives in `llm_calls`").
- `docs/dev/decisions/0013-entity-enrichment.md` (new ADR).
- `docs/dev/tasklist.md` 4a.3 row → `done`.

**Follow-ups noted**

- The "do not overwrite non-empty user fields" overwrite policy
  expresses a single exception (`description`). When the second
  exception appears (likely calendar attendees in 4c.3), the policy
  becomes per-field and lives in the module rather than in the runner.
- The 30 calls/min/layer rate limit is a flat constant. Phase 5
  (general scheduled tasks) is the natural place to surface it as
  configurable per layer with a UI.
- The summary prompt is locale-blind in 4a.3. When the translator
  (4.0) and enrichment overlap on the same row, the prompts should
  consult `entity.originalLocale`. Not a 4a.3 concern.

### 4a.4 shipped (2026-05-24)

**What landed**

- New optional `EntityModule.statsProvider?` slot in
  `apps/server/src/entities/module.ts` (`EntityStatsProvider`,
  `EntityStatsContext` exports). Same additive shape as the 4a.1
  `indexedColumns` and 4a.3 `enrichmentJobs` extensions — modules
  without a stats need omit the field entirely.
- The generic entity router gained `GET /l/:slug/<kind>/_stats`.
  Registered BEFORE the `/:entitySlug` GET because Hono matches in
  registration order — `/_stats` would otherwise be treated as an
  entity slug. When `module.statsProvider` is undefined the route
  returns `404 errors.entity.statsUnavailable`. New i18n key
  `errors.entity.statsUnavailable` in en + nl.
- Concrete `companyStatsProvider` at
  `apps/server/src/entities/companies/stats.ts`. Pure SQL — returns
  `{ total, withKvk, missingDescription, recentlyEnriched }` for the
  requesting layer:
  - `total` — non-soft-deleted companies in the layer.
  - `withKvk` — `kvk_number` is non-null and non-empty.
  - `missingDescription` — `payload_json.description` is missing /
    NULL / empty (via `json_extract`).
  - `recentlyEnriched` — `entity_souls.updated_at` is newer than
    `now - 24h`. The enrichment runner's `recordLastEnriched`
    stamps `updated_at` on every job tick (success or refusal); the
    widget therefore answers "how many companies got at least one
    enrichment run in the past 24 hours?" `now` is injected so
    tests can pin the window.
- Wired the stats provider onto `companyModule` in
  `apps/server/src/entities/companies/module.ts`. Re-exported from
  `apps/server/src/entities/companies/index.ts`.
- Web dashboard:
  - New `apps/web/src/dashboard/widget-registry.ts` — a minimal
    client-side registry exposing `registerWidget(...)` and
    `listDashboardWidgets()`. Ordering is `order` ascending, with
    registration order as a stable tie-breaker.
  - New `apps/web/src/dashboard/widgets.ts` barrel — imports each
    widget module once for its registration side effect. Future
    sub-phases (4b.4 / 4c.4 / 4d.4) add a single import line here.
  - New `apps/web/src/dashboard/companies-widget-state.ts` — pure
    reducer mapping `{loading, error, ready}` inputs to the
    `{loading, error, empty, ready}` render branch the component
    draws. Extracted so the matrix is testable without a DOM
    runtime.
  - New `apps/web/src/dashboard/CompaniesWidget.tsx` — fetches
    `GET /l/:slug/company/_stats` on mount, renders the four
    branches via shadcn `<Card>` + `<Button>`, with semantic
    landmark (`role="region"` + `aria-labelledby`), `role="status"`
    - `aria-live="polite"` on loading, `role="alert"` on error, and
      `<dt>` / `<dd>` for stat label/value pairings. The "View
      companies" and "Create company" CTAs are placeholder links to
      `/l/:slug/companies` — that route ships in 4a.5.
  - `apps/web/src/pages/LayerDashboardPage.tsx` now imports the
    `dashboard/widgets` barrel and renders every registered widget
    in a responsive grid. The "no widgets yet" fallback stays as a
    safety net when the registry is empty (e.g. in tests that
    reset it). The "Configure widgets" link moves to the layer
    header card so it stays discoverable above the widget grid.
- Web client gained `getCompanyStats(slug)` +
  `CompanyStatsResponse` in `apps/web/src/lib/api.ts`.
- i18n keys (en + nl):
  - `layer.dashboard.widgets.companies.{title, loading, error,
empty, createCta, viewAllCta, statTotal, statWithKvk,
statMissingDescription, statRecentlyEnriched}`.
  - `errors.entity.statsUnavailable`.

**Tests**

- `apps/server/tests/entities/companies-stats.test.ts` — five HTTP
  scenarios over a seeded layer with companies (mix of KvK /
  description / soft-deleted / recently-enriched rows): zero
  counts, the happy mix from the plan, the route-ordering smoke
  for `/_stats` vs `/:entitySlug`, cross-layer isolation, and
  soft-delete exclusion.
- `apps/web/tests/companies-widget.test.ts` — covers the pure
  reducer matrix (loading / error / empty / ready / off-by-one
  guard on `total === 1`), the widget registry contract (ordering,
  idempotent duplicate registration), and the literal registration
  shape `CompaniesWidget` uses. The DOM-driven render test sits
  behind the existing `docs/dev/follow-ups/web-component-tests.md`
  follow-up — pure-logic coverage matches the
  `apps/web/tests/layer-helpers.test.ts` pattern.

**Foundation tweaks (extending §4.0 inline in this commit)**

- `EntityModule.statsProvider?` (optional, new) +
  `EntityStatsProvider` + `EntityStatsContext` types.
- New `GET /l/:slug/<kind>/_stats` route registered before
  `/:entitySlug` in the generic router so `/_stats` matches first.

**Docs**

- `docs/dev/architecture/entities.md` §10d "Stats provider (4a.4)"
  documents the new slot and the route-ordering rule.
- `docs/dev/tasklist.md` 4a.4 row → `done`.

**Notable for 4a.5 (web UI)**

- Widget CTAs (`/l/:slug/companies`, `/l/:slug/companies?new=1`)
  are placeholders that resolve to the React Router 404 page until
  4a.5 mounts the companies list / create routes.
- URL routeSegment decision stands: server URL is singular
  (`/l/:slug/company`, `/l/:slug/company/_stats`) per the 4a.1
  follow-up; the web UI's user-facing URL is plural
  (`/l/:slug/companies`). 4a.5 will hit the singular server URL
  under the hood. If a third entity wants a different routeSegment
  the §4.0 router gains an optional `routeSegment` override at
  that point — not now.

**Follow-ups noted**

- `layer_dashboard_widgets` persistence is unused: every layer
  renders the entire client-side widget registry. Per-layer
  toggling / layout config lives behind that table and ships
  alongside the phase-5 scheduled-tasks UI when a user actually
  asks for it.
- The DOM-driven render test for `CompaniesWidget` (asserting the
  rendered branches, button focus visibility, label associations)
  is blocked on `docs/dev/follow-ups/web-component-tests.md`. The
  existing pure reducer + registry tests catch the logic
  regressions in the meantime.

### 4a.5 shipped (2026-05-24)

**What landed**

- `apps/web/src/lib/companies-routes.ts` — the canonical home for the
  singular-server-URL ↔ plural-web-URL mapping. Exposes
  `companiesListWebRoute`, `companyDetailWebRoute`,
  `companiesNewWebRoute`, `companiesServerBase`,
  `companyServerDetail`, `companyServerExternalLinks`,
  `companyServerExternalLink`, and the `slugifyCompanyTitle` helper
  that matches `CreateCompanyRequestSchema`'s `^[a-z0-9-]+$` rule.
- `apps/web/src/lib/api-types.ts` extended with the entity envelope
  types (`EntityMeta`, `EntitySyncState`, `EntityExternalLink`,
  `EntitySummary`, `Entity<P>`) and the companies-specific shapes
  (`CompanyAddress`, `CompanyPayload`, `Company`,
  `CreateCompanyPayload`, `UpdateCompanyPayload`,
  `AddCompanyExternalLinkPayload`). Hand-written interfaces per the
  file-level rule: keeps the web bundle off `zod`.
- `apps/web/src/lib/api.ts` extended with `listCompanies`,
  `getCompany`, `createCompany`, `updateCompany`,
  `softDeleteCompany`, `listCompanyExternalLinks`,
  `addCompanyExternalLink`, `removeCompanyExternalLink`. Every helper
  routes through `companies-routes.ts` so the singular ↔ plural seam
  stays in one place.
- `apps/web/src/pages/CompaniesListPage.tsx` — list page at
  `/l/:layerSlug/companies`. Fetches `GET /l/:layerSlug/company` and
  renders the three columns the summary actually carries: title,
  subtitle (KvK / website projection from `companyModule.subtitle`),
  and `meta.updatedAt`. Empty state surfaces the same `Create
company` CTA as the dashboard widget. Create flow opens an inline
  `<Dialog>` bound to `CreateCompanyRequestSchema` with auto-slug
  derivation from the title. The `/l/:layerSlug/companies/new`
  route reuses the same component and auto-opens the dialog so the
  dashboard widget's deep link works without a separate page.
- `apps/web/src/pages/CompanyDetailPage.tsx` — detail + edit page at
  `/l/:layerSlug/companies/:companySlug`. Bound to
  `UpdateCompanyRequestSchema`; save calls PATCH; cancel reverts to
  the last loaded payload. KvK link section POSTs to
  `/external-links` with `{ connector: 'kvk', externalId }`,
  surfaces the resulting `sync_state` with a manual refresh button
  (no SSE / polling — see ADR 0012's deferred follow-up). Destructive
  delete uses the existing `ConfirmDialog` and the destructive
  button variant.
- `apps/web/src/pages/companies-page-state.ts` — pure-logic helpers
  factored out for testability: `companiesListView`,
  `companyDetailView`, `validateCompanyForm`,
  `buildCreateCompanyRequest`, `buildUpdateCompanyRequest`,
  `draftFromCompany`, `emptyCompanyFormDraft`,
  `linkSyncStateBadgeKey`. Same pattern as
  `dashboard/companies-widget-state.ts`.
- Router wiring in `apps/web/src/App.tsx`: three new routes
  (`/l/:layerSlug/companies`, `/l/:layerSlug/companies/new`,
  `/l/:layerSlug/companies/:companySlug`) plus a `companies` entry in
  `pageTitleFor` so the header surface shows the page name. The
  dashboard widget's existing `/l/:slug/companies` and
  `/l/:slug/companies?new=1` placeholder links from 4a.4 now resolve.
- i18n: `entity.companies.*` extended with the listTitle / listEmpty
  / listLoading / listError / createCta / createDialogTitle /
  field* / save / cancel / saved / created / delete* / externalLinks*
  / linkKvk* / linkSync* / linkConnectorLabel / enrichmentSummary /
  slug / slugHint / colTitle / colSubtitle / colUpdatedAt / detail*
  keys, in both `en.json` and `nl.json`. `errors.entity.companies.*`
  extended with `loadFailed`, `saveFailed`, `deleteFailed`,
  `linkAddFailed`, `linkRefreshFailed`, `slugTaken`, `validation`,
  in both locales. `layer.shell.subpages.companies` added so the
  header label maps to "Companies".

**Foundation tweaks**

- None. The `EntityModule.summaryColumns` extension (the natural
  home for projecting `address.city` and an enrichment-status flag
  onto the list row) is deferred to a follow-up — see below. The
  4a.5 list page renders the columns the existing summary actually
  carries.

**Tests**

- `apps/web/tests/companies-list-page.test.ts` — pure-logic coverage
  for the list view reducer, the singular ↔ plural URL helpers, and
  the slug normalizer.
- `apps/web/tests/companies-detail-page.test.ts` — pure-logic
  coverage for the detail view reducer, the form draft <→ payload
  bridge, the inline validator (KvK 8-digit rule, URL / email
  shapes, 4000-char description cap), and the
  `linkSyncStateBadgeKey` mapping.
- All gates green: `bun run format`, `bun run lint`, `bun run
typecheck`, `bun test`, `bun run docs:check`, `bun run i18n:check`.

**Docs**

- `docs/dev/plans/phase-04-first-entities.md` §14 — this close-out.
- `docs/dev/architecture/entities.md` §10a — paragraph documenting
  the client-side singular ↔ plural URL mapping that lives in
  `apps/web/src/lib/companies-routes.ts`.
- `docs/dev/follow-ups/companies-list-columns.md` — new follow-up
  describing the gap between the spec's column list (city,
  enrichment-status, relative time) and what the summary endpoint
  actually surfaces. Pre-decision is to extend `EntityModule` with a
  `summaryColumns?` slot when 4b.5 / 4c.5 land, but the call is left
  open in the follow-up.

**Notable for 4a.6**

- The smoke test still walks the create-edit-delete-search flow at
  the HTTP layer per the §4.1 4a.6 row — the web UI is exercised
  only at the pure-logic level by the 4a.5 tests. The DOM-driven
  render coverage stays parked behind
  `docs/dev/follow-ups/web-component-tests.md`.
- The list page columns are intentionally `title + subtitle +
updatedAt`; surfacing city + enrichment status is tracked in
  `docs/dev/follow-ups/companies-list-columns.md`.
- A future enrichment log endpoint (`GET
/l/:slug/company/:companySlug/enrichment-log` returning the last N
  enrichment events for the entity) was considered for 4a.5 and
  explicitly skipped per the spec note — the AI-generated
  `description` is the visible enrichment outcome for now. A
  separate follow-up should land when a second consumer asks for the
  log surface.

**Follow-ups noted**

- `docs/dev/follow-ups/companies-list-columns.md` (new) — the list
  page's column set is the minimum the summary endpoint surfaces.
  City / enrichment-status / relative-time columns require either an
  `EntityModule.summaryColumns?` foundation extension or a different
  list contract.
- The dashboard widget's `?new=1` query parameter is **not** the
  shipping deep-link to the create dialog — the
  `/l/:slug/companies/new` route is. The widget still uses
  `?new=1` because the 4a.4 commit shipped that placeholder; it
  navigates to the list page where the dialog stays closed unless
  the `/new` path matches. Updating the widget to the
  `/companies/new` deep link is a one-line follow-up in 4a.6.

### 4a.6 shipped (2026-05-24)

**What landed**

- `apps/server/tests/smoke.test.ts` extended with the canonical
  Companies entity flow (step 12). Logs in fresh as the seeded admin
  (after the phase-3.6 logout in step 9), resolves the personal
  layer via `GET /me/layers`, attaches the KvK connector config via
  `POST /layers/:slug/attachments { kind: 'connector', refId: 'kvk',
config: { apiKey, pollIntervalMinutes } }`, then walks:
  - `POST /l/personal-admin/company` — creates "AMI BV" with
    `originalLocale='en'` and `payload.kvkNumber='12345678'`. Asserts
    201, version=1, originalLocale set, deleted_at null.
  - `PATCH /l/.../company/ami-bv` — sets description; asserts
    version=2 and `updatedAt` advanced.
  - `POST /l/.../company/ami-bv/external-links` — known connector,
    201 with `sync_state='idle'`, captures the
    `entity.connector.sync.requested` event off the bus.
  - `dispatcher.handle(...)` driven synchronously against the
    stub-fetched KvK connector (returns a Basisprofiel JSON). Asserts
    the link transitions to `idle` with `synced_at` set and one
    `entity.connector.sync.succeeded` event published.
  - `enrichmentRunner.tickOnce()` against a deterministic fake
    `LlmClient`. Asserts `payload.description` is set by the LLM and
    the entity version is strictly higher than the post-PATCH value.
  - `GET /l/.../company` — lists AMI BV.
  - `GET /l/.../company/_stats` — asserts `{ total: 1, withKvk: 1,
recentlyEnriched: 1, missingDescription: 0 }`.
  - `DELETE /l/.../company/ami-bv` → 200. List omits the row; detail
    GET still returns 200 with `meta.deletedAt !== null` (the §4.0
    contract keeps soft-deleted rows reachable by slug for the
    future restore flow — `listSummaries` is the surface that hides
    them).
  - Secret-strip invariant: the configured KvK apiKey appears in NO
    bus-event payload and in NO LLM prompt across the entire
    sub-flow.
- The smoke construction pattern (pre-register a stub-fetched
  `companyModule` via `__resetEntityRegistryForTests()` +
  `registerEntityModule`, drive `dispatcher.handle` synchronously,
  build a fake `LlmClient` for `createEnrichmentRunner`) is the
  template every later entity smoke reuses (4b.6 / 4c.6 / 4d.7).
- One small wiring tweak in
  `apps/server/src/entities/companies/index.ts`:
  `registerCompanyModule()` is now truly idempotent — short-circuits
  when ANY company module is already registered, instead of throwing
  when a pre-registered module is a different instance. This lets
  the smoke pre-register a stub-fetched variant BEFORE `createApp`
  runs without colliding with `createApp`'s default registration.
  Production has a single caller (`createApp`), so the short-circuit
  never fires there.
- Dashboard widget deep-link fix:
  `apps/web/src/dashboard/CompaniesWidget.tsx` now points the
  "Create company" CTA at `/l/:slug/companies/new` instead of
  `/l/:slug/companies?new=1`. The canonical create deep-link from
  4a.5 finally lights up.
- i18n sweep (English primary, Dutch parity in scope namespaces):
  - All in-scope keys under `entity.companies.*`,
    `entity.enrichment.*`, `errors.entity.companies.*`,
    `errors.entity.enrichment.*`, `connectors.kvk.*`,
    `errors.connectors.kvk.*`, `layer.dashboard.widgets.companies.*`
    are present in BOTH `en.json` and `nl.json`. Every Dutch value
    is a real translation, not an English placeholder.
  - Removed truly-orphan UI label keys with zero references anywhere
    in `apps/server/src`, `apps/web/src`, or `packages/`: - `entity.enrichment.{running, idle, deferred, failed, summary,
fillFields}` (no UI surface consumes them; the bus event types
    live in `apps/server/src/entities/events.ts` as code
    constants, not i18n keys). - `entity.companies.{title, singular, create, edit, empty,
search, fields.*, linkKvkCta, originalLocale}` — duplicates of
    the `entity.companies.field*` / `createCta` / `listEmpty`
    / `linkKvkAdd` keys the 4a.5 UI actually renders, left over
    from the 4a.1 schema commit. - `errors.entity.enrichment.rateLimited` and
    `errors.entity.companies.{deleteFailed, linkRefreshFailed,
slugTaken}` — defined in the i18n catalogue but never
    emitted by the server and never referenced by the web. The
    catch-all `errors.entity.slugTaken` (emitted by the generic
    `mountEntityRoutes`) still covers the companies case. - `connectors.kvk.{label, description, fields.apiKey,
fields.endpoint, fields.pollIntervalMinutes}` — admin-UI
    metadata for a connectors picker that does not exist yet.
    Re-add alongside the picker when 4c.2 (Google Calendar)
    lands the second connector and motivates a picker UI.
  - `bun run i18n:check` ends green; the remaining warnings are
    out-of-scope (`status.*`, `chat.*`, etc. from earlier phases).
- Follow-up triage:
  - `docs/dev/follow-ups/companies-list-columns.md` stays open. The
    `EntityModule.summaryColumns?` slot is correctly deferred to
    whichever entity (4b.5 / 4c.5) first needs it; opening it now
    would couple a 4a fix to two unfinished sub-phases.
  - `docs/dev/follow-ups/web-component-tests.md` stays open. The
    DOM-driven harness is a separate, generic concern.
  - Both follow-ups live in `docs/dev/follow-ups/` (not
    `docs/dev/follow-ups/done/`).

**Foundation tweaks**

- None. The four foundation extensions (`indexedColumns`,
  `getConnector` + dispatcher + runner, `enrichmentJobs`,
  `statsProvider`) already cover the smoke flow.
- The `registerCompanyModule` idempotence change is a per-kind wiring
  helper tweak, not a foundation extension. It does NOT change the
  `EntityModule<Payload>` contract, the registry contract, or the
  router/store factories.

**Tests**

- `apps/server/tests/smoke.test.ts` extended with the canonical
  Companies flow (described above). 1 test, 127 expect() calls.
- All prior tests stay green: 432 pass, 0 fail, 68 files,
  1300 expect() calls.

**Docs**

- `docs/dev/plans/phase-04-first-entities.md` §14 — this close-out
  and the 4a-block recap section below.
- `docs/dev/tasklist.md` 4a.6 row → `done`. 4a parent row → `done`.

**Follow-ups noted**

- The `dispatcher.handle()` synchronous-test seam: 4a.6 drives the
  dispatcher manually without calling `dispatcher.start()` to avoid
  double-dispatching the same `sync.requested` event. The pattern
  is correct for tests but a tiny gotcha for new contributors —
  document in `apps/server/src/entities/connector-dispatcher.ts`
  the next time we touch the file.

---

## 4a — Companies block: shipped

The 4a PR block (4a.1 → 4a.6) completes the first concrete entity
on top of the §4.0 foundation. The six sub-phases land additively:

| Sub-phase | What shipped                                                                                                                            | Foundation extension                                           |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 4a.1      | `0006_companies.sql`, `companyModule`, `packages/shared/src/companies.ts` payload, contract suite assertions for indexed-column path    | `EntityModule.indexedColumns?` slot                            |
| 4a.2      | KvK connector + per-process dispatcher + interval poll runner + `LayerAttachment` kind `'connector'`                                    | `getConnector` / `listConnectorsForKind` + dispatcher + runner |
| 4a.3      | Generic enrichment runner + `companies.summary` + `companies.fillFields` + `entity.enrichment.*` event taxonomy                         | `EntityModule.enrichmentJobs?` slot                            |
| 4a.4      | `companyStatsProvider` + `GET /l/:slug/<kind>/_stats` route + `CompaniesWidget` + client-side `widget-registry.ts`                      | `EntityModule.statsProvider?` slot                             |
| 4a.5      | Web UI: list, detail, create, KvK link, soft-delete; singular↔plural URL helper in `apps/web/src/lib/companies-routes.ts`               | None — singular↔plural seam stays client-side                  |
| 4a.6      | Smoke flow (canonical create-edit-delete-search), i18n sweep, dashboard widget deep-link fix, idempotent `registerCompanyModule` helper | None — purely test + docs + wiring polish                      |

**ADRs landed in the 4a block**

- `docs/dev/decisions/0011-entity-contract.md` — the §4.0 universal
  entity contract (per-kind table + shared cross-cutting tables,
  module registry, connector pattern, translation lifecycle).
- `docs/dev/decisions/0012-kvk-connector.md` — KvK connector design:
  where connector config lives, sync vs. async dispatch, who polls,
  secret-stripping invariants.
- `docs/dev/decisions/0013-entity-enrichment.md` — per-kind vs.
  generic runner, event-driven vs. polling, where the connector
  patch lives, how cost surfaces.

**Open follow-ups remaining**

- `docs/dev/follow-ups/companies-list-columns.md` — extend
  `EntityModule.summaryColumns?` (or change the list contract) so
  the list page can surface city / enrichment-status / relative
  time. Triggered when 4b.5 / 4c.5 land.
- `docs/dev/follow-ups/web-component-tests.md` — DOM-driven render
  tests for `CompaniesWidget` and the 4a.5 pages. Separate harness
  day.

**Next**

The 4b block (Contacts) opens on this foundation: 4b.1 lands the
per-kind table + `contactModule`; 4b.2 adds the vCard-import
connector (the §4.0 connector base + 4a.2 dispatcher both already
support multiple connector kinds per module); 4b.3 declares the
`contact.companyLink` enrichment job on the same `enrichmentJobs`
slot 4a.3 introduced; 4b.4 attaches a `ContactsWidget` to the
client-side widget registry; 4b.5 mounts the UI; 4b.6 reuses the
4a.6 smoke template.

### 4b.1 shipped (2026-05-24)

**What landed**

- Migration `apps/server/src/storage/migrations/0008_contacts.sql` —
  the second per-kind table. Follows §5 shape exactly: shared columns
  (`id`, `layer_id`, `slug`, `title`, `searchable_text`,
  `original_locale`, `payload_json`, audit columns, `version`) plus
  three nullable indexed columns — `primary_email`, `primary_phone`,
  `company_entity_id`. Indexes: `idx_contacts_layer`,
  `idx_contacts_deleted_at`, `idx_contacts_primary_email` (sparse),
  `idx_contacts_company` (sparse). `company_entity_id` is NOT a
  `FOREIGN KEY` — keeping the link soft so it survives a company's
  soft delete and so future kinds can reuse the slot (4b.3's contact↔
  company validator lives in the route handler, not the SQL layer).
  `apps/server/tests/migrations.test.ts` asserts the new schema lands
  on a fresh DB and the migration list ends at `0008_contacts`.
- Cross-package zod schemas in `packages/shared/src/contacts.ts`:
  `ContactEmailSchema` (z.string().email() + label + isPrimary),
  `ContactPhoneSchema` (free-form value max 64 + label + isPrimary),
  `ContactPayloadSchema` (givenName / familyName / displayName /
  emails[≤16] / phones[≤16] / companyEntityId (uuid) / jobTitle / notes
  / birthday (YYYY-MM-DD), every field optional, emails deduplicated
  by lowercased value), `CreateContactRequestSchema`,
  `UpdateContactRequestSchema`. Slug validation matches the
  `CreateCompanyRequestSchema` rule (`^[a-z0-9-]+$`). Re-exported from
  `packages/shared/src/index.ts`.
- `contactModule` (`apps/server/src/entities/contacts/module.ts`) with
  `kind = 'contact'`, `tableName = 'contacts'`, the three-entry
  `indexedColumns` declaration, a lowercase searchable-text digest,
  and a `subtitle` that picks primary email → primary phone →
  jobTitle. Exposed as both the singleton `contactModule` and the
  `createContactModule(opts)` factory so 4b.2 (vCard import) and 4b.3
  (AI enrichment) stay additive.
- Wire-up helper `apps/server/src/entities/contacts/index.ts` exports
  `registerContactModule()` (idempotent — short-circuits when any
  contact module is already registered) and
  `mountContactRoutes(app, { db, bus, llm })`. Wired into the
  production app from `apps/server/src/http/router.ts` alongside the
  4a.1 companies wiring.
- Contract suite for the kind:
  `apps/server/tests/entities/contacts-contract.test.ts` runs the
  §4.0 reusable suite against `contactModule` and adds per-kind
  assertions for the three indexed columns (`isPrimary=true` wins;
  first-entry fallback applies; clearing the payload writes `NULL`
  across the board) plus a `toSummary` subtitle precedence check.
- i18n: new `entity.contacts.*` block (listTitle / listEmpty /
  listLoading / listError / createCta / field* / save / cancel /
  deleteCta) and new `errors.entity.contacts.*`block (loadFailed /
saveFailed / validation / slugTaken / emailDuplicate /
companyNotFound) in both`en.json`and`nl.json` with real Dutch
  translations.
- Docs: `docs/dev/architecture/entities.md` §10e "Second consumer:
  contacts (4b.1)" documents the registered module shape, the soft
  `company_entity_id` link rule, and explicitly records that ZERO
  foundation tweaks were needed — the empirical confirmation the
  contract takes a clean second adoption with only the four
  extension slots already shipped in the 4a block.

**Foundation tweaks**

- **None.** The four extension slots (`indexedColumns`,
  `getConnector` / dispatcher / runner, `enrichmentJobs`,
  `statsProvider`) introduced during the 4a block were sufficient.
  4b.1 declares `indexedColumns` only; the connector / enrichment /
  stats slots stay empty and ship in 4b.2 / 4b.3 / 4b.4.

**Notable for 4b.2 (vCard import)**

- The 4a.2 connector base + dispatcher already supports multiple
  connector kinds per module (§10b "Wire layout"). 4b.2 builds a
  `vcardConnector` and passes it via `createContactModule({
connectors: [vcardConnector] })`. The `CreateContactModuleOptions`
  interface in `apps/server/src/entities/contacts/module.ts` is the
  natural slot for that injection — currently empty, will grow a
  `connectors?: readonly EntityConnector<ContactPayload>[]` field
  in 4b.2 the same way `createCompanyModule` did for KvK.
- vCard parsing is the only new server-side concern in 4b.2; the
  dispatcher path (`POST /external-links` → `entity.connector.sync.
requested` → `connector.pull` → patch applied) is identical to
  the KvK flow. The 4a.6 smoke construction pattern reuses cleanly.
- The route segment is singular (`/l/:slug/contact/*`) per the §4.0
  router naming, mirroring the 4a.1 follow-up. The 4b.5 web UI
  surfaces a plural `/l/:slug/contacts` page (singular ↔ plural seam
  stays client-side, as per the 4a.5 close-out).
