# ADR 0011 — Entity contract: per-kind tables + shared cross-cutting tables + module registry

- Status: accepted
- Date: 2026-05-23
- Phase: 4 (foundation lands in 4.0; written up alongside the migration)
- Related: `docs/dev/plans/done/phase-04-first-entities.md` §1, §4.0, §4.3,
  §5, §6, §7, §8, §13;
  `apps/server/src/storage/migrations/0005_entities_base.sql`;
  `apps/server/src/entities/module.ts`;
  `apps/server/src/entities/registry.ts`;
  `apps/server/src/entities/store.ts`;
  `apps/server/src/entities/router.ts`;
  `apps/server/src/entities/translator.ts`;
  `apps/server/src/entities/connectors/base.ts`;
  `packages/shared/src/entity.ts`;
  ADRs [`0009`](./0009-layer-model.md) /
  [`0010`](./0010-layer-resolver-and-invalidation.md).

---

## Context

Phase 4 introduces user-facing entities — Companies, Contacts,
Calendar, Todos — and the entire follow-on catalogue in
`overall.md` §6 (Kanban, Workflows, Whiteboards, Journal, Diagrams,
Documents, Knowledge Base, External News, Personal Messages). Each
kind has its own indexable columns (`companies.kvk_number`,
`calendar_events.starts_at`, `todos.due_at`) and its own
domain-specific connectors (KvK, Google Calendar, vCard import).

Four design questions had to be answered before any phase-4 schema
landed:

1. **One polymorphic `entities` table vs. per-kind tables.** SQLite
   filters poorly over JSON; an `auth_tag`-style retrieval pattern
   (phase 6 LanceDB pre-search) needs typed columns to be cheap.
2. **Where do cross-cutting concerns live?** Version history, per-
   locale translations, external links, and the phase-7 "soul" memory
   slice are universal — every entity kind needs them. Replicating
   four tables per kind explodes the migration surface.
3. **How does new-kind code plug in?** A 4a..4d entity has its own
   per-kind migration, payload schema, summary projection, connector,
   translator, dashboard widget, and UI. Without a contract, each
   kind reinvents the wiring.
4. **Where does the translation lifecycle live?** Per-record
   `originalLocale` plus full-payload re-translation per locale is the
   `overall.md` §10.7 decision; phase 4 has to make it concrete.

---

## Decision

### Per-kind tables + four shared cross-cutting tables

Every entity kind owns a per-kind table (`companies`, `contacts`,
`calendar_events`, `todos`, …) that follows the same shape:

```
id              TEXT PRIMARY KEY
layer_id        TEXT NOT NULL REFERENCES layers(id)
slug            TEXT NOT NULL   -- unique within (layer_id, kind)
title           TEXT NOT NULL   -- denormalized for summary listing
searchable_text TEXT NOT NULL   -- LanceDB index source (phase 6)
original_locale TEXT NOT NULL
payload_json    TEXT NOT NULL   -- kind-specific zod-validated payload
created_at / created_by / updated_at / updated_by / deleted_at / deleted_by
version         INTEGER NOT NULL DEFAULT 1
UNIQUE (layer_id, slug)
```

Plus kind-specific indexable columns (`kvk_number`, `starts_at`,
`due_at`, …).

Four **shared cross-cutting tables** are introduced once and reused by
every kind (`apps/server/src/storage/migrations/0005_entities_base.sql`):

| Table                   | Purpose                                                                                                          |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `entity_versions`       | One snapshot row per mutation. Uniform version chain across kinds without JSON in the indexable tables.          |
| `entity_translations`   | Per-locale, full-payload translations of an entity. `source_version` records the entity version it derives from. |
| `entity_external_links` | Connector-managed link to an external record. Encrypted tokens / config live in `payload_json`; never in events. |
| `entity_souls`          | Phase-7 hook: per-entity memory slice. Empty in phase 4; populated by the self-learning loop in phase 7.         |

Per-kind code touches only its own table; the generic `EntityStore`
factory owns every write to the shared tables.

### `EntityModule` registry

`apps/server/src/entities/module.ts` defines the contract every kind
implements:

```ts
interface EntityModule<Payload> {
  readonly kind: string;
  readonly tableName: string;
  readonly payloadSchema: ZodType<Payload>;
  toSummary(input): EntitySummary;
  searchableText(payload): string;
  readonly connectors?: readonly EntityConnector<Payload>[];
  readonly scheduledJobs?: readonly EntityScheduledJob[];
  readonly onCreate?: EntityLifecycleHook<Payload>;
  readonly onUpdate?: EntityLifecycleHook<Payload>;
  readonly onSoftDelete?: EntityLifecycleHook<Payload>;
  readonly onRestore?: EntityLifecycleHook<Payload>;
}
```

The process-local registry (`apps/server/src/entities/registry.ts`)
guarantees a kind name is globally unique. Per-kind sub-phases
(4a.1, 4b.1, 4c.1, 4d.1) each register one module at boot. The chat
agent (phase 6) looks up modules by kind via `getEntityModule(kind)`
without knowing about companies vs. contacts vs. todos.

### Connector base + secret scrubbing

