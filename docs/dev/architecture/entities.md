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
  toSummary(input: { ref; meta; payload }): EntitySummary;
  searchableText(payload): string;
  readonly connectors?: readonly EntityConnector<Payload>[];
  readonly scheduledJobs?: readonly EntityScheduledJob[];
  readonly onCreate?: EntityLifecycleHook<Payload>;
  readonly onUpdate?: EntityLifecycleHook<Payload>;
  readonly onSoftDelete?: EntityLifecycleHook<Payload>;
  readonly onRestore?: EntityLifecycleHook<Payload>;
}
```

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

## 11. Related docs

- `docs/dev/architecture/overview.md` — the spine; entities sit
  between layers and the chat retrieval.
- `docs/dev/architecture/layers-and-auth.md` — the resolver every
  entity read inherits.
- `docs/dev/architecture/event-bus.md` — `entity.*` taxonomy lives
  there alongside `layer.*` and `user.*`.
- `docs/dev/decisions/0011-entity-contract.md` — the per-kind +
  shared decision and the module-registry rationale.
- `docs/dev/plans/phase-04-first-entities.md` — the phase plan;
  per-kind sub-phases (4a..4d) and the §13 risk table.
