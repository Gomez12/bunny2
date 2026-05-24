# Entities — universal contract

> Status: living document.
> Owners: phase 4.0 introduced this; per-entity sub-phases (4a..4d)
> and the chat agent (phase 6) extend it.
> Source code: `apps/server/src/entities/`,
> `apps/server/src/storage/migrations/0005_entities_base.sql`,
> `packages/shared/src/entity.ts`,
> `apps/server/tests/entity-contract/`.

This is the single-page tour of bunny2's entity contract — the
foundation every phase 4+ user-facing object sits on. Companion to
[`layers-and-auth.md`](./layers-and-auth.md),
[`event-bus.md`](./event-bus.md),
[`overview.md`](./overview.md), and ADRs
[`0009`](../decisions/0009-layer-model.md) /
[`0010`](../decisions/0010-layer-resolver-and-invalidation.md) /
[`0011`](../decisions/0011-entity-contract.md).

---

## 0. What 4.0 ships

Phase 4.0 is the **foundation only**. It introduces:

- Migration `0005_entities_base.sql` — four shared cross-cutting
  tables (`entity_versions`, `entity_translations`,
  `entity_external_links`, `entity_souls`).
- Shared types in `packages/shared/src/entity.ts` (`EntityRef`,
  `EntityMeta`, `EntitySummary`, `EntityExternalLink`, `Entity<P>`).
- Server-side foundation under `apps/server/src/entities/`:
  - `module.ts` — the `EntityModule<P>` interface.
  - `registry.ts` — process-local module registry.
  - `store.ts` — generic `EntityStore` factory.
  - `router.ts` — `mountEntityRoutes(app, { module, store, bus, db })`
    factory.
  - `events.ts` — `entity.*` event taxonomy.
  - `translator.ts` — per-kind translator job.
  - `connectors/base.ts` — `EntityConnector<P>` interface +
    sync-state helpers + secret scrubbing.
- A reusable contract test suite in
  `apps/server/tests/entity-contract/suite.ts` that every per-kind
  sub-phase MUST pass.
- i18n keys `errors.entity.*` and `entity.common.*`.

What 4.0 does **not** ship: any concrete entity kind. No company, no
contact, no calendar event, no todo. Per-kind code lands in 4a..4d.

---

## 1. Schema shape

### 1.1 Per-kind table (every kind follows this shape)

```
<kind>s (
  id              TEXT PRIMARY KEY,
  layer_id        TEXT NOT NULL REFERENCES layers(id),
  slug            TEXT NOT NULL,
  title           TEXT NOT NULL,
  searchable_text TEXT NOT NULL,
  original_locale TEXT NOT NULL,
  payload_json    TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  created_by      TEXT NOT NULL REFERENCES users(id),
  updated_at      TEXT NOT NULL,
  updated_by      TEXT NOT NULL REFERENCES users(id),
  deleted_at      TEXT,
  deleted_by      TEXT REFERENCES users(id),
  version         INTEGER NOT NULL DEFAULT 1,
  UNIQUE (layer_id, slug),
  -- plus kind-specific indexed columns
)
```

Per-kind migrations land in 4a..4d (`0006_companies.sql`,
`0007_contacts.sql`, `0008_calendar.sql`, `0009_todos.sql`).

### 1.2 Shared cross-cutting tables (`0005_entities_base.sql`)

| Table                   | Purpose                                                                                                             |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `entity_versions`       | One row per mutation. Snapshot of the payload + meta. Indexed by `(entity_kind, entity_id)`.                        |
| `entity_translations`   | `(entity_id, locale)` PK. Holds per-locale payloads. `source_version` records the entity version it was built from. |
| `entity_external_links` | `(connector, external_id)` UNIQUE. Encrypted tokens / config live in `payload_json`; scrubbed on publish.           |
| `entity_souls`          | Phase-7 hook: per-entity memory slice. Empty in phase 4.                                                            |

ADR [`0011`](../decisions/0011-entity-contract.md) records the
per-kind vs. polymorphic decision.

---

## 2. `EntityModule<Payload>`

Server-internal contract every kind implements
(`apps/server/src/entities/module.ts`):

```ts
interface EntityModule<Payload> {
  readonly kind: string;
  readonly tableName: string;
  readonly payloadSchema: ZodType<Payload>;
  toSummary(input: { ref; meta; payload; title }): EntitySummary;
  searchableText(payload): string;
  readonly indexedColumns?: readonly EntityIndexedColumn<Payload>[];
  readonly connectors?: readonly EntityConnector<Payload>[];
  readonly scheduledJobs?: readonly EntityScheduledJob[];
  readonly onCreate?: EntityLifecycleHook<Payload>;
  readonly onUpdate?: EntityLifecycleHook<Payload>;
  readonly onSoftDelete?: EntityLifecycleHook<Payload>;
  readonly onRestore?: EntityLifecycleHook<Payload>;
}

interface EntityIndexedColumn<Payload> {
  readonly name: string;
  extract(payload: Payload): string | number | null;
}
```

`indexedColumns` (added in 4a.1) tells the generic store which per-kind
columns to populate alongside `payload_json` — e.g. `companies.kvk_number`,
`calendar_events.starts_at`, `todos.due_at`. The store validates each
`name` against `/^[a-z_][a-z0-9_]*$/` at factory time (same surface-area
treatment as `tableName`); reserved-column collisions throw at boot.
Modules that need no extra columns omit the field entirely — the fixture
module is the canonical example.

`registerEntityModule(module)` throws on duplicate `kind` — the
registry is process-local and authoritative (see
`apps/server/src/entities/registry.ts`).

---

## 3. `EntityStore<Payload>`

Generic store factory (`apps/server/src/entities/store.ts`). One
factory per kind; the factory captures the `EntityModule` and the
`tableName`. The store:

- writes to BOTH the per-kind table and the shared
  `entity_versions` / `entity_external_links` / `entity_translations`
  tables;
- wraps every mutation in a SQLite transaction and bumps `version`
  on every write;
- publishes `entity.<kind>.<action>` AFTER the tx commits — same
  lock-discipline as the layers route (`apps/server/src/http/routes/layers.ts §POST /layers` comment);
- invokes the matching `EntityModule` lifecycle hook AFTER publish.

Reads:

| Method                          | Behaviour                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `getById(id)`                   | Full `Entity<P>` envelope with external links. `null` when missing.                        |
| `getBySlug(layerId, slug)`      | Same shape; missing → `null`. Caller filters by `entity.layerId` for cross-layer safety.   |
| `listSummaries(layerIds, opts)` | Per-layer summary listing. Soft-deleted rows excluded by default.                          |
| `searchSummaries(layerIds, q)`  | Substring match over title + searchable text. Layer-scoped. Phase-6 retrieval is separate. |

The `listSummaries` / `searchSummaries` predicates are
`layer_id IN (?, ?, …)` — every read inherits the resolver's
effective-layer-set filter for free (the route reads
`c.var.effectiveLayers` and passes layer ids in).

---

## 4. `mountEntityRoutes` — generic HTTP router

`apps/server/src/entities/router.ts` exposes a factory that mounts
the per-kind HTTP surface:

```
GET    /l/:slug/<kind>
POST   /l/:slug/<kind>
GET    /l/:slug/<kind>/:entitySlug
PATCH  /l/:slug/<kind>/:entitySlug
DELETE /l/:slug/<kind>/:entitySlug                (soft-delete)
POST   /l/:slug/<kind>/:entitySlug/restore
POST   /l/:slug/<kind>/:entitySlug/external-links
DELETE /l/:slug/<kind>/:entitySlug/external-links/:linkId
```

Every route inherits the standard middleware chain (`requireAuth` →
`requirePasswordCurrent` → `withEffectiveLayers` → `requireLayer`).
A non-member sees `404 errors.layer.notVisible`. A request for a
non-existent or wrong-layer entity sees
`404 errors.entity.notFound` — same 404-vs-403 contract as the layer
surface (ADR `0010`).

Per-kind sub-phases (4a.1, 4b.1, ...) call
`mountEntityRoutes(app, { module, store, bus, db })` once at boot.