`apps/server/src/entities/connectors/base.ts` exposes a small
`EntityConnector<Payload>` interface (`pull`, `push`, `verify`) plus
the sync-state helpers `markSyncing` / `markSucceeded` / `markFailed`
that write to `entity_external_links` and emit
`entity.connector.sync.*`. Connector payloads are scrubbed of secret
keys (`token`, `refresh_token`, `apiKey`, …) before publish — the
encrypted blob NEVER appears in a bus event. The risk row
"Connector tokens leak via event log" in §13 of the phase-4 plan
records this invariant.

### Translation lifecycle

`apps/server/src/entities/translator.ts` subscribes to
`entity.<kind>.{created,updated}` and, for every locale configured on
the entity's layer (excluding the entity's `originalLocale`),
enqueues a translation against the system LLM client. The result
lands in `entity_translations` with `source_version = entity.version`.

Re-translation is **source-version-driven**:

- if no row exists for `(entity_id, locale)`, translate;
- if `entity_translations.source_version < entity.version`, translate;
- otherwise skip.

This is the §10.7 "per-record `originalLocale`, full-payload
re-translation per locale" decision applied operationally: the
translator is idempotent across replays, and the cost is bounded by
the actual rate of payload changes.

### Authorization inherits phase 3

Every entity route mounts under `/l/:slug/<kind>/*` and uses
`createRequireLayer()` — same contract as `/layers/:slug`. A
non-member sees `404 errors.layer.notVisible`; a member without edit
rights sees `403 errors.layer.forbidden`. The asymmetry pinned in
ADR `0010` ("404 on non-visible, 403 on visible-but-not-editable")
carries over verbatim. Per-record edit ACL in v1 is "layer owner OR
the entity's `created_by`"; richer per-entity RBAC is a follow-up
consistent with phase 3.3's non-goal of fine-grained per-route
permissions.

The phase-6 LanceDB pre-retrieval filter is the read-side downstream
consumer: every index row carries `layerId`, and the phase-6 filter
intersects with `LayerResolver.effectiveLayers(userId)` before any
embedding search runs. Phase 4 only writes those rows — the filter
itself lands in phase 6.

---

## Consequences

**Positive**

- One contract serves every entity kind. Adding a new kind in
  "Later" (`overall.md` §8) is a per-kind migration + an
  `EntityModule` registration — not a new router/agent/scheduler/
  translator.
- Per-kind indexable columns stay cheap. SQLite-side filtering by
  `kvk_number` / `starts_at` / `due_at` does not pay the JSON-path
  tax; the future Postgres port (ADR `0002`) stays straightforward.
- Cross-cutting concerns land once. Versioning, translation,
  external-link state, and the phase-7 soul slot are uniform across
  kinds — phase-6 retrieval and phase-7 self-learning both consume
  the same shape.
- The contract test suite
  (`apps/server/tests/entity-contract/suite.ts`) is the boundary
  defender. Every per-kind sub-phase imports it and runs it against
  the kind's module + store — no kind can ship that fails the
  universal invariants.

**Negative / accepted**

- The HTTP surface grows linearly with kinds — every new kind adds
  `/l/:slug/<kind>/*` routes. Acceptable: the routes are produced by
  a factory; there is no copy-paste.
- The translator stays inline in 4.0 (no scheduler yet). Phase 5
  swaps the inline call for a queue push; the event surface stays
  identical so subscribers are unaffected.
- The §13 risk "generic router becomes a leaky abstraction" is real:
  kind-specific edge cases will try to creep into the factory. The
  contract test suite is the named defender; reviewers reject any
  kind-specific branch in `apps/server/src/entities/`.

---

## Alternatives considered

1. **One polymorphic `entities` table** — all payloads as JSON.
   Rejected because SQLite filtering over `json_extract` is slow and
   the future Postgres port cannot lean on `jsonb` indexes for the
   per-kind columns. ADR `0002` rules apply.
2. **No registry — per-kind code wires its own routes**. Rejected:
   the chat agent (phase 6) and the scheduler (phase 5) both need a
   single lookup table; registering twice (in code AND in the router
   factory) is the bug we are designing out.
3. **Per-field translations** (one row per field per locale). The
   "Later" §8 row "per-field translations" stays open; the §10.7
   `overall.md` decision is per-record for v1. Re-evaluating after
   we have actual translation cost data is a follow-up.
4. **Connector secrets in dedicated columns**. Rejected because the
   shape varies per provider (OAuth token vs. API key vs. session
   cookie) and adding columns per connector defeats the "shared
   table" point. Scrubbing on publish + encrypted blob in
   `payload_json` is the v1 contract.

---

## Follow-ups

- Phase 6 LanceDB pre-retrieval filter: every embedding row written
  by the per-kind index writer carries `layerId`; the phase-6 plan
  will cross-link this ADR explicitly.
- `docs/dev/follow-ups/per-field-translations.md` (to be filed
  alongside the first non-trivial translation-cost data point):
  re-evaluate per-record vs. per-field per the `overall.md` §10.7
  open thread.
- Per-record edit ACL beyond "owner OR `created_by`": when a phase-4
  user reports that the rule does not match their workflow, file a
  follow-up under `docs/dev/follow-ups/`. The phase-3.3 non-goal on
  fine-grained per-route permissions still applies until then.
