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
- `docs/dev/plans/phase-04-first-entities.md` — the phase plan;
  per-kind sub-phases (4a..4d) and the §13 risk table.