**PATCH merges payload top-level keys against the stored payload.**
The handler loads the existing entity (already required for the
not-found check), builds
`merged = { ...existingPayload, ...incomingPayload }`, validates the
merged result with `module.payloadSchema.safeParse(...)`, and passes
`parsed.data` to `store.update`. Top-level wholesale-replace per key
— no deep merge, no per-array merge. Keys absent from the body
preserve the stored value (critical for runner-owned fields such as
the calendar `meetingSummaryNote`); keys present in the body replace
the stored value verbatim (so PATCH `attendees: [...]` still replaces
the array, matching the calendar detail editor's behaviour). Example:

```
stored:    { startsAt: '...', attendees: [A, B], meetingSummaryNote: 'AI text' }
PATCH:     { payload: { location: 'Room A' } }
merged:    { startsAt: '...', attendees: [A, B], meetingSummaryNote: 'AI text',
             location: 'Room A' }
```

The merge happens in the router, not in the store. `store.update`
keeps its wholesale-replace contract — the vCard ingest dispatcher
calls it directly with the full payload from the parsed file. Schemas
use `.optional()` (not `.nullable()`), so explicit `null` to clear an
optional field is not yet supported on any kind; a future "send null
to clear" path can be opted into per-schema without a router change.

---

## 5. Events — `entity.*` taxonomy

| Type                              | When                                         | Payload                                               |
| --------------------------------- | -------------------------------------------- | ----------------------------------------------------- |
| `entity.<kind>.created`           | `EntityStore.create` after tx commit         | `{ ref, version, originalLocale, searchableText }`    |
| `entity.<kind>.updated`           | `EntityStore.update` after tx commit         | `{ ref, version, previousVersion, searchableText }`   |
| `entity.<kind>.deleted`           | `EntityStore.softDelete` after tx commit     | `{ ref, version, deletedBy }`                         |
| `entity.<kind>.restored`          | `EntityStore.restore` after tx commit        | `{ ref, version }`                                    |
| `entity.translation.requested`    | Translator enqueues a per-locale translation | `{ ref, locale, sourceVersion }`                      |
| `entity.translation.completed`    | Translator writes the row + publishes        | `{ ref, locale, sourceVersion, latencyMs }`           |
| `entity.connector.sync.requested` | Connector base `markSyncing`                 | `{ ref, connector, externalId }`                      |
| `entity.connector.sync.succeeded` | Connector base `markSucceeded`               | `{ ref, connector, externalId, syncState, syncedAt }` |
| `entity.connector.sync.failed`    | Connector base `markFailed`                  | `{ ref, connector, externalId, error }`               |

Anti-leak invariants (mirroring §9 in
[`event-bus.md`](./event-bus.md)):

- Connector payloads are scrubbed before publish (`scrubConnectorPayload`).
  Encrypted tokens / API keys never leave `entity_external_links.payload_json`.
- `searchableText` is a denormalized digest, not a content dump.
- Translation events carry source version — never the translated
  payload itself (that is a row in `entity_translations`, not a bus
  body).

---

## 6. Translator lifecycle

`apps/server/src/entities/translator.ts` subscribes to
`entity.<kind>.{created,updated}` and, for each non-original locale
configured on the entity's layer (`layer_locales` table), runs:

1. Read `entity_translations.source_version` for `(entity_id, locale)`.
2. If `source_version >= entity.version`, skip.
3. Publish `entity.translation.requested`.
4. Call the LLM (or the injected `translate` callback in tests).
5. `EntityStore.recordTranslation(...)` writes the row and publishes
   `entity.translation.completed`.

In 4.0 the translator runs the LLM call inline; the phase-5
scheduler swaps it for a queue push without changing the event
surface. Subscribers stay unaffected.

The §10.7 `overall.md` decision — per-record `originalLocale`, full
re-translation per locale — is enforced here. Per-field translations
remain a follow-up.

---

## 7. Connector base

`apps/server/src/entities/connectors/base.ts` defines:

```ts
interface EntityConnector<Payload> {
  readonly id: string;
  readonly kind: string;
  pull(ctx: ConnectorContext): Promise<void>;
  push(ctx: ConnectorContext, entity: ConnectorEntityInput<Payload>): Promise<void>;
  verify(config: Record<string, unknown>): Promise<string | null>;
}
```

Plus helpers:

- `markSyncing(input)` / `markSucceeded(input)` / `markFailed(input)`
  update `entity_external_links.sync_state` and publish the matching
  `entity.connector.sync.*` event.
- `insertExternalLink` / `listExternalLinks` / `removeExternalLink`
  hide the SQL behind a repo-style API.
- `scrubConnectorPayload(payload, [extraSecretKeys])` strips known-
  secret keys before any cross-boundary publish.

The first concrete connector (KvK) lands in 4a.2.

---

## 8. Authorization

Phase 4 inherits the phase-3 contract verbatim:

- URL slug is the current layer (no header / cookie).
  `createRequireLayer()` is the per-route gate. ADR `0010`.
- A non-member of the layer sees `404 errors.layer.notVisible`. A
  member without edit rights sees `403 errors.layer.forbidden`. The
  asymmetry is deliberate (ADR `0010` §"404, not 403, on a non-visible layer").
- v1 per-record ACL: edit / delete requires layer ownership
  (mirroring `canEditLayer`) OR being the entity's `created_by`. A
  richer per-entity RBAC is a follow-up — see
  [phase-04-first-entities.md §8](../plans/phase-04-first-entities.md#8-authorization).

The phase-6 LanceDB pre-retrieval filter is a downstream concern.
Phase 4 only writes auth-tagged rows (every embedding row carries
`layerId`); the filter runs at the LanceDB call site in phase 6.

---

## 9. Contract tests

`apps/server/tests/entity-contract/suite.ts` exports
`runEntityContractSuite({ module, store, db, bus, ... })`. The suite
asserts:

- CRUD round-trip via the generic store + router.
- Version bump on every update.
- Soft-delete propagates to summary listing and `getBySlug`.
- Restore reverses soft-delete.
- Translation lifecycle (`requested` → `completed`, `source_version`
  bookkeeping).
- Summary search returns layer-scoped results only.
- Cross-layer isolation (entity in layer A invisible from layer B
  without a visibility edge).
- Auth: non-member sees `404 errors.layer.notVisible` (asserted at
  the route level by the per-kind sub-phase).
- Event emission per §5.

`apps/server/tests/entity-contract/fixture-module.test.ts` runs the
suite against a fake `FixtureEntityModule` (kind = `fixture`, payload
= `{ title, body }`, dedicated `fixture_entities` table created in
the test only). This proves the foundation works without any 4a..4d
code.

Every per-kind sub-phase imports `runEntityContractSuite` and runs it
against its own module. **A kind cannot ship that fails the suite.**

---

## 10. Future-extension recipe — "how to add a new entity kind"

When a future sub-phase ships a new entity kind (Kanban, Workflows,
Whiteboards, …):

1. **Per-kind migration** under
   `apps/server/src/storage/migrations/` following the §1.1 shape.
   Add kind-specific indexable columns; keep `payload_json` for the
   rest.
2. **Payload zod schema** in `packages/shared/src/<kind>.ts`.
3. **EntityModule** under
   `apps/server/src/entities/<kind>/module.ts` — `kind`,
   `tableName`, `payloadSchema`, `toSummary`, `searchableText`, any
   connectors, lifecycle hooks if needed.
4. **Connectors** (optional) under
   `apps/server/src/entities/<kind>/connectors/`. Each implements
   `EntityConnector<P>` and uses the §7 sync-state helpers.
5. **Register at boot** via `registerEntityModule(module)` and
   **mount routes** via `mountEntityRoutes(app, { module, store,
bus, db })`.
6. **Run the contract suite** against the kind. Add kind-specific
   tests for the indexable columns + connector(s).
7. **Web UI** under `apps/web/src/pages/<kind>/`. Use the
   `entity.common.*` i18n namespace for generic labels; add
   `entity.<kind>.*` for kind-specific strings.
8. **Tasklist row** with status `open` → `done`; the per-kind sub-
   phase plan in
   [`phase-04-first-entities.md`](../plans/phase-04-first-entities.md)
   is the template (companies in §4a, contacts in §4b, …).

The §4.0 contract test suite, the per-kind table shape, and the
`EntityModule` registry are designed so this recipe never grows past
the eight steps above.

---

## 10a. First consumer: companies (4a.1)

The first concrete `EntityModule` is `companyModule`
(`apps/server/src/entities/companies/module.ts`). It registers under
`kind = 'company'`, writes to the `companies` table created by
`0006_companies.sql`, and declares two indexed columns:

```ts
export const companyModule: EntityModule<CompanyPayload> = {
  kind: 'company',
  tableName: 'companies',
  payloadSchema: CompanyPayloadSchema,
  indexedColumns: [
    { name: 'kvk_number', extract: (p) => p.kvkNumber ?? null },
    { name: 'website', extract: (p) => p.website ?? null },
  ],
  toSummary({ ref, meta, payload, title }) {
    return {
      ...ref,
      meta,
      title,
      subtitle: payload.kvkNumber ?? payload.website ?? null,
      searchableText: /* lowercase digest */,
    };
  },
  searchableText(payload) { /* lowercase digest */ },
};
```

Wired into the HTTP surface from `apps/server/src/http/router.ts` via
`mountCompanyRoutes(app, { db, bus, llm })`, which builds the per-kind
`EntityStore` and delegates to the generic `mountEntityRoutes` factory.
The companies-specific routes are therefore identical in shape to the
ones documented in §4 — the only difference is that requests carry a
`CompanyPayload` body and `GET /l/:slug/company` returns
`{ entities: EntitySummary[] }` with `subtitle = kvkNumber | website | null`.

Companies pass the §4.0 contract suite verbatim
(`apps/server/tests/entities/companies-contract.test.ts` →
`runEntityContractSuite(...)`). The same file adds two extra checks for
the §2 indexed-column path: the per-kind columns receive values on
create / update, and clearing the payload writes `NULL` so the sparse
`idx_companies_kvk` index stays correct.

No connectors / scheduled jobs / lifecycle hooks ship in 4a.1; the KvK
connector and the AI enrichment job follow in 4a.2 / 4a.3.

### 10a.i Routing: singular server URL ↔ plural web URL (4a.5)

The §4.0 generic router mounts `/l/:slug/<kind>/*` directly on the
module's `kind`, so the server-side companies surface lives under the
singular `/l/:slug/company` (e.g. `GET /l/:slug/company`,
`GET /l/:slug/company/_stats`, `POST /l/:slug/company/:companySlug/external-links`).
The web UI shipped in 4a.5 uses the plural `/l/:slug/companies` (list,
detail, create) because that reads more naturally for end users. The
singular↔plural translation lives entirely on the client in
`apps/web/src/lib/companies-routes.ts` (`companiesListWebRoute`,
`companyDetailWebRoute`, `companiesServerBase`, `companyServerDetail`,
`companyServerExternalLinks`, ...). The 4a.1 close-out explicitly
deferred exposing an optional `routeSegment` override on
`EntityModule` until a second entity needs a different mapping —
keeping the helper client-side is the cheaper of the two paths and
isolates the seam to a single file.

---

## 10b. Connectors (4a.2) — dispatch + poll runner + secret-stripping

The §4.0 connector base shipped the `EntityConnector` interface and the
`markSucceeded` / `markFailed` helpers. Phase 4a.2 added the runtime
plumbing every concrete connector reuses. See
[ADR 0012](../decisions/0012-kvk-connector.md) for the rationale.

### Wire layout

```
POST /l/:slug/<kind>/:entitySlug/external-links
  ├── router validates body.connector against `getConnector(kind, id)`
  │     unknown → 400 errors.entity.connectorUnknown (NO row persisted)
  │     known → store.addExternalLink → row with sync_state='idle'
  ├── router publishes `entity.connector.sync.requested`
  ▼
ConnectorDispatcher (subscriber, registered ONCE per process)
  ├── lookup connector via registry
  ├── resolve per-layer config from layer_attachments
  │     (kind='connector', ref_id=<connectorId>)
  ├── setSyncingState (DB only — does NOT republish requested)
  ├── connector.pull(ctx, { externalId })
  │     ctx.config carries apiKey / endpoint / pollIntervalMinutes
  │     ctx.db / ctx.bus reserved for future per-connector helpers
  └── on success: markSucceeded → publish .succeeded
      on throw:   markFailed    → publish .failed
                  err.message starting with `errors.` is preserved;
                  anything else becomes `errors.entity.syncFailed`

ConnectorRunner (interval-driven, default 60s tick)
  for every registered (kind, connector):
    for every active external link in any layer:
      if sync_state == 'idle' AND age > pollIntervalMinutes:
        publishSyncRequested  → flows through the same dispatcher
```

`markSyncing` was split into `setSyncingState` (DB write) and
`publishSyncRequested` (publish only). Callers that ASK for a sync
(router POST + runner tick) call `publishSyncRequested`. The dispatcher
subscriber calls `setSyncingState`. This avoids the double-publish that
would otherwise occur when the subscriber tried to "mark" the row
syncing.

### Registry helpers

`registry.ts` exposes `getConnector(kind, id)` and
`listConnectorsForKind(kind)`. Duplicate connector ids per kind throw
at registration. The router uses `getConnector` to validate POST
bodies; the runner uses `listConnectorsForKind` per tick.

### Layer attachment kind extension

`layer_attachments.kind` now accepts `'connector'` in addition to
`'agent' / 'skill' / 'mcp_server'`. The phase-3 CHECK constraint was
extended via the table-rebuild dance in
`apps/server/src/storage/migrations/0007_layer_attachments_connector_kind.sql`
(SQLite does not support `ALTER COLUMN ... CHECK` in place).
`LayerAttachmentKindSchema` in `packages/shared/src/layer.ts` mirrors
the same enum.

### Secret-stripping invariant

Two boundaries enforce that an `apiKey` never crosses an untrusted
edge:

- **The bus.** `entity.connector.sync.*` payloads are closed shapes
  (`{ ref, connector, externalId, [error|syncState] }`). There is no
  path to add `config` to them without changing the type.
- **The link payload.** `entity_external_links.payload_json` is set
  by `store.addExternalLink` and never re-written by the connector's
  `pull`. A future connector that wants to persist non-secret link
  state goes through `scrubConnectorPayload` (which filters known
  secret keys).

The contract is asserted by `companies-kvk-connector.test.ts` — it
captures every event published during a sync, JSON-stringifies it, and
asserts the literal apiKey value never appears.

### Boot wiring

`apps/server/src/index.ts` instantiates the dispatcher and the runner
exactly once. `config.connectors.runnerEnabled` (default `true`)
gates `runner.start()`; `config.connectors.tickMs` controls the
interval. Tests construct their own dispatcher / runner per fixture
and never touch the production singletons — `createApp` does NOT
subscribe the dispatcher.

### First concrete connector

`createKvkConnector(deps)` lives in
`apps/server/src/entities/companies/kvk-connector.ts`. `verify` runs
the strict `KvkConfigSchema` (apiKey ≥ 1 char, optional URL endpoint,
pollIntervalMinutes ≥ 60, default 1440). `pull` fetches Basisprofiel
via the injected `fetch`, maps the response onto a `CompanyPayload`
partial, and throws `errors.connectors.kvk.*` on failure. `push` is a
no-op success — KvK is read-only.

---

## 10c. Enrichment (4a.3) — AI-assisted patches via the per-process runner

Phase 4a.3 ships the first concrete consumer of the 4.0 + 4a.2
foundation: a per-process AI-enrichment runner that applies LLM-
produced patches to entity rows. It is generic — companies is just
the first kind to use it; contacts (4b.3), calendar (4c.3), and todos
(4d.3) reuse the same runner without code changes. ADR
[`0013`](../decisions/0013-entity-enrichment.md) records the
rationale.

### `EnrichmentJob<P>` contract

Each module declares zero or more enrichment jobs:

```ts
interface EnrichmentJob<Payload> {
  readonly id: string;
  readonly runOn: readonly ('created' | 'updated' | 'sync.succeeded')[];
  run(
    entity: Entity<Payload>,
    ctx: EnrichmentJobContext<Payload>,
  ): Promise<EnrichmentResult<Payload>>;
}

interface EnrichmentResult<Payload> {
  readonly patch?: Partial<Payload>;
  readonly note?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly model?: string;
}
```

`ctx` carries the system LLM client (telemetry-wrapped — DO NOT
bypass), the layer id, the trigger, the bus, the db, and the source
correlation id when available. `ctx.module` lets jobs that want to be
generic over kinds read their own module.

The runner — NOT the job — owns patch application:

- For every field in `result.patch`:
  - if the value is `null` / `undefined`, skip (LLM uncertainty);
  - if the entity's current field already has a non-empty value AND
    the field name is not `description`, skip (do not stomp on user
    input — `description` is the one field enrichment is allowed to
    refresh by contract);
  - otherwise apply.
- If anything survives the filter, the runner calls `store.update`
  (which bumps `version`, snapshots `entity_versions`, and publishes
  `entity.<kind>.updated`).
- The runner stamps `entity_souls.memory_json.lastEnrichedAtVersionByJob[jobId]`
  with the post-update version so future ticks can decide whether to
  re-run.

### Runner lifecycle

`createEnrichmentRunner({ db, bus, llm, pricing, config, resolveStore })`
exposes:

- `start()` — subscribes once to `entity.<kind>.{created,updated}` for
  every registered module that declares `enrichmentJobs`, plus a
  single subscription to `entity.connector.sync.succeeded`. Tests
  inject a `listModules` factory to avoid the process-global
  registry.
- `stop()` — detaches every subscription, clears in-flight timers.
- `tickOnce()` — flushes every pending debounced entry synchronously.
  Tests use this instead of fake timers for the debounce half; the
  fake clock is still needed for the rate-limit window.

Within a single `processEntry` pass the runner re-reads the entity
from the store after every successful `applyPatch` so the next job
in the tick observes the merged payload. This was a behaviour fix
on top of the 4c block (see
`docs/dev/follow-ups/done/enrichment-runner-stale-payload.md`).

Production wiring lives in `apps/server/src/index.ts` and respects
`config.enrichment.runnerEnabled` (default `true`).

### Coalescing + rate limit

- **Debounce** — multiple events for the same `(kind, entityId)` within
  `config.enrichment.debounceMs` (default 5000) collapse to one job
  invocation per matching job. Triggers are union-merged so a
  burst of "created, updated, sync.succeeded" still runs every job
  whose `runOn` matches any reason.
- **Per-layer rate limit** — a sliding 60-second window per `layerId`
  caps the LLM-call rate at `config.enrichment.maxRunsPerLayerPerMinute`
  (default 30). On overflow the runner publishes
  `entity.enrichment.deferred` and re-arms the entry's timer to the
  next window so a later tick can satisfy it. The LLM is NOT called
  on the deferred branch.

### Secret-strip invariant

Two boundaries enforce that connector apiKeys never reach an LLM
prompt:

- The 4a.2 dispatcher persists the connector's payload patch via
  `persistConnectorPayloadPatch(...)`, which runs
  `scrubConnectorPayload` (filters `apiKey`, `token`, …) before
  writing to `entity_external_links.payload_json`. The enrichment
  job reads `link.payload.lastPatch` from this scrubbed JSON — there
  is no path from the per-layer attachment row into the job's prompt.
- The bus event payloads added in 4a.3 (`entity.enrichment.*`) are
  closed shapes (`{ kind, entityId, jobId, … }`); no `prompt` or
  `response` field exists. The canonical record of the full
  prompt + response is the `llm_calls` row (telemetry wrapper),
  joined by `correlationId` per ADR `0006`.

A regression test (`companies-enrichment.test.ts §secret-strip
invariant`) configures a known apiKey, drives a full
sync.succeeded → enrichment flow, and asserts the literal value
never appears in any LLM prompt nor any bus event.

### `ConnectorContext.onPayloadPatch` — the 4a.2 → 4a.3 bridge

The 4a.2 ADR left the patch-bridge open by routing patches through
`CreateKvkConnectorDeps.onPayloadPatch` (test-only). 4a.3 adds
`ConnectorContext.onPayloadPatch` so the dispatcher itself can capture
the patch and persist a scrubbed copy on the external link's
`payload_json`. The KvK connector now calls both hooks: `deps.onPayloadPatch`
preserves the deterministic-mapping unit test, and `ctx.onPayloadPatch`
feeds the runner's `fillFields` job.

### Companies jobs (`companies.summary`, `companies.fillFields`)

The two production jobs registered on `companyModule.enrichmentJobs`:

| Job                    | Trigger(s)                             | What it does                                                                                                                                                                                           |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `companies.summary`    | `created`, `updated`, `sync.succeeded` | Asks the LLM for a ≤300-char description; emits an empty result when `payload.description` is already set on a `created` tick. Returns `{ patch: { description }, tokensIn, tokensOut, model }`.       |
| `companies.fillFields` | `sync.succeeded` only                  | Reads `link.payload.lastPatch` (the scrubbed KvK ground-truth persisted by the dispatcher) and asks the LLM to return a JSON object filling missing structured fields. Null-valued fields are skipped. |

Both jobs go through `ctx.llm.chat(...)` (telemetry-wrapped). Cost
is recomputed for the success event using the same `PricingMap` the
LLM wrapper uses, so the event surfaces the per-call USD figure
without joining `llm_calls`.

### Deterministic-first / LLM-fallback pattern (4b.3 onward)

The contacts `suggestCompany` job introduces a pattern future kinds
should reuse when a job has cheap deterministic signals available:

1. **Cheap rules first.** Try every rule that can answer with no LLM
   call — a domain match, an exact normalised name, a stored
   `external_id`. When exactly one candidate emerges, return the
   patch immediately. Burning LLM tokens on a problem rules can
   solve is waste, and the deterministic path is the one tests can
   pin without an LLM stub.
2. **Collect weak candidates.** Rules that match more than one
   company (ambiguous), or a fuzzy match (Levenshtein ≤ 2 over a
   normalised name), produce a candidate set instead of an answer.
3. **LLM only on weak signal.** When step 1 yields no answer AND
   step 2 produced at least one weak candidate, build a minimal
   sanitised prompt (the contact's `(givenName, familyName, primary
email, jobTitle, notes excerpt)`; per-candidate `(slug, title,
website)`) and ask the model for `{ slug, confidence }`. Apply
   the link only when `confidence >= 0.8` and the slug matches a
   candidate. Anything else returns `{}`.
4. **Hard gate on user-set fields.** The runner's `applyPatch`
   refuses to overwrite a non-empty field UNLESS the field name
   appears in `module.enrichmentOverwriteFields` (see 10c.i below),
   but the job ALSO short-circuits when `payload.companyEntityId`
   is already set, so the candidate list is never even enumerated.
   Defense in depth keeps the LLM cost profile predictable.

Concrete production job: `contacts.suggestCompany`
(`apps/server/src/entities/contacts/enrichment.ts`). Runs on
`created`, `updated`, and `sync.succeeded`. Returns either
`{ patch: { companyEntityId }, tokensIn, tokensOut }` or `{}` per the
table below.

| Path                 | Trigger                                                                                 | LLM called? | Result                              |
| -------------------- | --------------------------------------------------------------------------------------- | ----------- | ----------------------------------- |
| Domain (exact, sole) | `primary email` host == company `website` host or `email` domain (modulo `www.`)        | No          | `companyEntityId` applied.          |
| Domain (ambiguous)   | Multiple companies match the same domain                                                | Yes         | Pick if confidence ≥ 0.8, else `{}` |
| ORG hint (exact)     | `ORG: <name>` line in `notes`, normalised exact match against legalName/tradeName/title | No          | `companyEntityId` applied.          |
| ORG hint (fuzzy)     | Same line, Levenshtein ≤ 2 against any candidate                                        | Yes         | Pick if confidence ≥ 0.8, else `{}` |
| No signal            | No email AND no ORG hint, OR no companies in the layer                                  | No          | `{}`                                |
| Already linked       | `payload.companyEntityId` already set                                                   | No          | `{}` (job exits before enumeration) |

Cross-layer isolation is a free property of this pattern: candidate
enumeration walks the layer the contact lives in via the companies
store, so a company in layer A is never visible to a contact in
layer B — there is no shared candidate set across layers.

Secret-strip discipline mirrors 4a.3: the candidate-list projection
hands the LLM only `(slug, title, website)`; the attachment row's
`apiKey` lives in `layer_attachments.config` and never reaches any
company payload. The 4b.3 secret-strip regression test asserts the
literal apiKey never appears in any LLM prompt nor in any bus event.

The third application of the deterministic-first / LLM-fallback
pattern is `calendar.attendeeContacts` (4c.3,
`apps/server/src/entities/calendar/enrichment.ts`). The job walks
each attendee whose `contactEntityId` is unset, tries an exact
lowercase email match against contacts in the same layer, then a
display-name fuzzy match (Levenshtein ≤ 2), and finally an LLM
fallback gated by an email-shaped `value` (free-text attendees such
as room names never reach the LLM). The job returns the FULL
`attendees` array as the patch; the runner applies it via the
`enrichmentOverwriteFields = ['attendees']` affordance documented
below. Per-attendee merging happens INSIDE the job: attendees whose
`contactEntityId` is already set are never modified — same hard gate
the contacts job exposes.

The fourth application is the pair of todos jobs (4d.3,
`apps/server/src/entities/todos/enrichment.ts`):

- `todos.autoPriority` walks a deterministic chain (title /
  description keyword scan → tag scan → `dueAt` proximity → LLM
  fallback at high confidence). Job-level gate: skip when `priority`
  has already been moved off the schema default of 3, OR when
  `status` is `'done'` / `'cancelled'`. Token-cost discipline
  matches the prior three applications — the deterministic steps
  cover most production calls and the LLM is consulted only when
  every cheap signal misses.
- `todos.autoDue` performs a tiny natural-language phrase scan on
  the title (en + nl: `tomorrow`/`morgen`, `today`/`vandaag`,
  `next <weekday>` / `volgende <weekday>`, `by <weekday>` /
  `voor <weekday>`, `this week` / `deze week`). **No LLM
  fallback.** This is the first job in the pattern that
  deliberately stops at "deterministic only": date hallucination
  has user-visible side effects (a wrong due date is worse than no
  due date), so the rule is "show evidence or stay silent". The
  pattern generalises to: _the LLM is an optional last step, not a
  mandatory one_ — modules whose fallback cost outweighs the value
  of a guess MAY omit it entirely.

Both todos jobs are wired through `EntityModule.enrichmentJobs` via
the same conditional-spread pattern 4c.3 introduced. The todo
module declares `enrichmentOverwriteFields: ['priority']` because
the zod schema defaults `priority` to `3` — without the slot the
runner would treat `3` as a "set value" and drop the auto-priority
patch. The job's own gate
(`priority !== undefined && priority !== 3 → skip`) is the user-
intent protection. `dueAt` has no schema default and is genuinely
`undefined` when unset, so it relies on the runner's "fill the
blank" default. See `docs/dev/decisions/0013-entity-enrichment.md`
Update (4d.3) for the rationale.

### 10c.i `enrichmentOverwriteFields` — per-module overwrite slot (4c.3)

The runner's default protection is "do not overwrite a non-empty
user field". Concrete jobs sometimes need exactly one or two
exceptions — companies (4a.3) needs to refresh `description` on
every trigger; calendar (4c.3) needs to replace `attendees`
wholesale (per-attendee logic happens inside the job) and to manage
`meetingSummaryNote` as an AI-owned field the user never edits.

The 4a.3 close-out predicted the inevitable generalisation: when a
second exception lands, the policy becomes per-field and lives in
the module rather than in the runner. 4c.3 implements that:

```ts
// EntityModule<P>
readonly enrichmentOverwriteFields?: readonly string[];
```

The runner reads the list at the start of `applyPatch`. For every
patched field with a non-empty existing value, the field name MUST
appear in the list or the patch entry is dropped. Empty / null /
whitespace-only fields stay overridable regardless of the list —
"fill the blank" is the universal default.

The slot is typed loosely (`readonly string[]`, not
`(keyof Payload)[]`) because the runner uses the list at a generic
boundary where `Payload` is erased and the keyof variance does not
survive narrowing. Modules document their entries with a short
comment; the entries match payload field names verbatim.

Per-module declarations as of 4d.3:

| Module           | `enrichmentOverwriteFields`           | Rationale                                                                                                                                                                                                                                                                  |
| ---------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `company`        | `['description']`                     | `companies.summary` refreshes the description on every trigger; matches the previously-hardcoded exception.                                                                                                                                                                |
| `contact`        | (omitted)                             | `contacts.suggestCompany` writes `companyEntityId` only when null — empty-field default already allows it.                                                                                                                                                                 |
| `calendar_event` | `['attendees', 'meetingSummaryNote']` | `calendar.attendeeContacts` replaces attendees wholesale (per-attendee merge inside the job); `meetingSummaryNote` is AI-owned.                                                                                                                                            |
| `todo`           | `['priority']`                        | `priority` has a zod default of `3`; without the slot the runner would treat the default as a set value and drop the patch. Job-level gate (`priority !== 3 → skip`) is the actual user-intent protection. `dueAt` has no schema default and uses the empty-field default. |
| `fixture`        | (per-test override)                   | Test modules declare the list inline to assert both branches of the slot in the contract suite.                                                                                                                                                                            |

This is the **sixth** foundation extension shipped on top of the
§4.0 contract — after `indexedColumns` (4a.1), `getConnector` +
dispatcher + runner (4a.2), `enrichmentJobs` (4a.3),
`statsProvider` (4a.4), and `EntityConnector.ingest` (4b.2). The
runner's per-module overwrite-list logic was a planned evolution,
not a surprise: see the 4a.3 close-out in
`docs/dev/plans/phase-04-first-entities.md` §14.

---

## 10d. Stats provider (4a.4)

Phase 4a.4 added `EntityModule.statsProvider?` so a module can expose
aggregate counts for its dashboard widget. The slot is intentionally
small — same additive shape as `indexedColumns` (4a.1) and
`enrichmentJobs` (4a.3):

```ts
readonly statsProvider?: {
  compute(ctx: { layerId: string; db: Database; now: () => Date }): Record<string, unknown>;
};
```

The generic router exposes the provider's output verbatim at
`GET /l/:slug/<kind>/_stats`. The route registers BEFORE
`/:entitySlug` so Hono's first-match policy resolves `_stats` to the
stats handler rather than treating it as an entity slug. Modules
without a provider return `404 errors.entity.statsUnavailable`.

Design rules per kind:

- **Pure SQL only.** No event-bus subscriptions, no state caching.
  Stats endpoints are cheap, layer-scoped reads that always reflect
  current data.
- **`now()` is injectable.** Time-bucketed counts (e.g.
  "recently enriched in last 24h") MUST consume `ctx.now()` instead
  of `Date.now()` so tests can pin the window.
- **No payload shape contract.** Each kind owns its return shape —
  the router does not validate it. The widget on the web side knows
  what to expect.

The first consumer is `companyStatsProvider`
(`apps/server/src/entities/companies/stats.ts`), which returns
`{ total, withKvk, missingDescription, recentlyEnriched }` for the
Companies dashboard widget. "Recently enriched" reads
`entity_souls.updated_at` — the timestamp the enrichment runner
writes via `recordLastEnriched` in `enrichment-runner.ts`.

Phase 4b.4 added the second consumer: `contactStatsProvider`
(`apps/server/src/entities/contacts/stats.ts`) returns
`{ total, withCompanyLink, missingEmail, recentlyEnriched }` for the
Contacts dashboard widget. It hangs off the exact same
`EntityModule.statsProvider?` slot with ZERO contract changes —
empirical confirmation the §4a.4 foundation generalises to a second
kind cleanly. `withCompanyLink` reads the indexed `company_entity_id`
column from 4b.1 directly; `missingEmail` reads the indexed
`primary_email` column. Stats remain pure SQL, layer-scoped, and
clock-injectable per the design rules above.

Phase 4c.4 added the third consumer: `calendarEventStatsProvider`
(`apps/server/src/entities/calendar/stats.ts`) returns
`{ total, upcomingNext7d, withAttendeesLinked, recentlyEnriched }`
for the Calendar dashboard widget. Same slot, same shape, same zero
contract changes — a third empirical validation of the §4a.4
foundation. `upcomingNext7d` reads the indexed `starts_at` column
from 4c.1 with a `[now, now+7d)` range scan; `withAttendeesLinked`
walks the per-event `payload.attendees[]` array via SQLite's
`json_each(json_extract(...))` and counts events with at least one
attendee carrying a `contactEntityId` — the JSON1 path stays cleaner
than a `LIKE '%contactEntityId%'` approximation while remaining
read-only against the existing `payload_json` column. Stats remain
pure SQL, layer-scoped, and clock-injectable.

Phase 4d.4 added the fourth consumer: `todoStatsProvider`
(`apps/server/src/entities/todos/stats.ts`) returns
`{ totalOpen, dueToday, overdue, highPriorityOpen }` for the Todos
dashboard widget. Same slot, same shape, same zero contract changes —
a fourth empirical validation of the §4a.4 foundation. Every counter
reads the indexed `status`, `priority`, and `due_at` columns the 4d.1
migration added, so the four queries are one-line single-table scans
against indexes. Both date-based counters use a `date(due_at)` projection
against an injected UTC `YYYY-MM-DD` so date-only and full-ISO `dueAt`
shapes compare identically: `dueToday` uses `date(due_at) = ?` and
`overdue` uses `date(due_at) < ?`. Date-only comparison is what makes
the two counters disjoint — a raw lexicographic `due_at < nowIso` would
mis-classify a date-only `dueAt = today` as overdue because
`'YYYY-MM-DD' < 'YYYY-MM-DDT...'`. Phase-4 timezone behaviour is "v1
local-to-user" per the 4c.5 follow-up — the cutoff is currently UTC
at the SQL layer; a timezone-aware variant (and an hour-aware "overdue"
inside today) lands once per-user timezone preferences ship.

The dashboard widget lives in `apps/web/src/dashboard/`. A minimal
client-side registry (`widget-registry.ts`) lets each per-kind
sub-phase add a widget by importing `CompaniesWidget`-style modules
from the `dashboard/widgets` barrel; the registration is a side
effect on import. `LayerDashboardPage` renders every registered
widget — `layer_dashboard_widgets` persistence (per-layer toggling
and layout) is a follow-up.

---

## 10e. Second consumer: contacts (4b.1)

`contactModule` (`apps/server/src/entities/contacts/module.ts`) is the
second concrete `EntityModule` to land on the §4.0 foundation. It
registers under `kind = 'contact'`, writes to the `contacts` table
created by `0008_contacts.sql`, and declares three indexed columns
projected from the JSON payload:

```ts
export const contactModule: EntityModule<ContactPayload> = createContactModule();
// ⇒ kind: 'contact', tableName: 'contacts',
//   payloadSchema: ContactPayloadSchema,
//   indexedColumns: [
//     { name: 'primary_email',     extract: (p) => primaryEmailOf(p) },
//     { name: 'primary_phone',     extract: (p) => primaryPhoneOf(p) },
//     { name: 'company_entity_id', extract: (p) => p.companyEntityId ?? null },
//   ],
//   toSummary: subtitle = primaryEmail ?? primaryPhone ?? jobTitle ?? null,
//   searchableText: lowercased digest of names + emails + phones + jobTitle + notes
```

`primary_email` / `primary_phone` follow the same derivation rule: the
first entry whose `isPrimary` is `true` wins; otherwise the first
entry overall; otherwise `null`. The sparse indexes
`idx_contacts_primary_email` / `idx_contacts_company` skip the `NULL`
rows so listings stay cheap.

`company_entity_id` is a **soft** link to a `companies.id`. The
migration deliberately does NOT model it as a `FOREIGN KEY` so the
link survives a company soft delete and remains usable across future
kinds (the slot is generic — `entity_id`, not `company_id`). Phase
4b.3 validates the link at write time at the route-handler level;
the SQL layer stays kind-agnostic.

Contacts pass the §4.0 contract suite verbatim
(`apps/server/tests/entities/contacts-contract.test.ts` →
`runEntityContractSuite(...)`). The same file adds extra checks for
the indexed-column projection: `isPrimary=true` wins; first-entry
fallback applies when nothing is flagged; clearing the payload writes
`NULL` across the board.

**Zero foundation tweaks landed in 4b.1.** The four extension slots
(`indexedColumns`, `getConnector` / dispatcher / runner,
`enrichmentJobs`, `statsProvider`) introduced during the 4a block
were enough to absorb the second consumer cleanly — empirical
confirmation that the §4.0 contract generalizes beyond the kind it
was extracted with. No `connectors`, `enrichmentJobs`, or
`statsProvider` ship in 4b.1: the vCard import is 4b.2, the
contact↔company suggestion is 4b.3, the dashboard widget is 4b.4.
The `createContactModule(opts)` factory is in place so each of those
sub-phases stays additive.

---

## 10f. Ingest (4b.2) — `EntityConnector.ingest`, vCard import

Phase 4b.2 adds a second method to the connector contract:

```ts
interface EntityConnector<Payload> {
  // ... (pull, push, verify — all optional from 4b.2)
  ingest?(
    ctx: ConnectorIngestContext,
    payload: { contentType: string; bytes: Uint8Array; filename?: string },
  ): Promise<ConnectorIngestResult<Payload>>;
}
```

`pull` is "the dispatcher knows an `externalId`, please fetch one
external record"; `ingest` is "the user uploaded a file (or a webhook
fired) and handed us bytes, please produce a list of entities to
create or update". Both methods coexist on the interface; a connector
implements whichever subset matches its shape. KvK (4a.2) implements
`pull` only. vCard (4b.2) implements `ingest` only. Future Google
Contacts will implement both. See ADR
[`0014`](../decisions/0014-connector-ingest.md) for the rationale.

`ingest` returns a structured result:

```ts
interface ConnectorIngestResult<Payload> {
  readonly entities: ReadonlyArray<{
    readonly title: string;
    readonly payload: Partial<Payload>;
    readonly externalId?: string;
    readonly matchKey?: { kind: 'email' | 'externalId'; value: string };
  }>;
  readonly warnings: readonly string[];
}
```

The dispatcher iterates `entities`, resolves each `matchKey` against
the layer's per-kind table, and dispatches a `store.create` (no match)
or `store.update` (existing row) per item. The dedup column for the
`email` strategy is the `primary_email` indexed column the 4b.1 module
already maintains.

### HTTP route (synchronous)

```
POST /l/:slug/<kind>/_ingest/:connectorId
  Content-Type: multipart/form-data
  field name: file

  ├── requireLayer
  ├── lookup connector via getConnector(kind, id)
  ├── validate `file.size <= ingestMaxBytes` BEFORE reading bytes
  ├── dispatcher.ingest(...) ← awaited synchronously
  └── 200 { created, updated, warnings }
```

The route is mounted BEFORE `/:entitySlug` so the `_ingest` prefix
wins over a hypothetical entity slug. Errors map to localized keys:
unknown connector → `errors.entity.connectorUnknown` (400); oversize
body → `errors.connectors.vcard.tooLarge` (413); connector throw →
its `errors.` key (400, e.g. `errors.connectors.vcard.invalidContentType`).

Synchronous (vs the async path that 4a.2 uses for `pull`) because the
user is waiting on a clicked "Import" button. ADR 0014 §5.

### Events

```
entity.connector.ingest.requested  { kind, connectorId, layerId, contentType, byteLength }
entity.connector.ingest.completed  { kind, connectorId, layerId, created, updated, warningCount }
```

Per-entity `entity.<kind>.{created,updated}` events fire from the
generic store during processing. The ingest events themselves carry
NO `bytes` and NO `filename` — that is the secret-strip invariant for
ingest, asserted by `contacts-vcard-connector.test.ts`. There is no
`ingest.failed` event — a connector throw becomes the HTTP response's
`errors.*` key; the per-entity events emitted during the loop are the
failure-resilient signal.

### vCard parser + connector

`apps/server/src/entities/contacts/vcard.ts` is a hand-written vCard
3.0 / 4.0 parser (no dependency). It covers `FN`, `N`, `EMAIL`,
`TEL`, `ORG`, `TITLE`, `BDAY`, `NOTE`, `URL`, `ADR`; tolerates CRLF /
LF / folded continuation lines / quoted-printable; never throws on a
single bad entry — the function returns whatever it could parse and
a list of `errors.connectors.vcard.*` warnings.

`apps/server/src/entities/contacts/vcard-connector.ts` wraps the
parser as the contact module's first `EntityConnector`. The connector
validates the content type (`text/vcard`, `text/x-vcard`, or a `.vcf`
filename) and maps every parsed contact to a result item with
`matchKey = { kind: 'email', value: primaryEmail.toLowerCase() }`
when an email exists. Cards without an email are always created.

### Foundation extension

ADR 0014 §1 — `EntityConnector.pull` / `push` become optional;
`ingest` is the new optional third method. The dispatcher rejects
pull dispatch for a connector with no `pull`
(`errors.connectors.pullNotSupported`) and ingest dispatch for a
connector with no `ingest` (`errors.connectors.ingestNotSupported`).

---

## 10g. Third consumer: calendar events (4c.1)

`calendarEventModule` (`apps/server/src/entities/calendar/module.ts`)
is the third concrete `EntityModule` to land on the §4.0 foundation.
It registers under `kind = 'calendar_event'`, writes to the
`calendar_events` table created by `0009_calendar_events.sql`, and
declares five indexed columns projected from the JSON payload:

```ts
export const calendarEventModule: EntityModule<CalendarEventPayload> = createCalendarEventModule();
// ⇒ kind: 'calendar_event', tableName: 'calendar_events',
//   payloadSchema: CalendarEventPayloadSchema,
//   indexedColumns: [
//     { name: 'starts_at',            extract: (p) => p.startsAt },
//     { name: 'ends_at',              extract: (p) => p.endsAt ?? null },
//     { name: 'all_day',              extract: (p) => p.allDay ? 1 : 0 },
//     { name: 'rrule_string',         extract: (p) => p.rruleString ?? null },
//     { name: 'external_calendar_id', extract: (p) => p.externalCalendarId ?? null },
//   ],
//   toSummary: subtitle = `${startsAt}${location ? ' · ' + location : ''}` (capped at 120 chars),
//   searchableText: lowercased digest of summary + description + location
//                   + attendees' values + displayNames + conferenceUrl
```

The headline finding for 4c.1: the typed indexed-column projection
(`IndexedValue = string | number | null` in `apps/server/src/entities/store.ts`)
handles the `all_day INTEGER` column **without any foundation change**.
The four other indexed columns (`starts_at`, `ends_at`, `rrule_string`,
`external_calendar_id`) are `TEXT`; `all_day` is `INTEGER`. The store's
generic INSERT / UPDATE binds whichever primitive the `extract`
callback returns, and SQLite stores it in the column's native type. The
first non-TEXT indexed column the foundation accepted is empirical
proof that the slot generalises beyond strings.

`starts_at` is `NOT NULL` in the migration because every event must
have a start time; the zod payload schema enforces the same invariant
(`startsAt: z.string().min(1)` — required). The other four columns
are nullable so a layer can own a "draft" event (title + startsAt
only) before the 4c.2 Google Calendar connector or the 4c.5 web UI
fills the remaining fields.

`ends_at` is nullable, and the `endsAt >= startsAt` constraint lives
at the zod superRefine layer, NOT in SQL — the constraint compares
ISO-8601 strings lexicographically (sound for the format) and surfaces
as `errors.entity.calendar.endsBeforeStarts`. The application-layer
choice is intentional: SQLite CHECKs can't reach into the JSON
payload's mixed timestamp / date-only spaces.

`rrule_string` is stored verbatim and **never expanded at runtime in
v1** (§2 of `docs/dev/plans/phase-04-first-entities.md`). The web UI
in 4c.5 renders only the master occurrence; a future v2 will expand
recurrence client-side.

Calendar events pass the §4.0 contract suite verbatim
(`apps/server/tests/entities/calendar-contract.test.ts` →
`runEntityContractSuite(...)`). The same file adds extra checks for
the five indexed-column projections: `starts_at` round-trips
verbatim, `all_day` writes 0 / 1 as a JS `number` (SQLite returns the
column as `number`, confirming the INTEGER lane), and clearing the
optional fields writes `NULL` across the board.

**Zero foundation tweaks landed in 4c.1.** The five extension slots
(`indexedColumns`, `getConnector` / dispatcher / runner,
`enrichmentJobs`, `statsProvider`, `EntityConnector.ingest`) already
in place from the 4a / 4b blocks were enough to absorb the third
consumer cleanly — empirical confirmation that the §4.0 contract
generalises beyond the kinds it was extracted with. No `connectors`,
`enrichmentJobs`, or `statsProvider` ship in 4c.1: the Google
Calendar connector lands in 4c.2, the meeting-summary + attendee-link
enrichment in 4c.3, the dashboard widget in 4c.4. The
`createCalendarEventModule(opts)` factory is in place so each of
those sub-phases stays additive.

---

## 10h. OAuth connector (4c.2) — Google Calendar with `pull` + `ingest`

Phase 4c.2 is the first connector to implement BOTH halves of the
foundation:

- `pull(ctx, { externalId })` — fetches a single event by id via
  `events.get` (used by the interval runner for periodic re-sync).
- `ingest(ctx, { contentType, bytes })` — performs a bulk
  `events.list` sync (triggered by a "Sync now" button or a future
  scheduled task).

The 4b.2 ADR (`0014-connector-ingest.md`) predicted this composition.
4c.2 confirmed it empirically: zero contract changes were needed
between the two slots. The connector's `id` is `'google.calendar'`,
its `kind` is `'calendar_event'`. See
`apps/server/src/entities/calendar/google-connector.ts`.

### Token storage model

OAuth credentials live on a single per-layer attachment row
(`kind='connector'`, `ref_id='google.calendar'`), with the
`clientSecret` and `refreshToken` fields stored as encrypted envelopes
(see ADR 0015):

```
config = {
  clientId,
  clientSecret: 'enc:v1:<iv>:<ct>:<tag>',
  refreshToken: 'enc:v1:<iv>:<ct>:<tag>',
  calendarId,
  pollIntervalMinutes,
  syncToken?,        // non-secret; written back after a successful list
  attachmentId,      // injected by the dispatcher's resolver
}
```

Per-event link state (`entity_external_links.payload_json`) carries
ONLY the non-secret `lastPatch` + `lastPatchedAt` written by the
existing `persistConnectorPayloadPatch` helper. Refresh + client
secrets NEVER appear in the link payload or in any bus event — the
`scrubConnectorPayload` whitelist covers it, and the
`calendar-google-connector.test.ts` leak canary asserts the invariant
across a full pull + ingest run.

Access tokens are held in an in-memory cache, keyed by
`(clientId, refreshToken envelope)`, with a 60-second clock-skew
margin. The runner's stale-link iteration therefore reuses one access
token per minute of polling against the same attachment.

### Sync-token persistence

Google's `events.list` returns a `nextSyncToken` that scopes future
calls to the delta. The connector persists it directly into the
attachment via the new `layer_attachments.updateAttachmentConfig` repo
method, preserving every other field (encrypted envelopes untouched).
A 410 response — "syncToken expired" — surfaces as a warning, and the
next call falls back to the full time-window sync.

### Cancelled events

The ingest contract has create + update only (no delete path). The
connector surfaces Google's `status='cancelled'` events as warnings
(`errors.connectors.google.calendar.cancelledIgnored:<eventId>`) so an
operator can see them. The follow-up
`docs/dev/follow-ups/ingest-delete-semantics.md` tracks the proper
soft-delete extension.

### Foundation tweaks

- New shared infra: `apps/server/src/storage/secrets.ts` and
  `config.secrets.encryptionKey` (see ADR 0015). This is shared
  infrastructure, NOT an entity-contract extension — no
  `EntityModule`, `EntityStore`, or `EntityConnector` slot was added.
- New repo method: `LayerAttachmentsRepo.updateAttachmentConfig`. Used
  by the connector to write `syncToken` back after a successful list.
  Future stateful-list connectors (Google Contacts, Microsoft 365)
  inherit it for free.
- `CreateCalendarEventModuleOptions` gained the `connectors?` slot
  (mirrors the contacts factory pattern). The default singleton
  `calendarEventModule` stays connector-less; production wiring builds
  the production variant via `buildProductionCalendarEventModule()`.

---

## 10i. Fourth consumer: todos (4d.1)

The todos kind is the fourth concrete consumer on top of the §4.0
foundation. It is the FIRST consumer with a **polymorphic cross-kind
link**: `payload.linkedEntityRef` points at EITHER a contact OR a
company (e.g. "Call AMI BV", "Send proposal to Alice"). Two design
options were on the table — two separate optional fields
(`linkedCompanyEntityId?`, `linkedContactEntityId?`) versus a single
`{ kind, entityId }` object — and we picked **the object shape**
because it keeps the polymorphic intent explicit at the data layer
and a client can resolve without a separate lookup. The §4.0
`indexedColumns` slot accepts the projection into TWO sparse-indexed
SQL columns (`linked_entity_id`, `linked_entity_kind`) via two
declarations. A SQL CHECK enforces "both set or both null" as a
defensive backstop for the zod invariant.

### What landed (4d.1)

- Migration `0010_todos.sql` — `todos` per-kind table with the §5
  shared columns plus five indexed projections (`status`, `priority`,
  `due_at`, `linked_entity_id`, `linked_entity_kind`). The
  `priority` column is the **second non-TEXT indexed column** the
  foundation accepts (calendar's `all_day` was the first); the
  `IndexedValue = string | number | null` type space already
  accommodates both kinds of integer — zero foundation tweaks.
- Shared zod schemas in `packages/shared/src/todos.ts`:
  `TodoStatusSchema` (enum of `open` / `in_progress` / `blocked` /
  `done` / `cancelled`), `TodoPrioritySchema` (int 1..5),
  `TodoLinkedEntityKindSchema` (enum of `company` / `contact`),
  `TodoLinkedEntityRefSchema`, `TodoPayloadSchema`,
  `CreateTodoRequestSchema`, `UpdateTodoRequestSchema`.
- `todoModule` in `apps/server/src/entities/todos/module.ts` with the
  five-entry `indexedColumns` declaration, a subtitle that composes
  `status · due <dueAt> · @<linkedEntityKind>`, and a lowercase
  search digest.
- Wire-up helper `apps/server/src/entities/todos/index.ts` exports
  `registerTodoModule()` (idempotent — short-circuits when ANY todo
  module is already registered, mirroring the 4a.6 / 4b / 4c
  pattern) and `mountTodoRoutes`. Wired into the production app
  from `apps/server/src/http/router.ts` alongside the existing
  companies + contacts + calendar wiring.
- Contract suite for the kind in
  `apps/server/tests/entities/todos-contract.test.ts` — runs the
  §4.0 reusable suite against `todoModule`, including the
  PATCH-merge regression that landed with the post-4c router fix,
  plus per-kind assertions for the five indexed-column projections
  and the subtitle shape.

### Cross-kind link validation — Option 2 (inline wrapper)

`payload.linkedEntityRef.entityId` MUST resolve to a non-deleted
entity of the matching kind in the SAME layer as the todo. The §4.0
generic router is kind-agnostic and does NOT know about cross-kind
links. Two options were considered:

- **Option 1 — `EntityModule.validatePayload?` foundation slot.**
  Adds a seventh extension slot. Reusable for future cross-kind
  checks (e.g. the deferred calendar-attendee → contact validation).
- **Option 2 — inline per-kind middleware.** A small Hono
  middleware registered by `mountTodoRoutes` BEFORE
  `mountEntityRoutes` on the `/l/:slug/todo` and
  `/l/:slug/todo/:entitySlug` paths. The middleware reads
  `c.req.json()` (Hono caches the parsed body so the downstream
  POST/PATCH handler reads the same data), inspects
  `payload.linkedEntityRef`, and rejects unknown / cross-layer
  links with `errors.entity.todos.linkedEntityNotFound` (400).

**We picked Option 2.** The brief mandates zero foundation tweaks if
at all possible, and 4d.1 is the FIRST cross-kind link consumer —
extracting a slot before a second consumer exists would be premature.
The validator lives in
`apps/server/src/entities/todos/validate-link.ts` as a pure synchronous
function over `(payload, layerId, db)`. The middleware that calls it
sits inside `apps/server/src/entities/todos/index.ts`. If a SECOND
consumer arrives (e.g. the deferred calendar-attendee → contact
write-time check), THAT is the trigger to extract a foundation slot
(`EntityModule.validatePayload?`) — design-once-for-all-future-kinds,
per the bar set by the prior six extension slots.

### Automatic `completedAt` normalization — skipped in 4d.1

The schema accepts `completedAt` as an optional ISO timestamp so a
future client can write it on `status='done'`. The §4.0 lifecycle
hooks (`onUpdate`) fire AFTER the row write and cannot mutate the
persisted payload, so automatic server-side normalization would
require adding a "transform before persist" lifecycle hook — a
seventh foundation slot. Per the brief's "at most one" foundation
tweak budget and the rule "extract once a second consumer asks for
it", we skip the auto-normalization for 4d.1. The 4d.5 web UI will
set `completedAt` explicitly when the user marks a todo done; the
schema is forward-stable so flipping to server-side normalization
later is a non-breaking change.

### Foundation tweaks (4d.1)

- **None.** The six §4.0 + 4a / 4b / 4c extension slots
  (`indexedColumns`, `getConnector` + dispatcher + runner,
  `enrichmentJobs`, `statsProvider`, `EntityConnector.ingest`,
  `enrichmentOverwriteFields`) covered the fourth consumer cleanly.
  The polymorphic link, the dual indexed-column projection
  (`linked_entity_id` + `linked_entity_kind`), the mixed
  TEXT/INTEGER projections, and the cross-kind validation all
  composed additively over the existing slots. This is the
  EMPIRICAL confirmation the contract is stable after four
  consumers.

---

## 11. Related docs

- `docs/dev/architecture/overview.md` — the spine; entities sit
  between layers and the chat retrieval.
- `docs/dev/architecture/layers-and-auth.md` — the resolver every
  entity read inherits.
- `docs/dev/architecture/event-bus.md` — `entity.*` taxonomy lives
  there alongside `layer.*` and `user.*`.
- `docs/dev/decisions/0011-entity-contract.md` — the per-kind +
  shared decision and the module-registry rationale.
- `docs/dev/decisions/0012-kvk-connector.md` — connector config
  location, async dispatch model, poll runner, secret-stripping.
- `docs/dev/decisions/0013-entity-enrichment.md` — enrichment runner
  shape, rate limit + coalescing, per-job declaration on
  `EntityModule`, secret-strip invariants.
- `docs/dev/decisions/0015-secret-encryption.md` — symmetric secret
  envelope, AES-256-GCM, version prefix, key-absence semantics.
- `docs/dev/decisions/0016-google-calendar-connector.md` — token
  storage model, per-event vs. per-layer link split, sync-token
  persistence, MVP "paste refresh token" UX decision.
- `docs/dev/decisions/0014-connector-ingest.md` — second connector
  method (`ingest`), synchronous HTTP dispatch, dedup-by-matchKey,
  ingest event taxonomy, anti-leak invariants for upload bytes.
- `docs/dev/plans/phase-04-first-entities.md` — the phase plan;
  per-kind sub-phases (4a..4d) and the §13 risk table.
