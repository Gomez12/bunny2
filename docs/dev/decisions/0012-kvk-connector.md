# ADR 0012 — KvK connector: config in `layer_attachments`, async dispatch, poll runner, secret-stripping invariants

- Status: accepted
- Date: 2026-05-24
- Phase: 4 (4a.2 — KvK connector lands on top of the §4.0 entity contract)
- Related: `docs/dev/plans/done/phase-04-first-entities.md` §1, §4a.2, §7, §13;
  ADR [`0011`](./0011-entity-contract.md) — entity contract;
  ADR [`0009`](./0009-layer-model.md) — layer model;
  `apps/server/src/storage/migrations/0007_layer_attachments_connector_kind.sql`;
  `apps/server/src/entities/companies/kvk-connector.ts`;
  `apps/server/src/entities/connector-dispatcher.ts`;
  `apps/server/src/entities/connector-runner.ts`;
  `apps/server/src/entities/router.ts` (`POST /external-links` flow);
  `packages/shared/src/layer.ts` (`LayerAttachmentKindSchema`).

---

## Context

Phase 4a.2 ships the first concrete `EntityConnector` — KvK Basisprofiel
— on top of the §4.0 connector base. ADR 0011 fixed the connector
interface; this ADR settles the four design questions that 0011 left
explicitly open:

1. **Where does per-layer connector config (`apiKey`, `endpoint`,
   `pollIntervalMinutes`) live?**
2. **How is `POST /l/:slug/<kind>/:slug/external-links` dispatched
   to the connector — synchronously inside the request, or
   asynchronously via the bus?**
3. **Who polls the connector for scheduled refreshes?**
4. **What is the boundary that guarantees secrets (apiKey, OAuth
   token) never leak into the bus event log or into
   `entity_external_links.payload_json`?**

KvK was picked as the first concrete connector for the same reason
companies were picked as the first concrete entity: it is the simplest
shape that exercises every concern (read-only, one indexable external
id, an apiKey that must NOT leak).

---

## Decision

### 1. Connector config lives in `layer_attachments` with `kind = 'connector'`

A per-layer attachment row carries the `apiKey`, optional `endpoint`,
and optional `pollIntervalMinutes`. The schema lives in the connector
itself (`KvkConfigSchema`); the table just holds opaque JSON.

```text
layer_attachments
  id          UUID
  layer_id    -> layers(id)
  kind        'connector'
  ref_id      'kvk'        -- matches EntityConnector.id
  config_json '{ "apiKey": "...", "pollIntervalMinutes": 1440 }'
  created_at  ISO
```

`LayerAttachmentKindSchema` (cross-package zod) gains `'connector'` and
the `0003_layers.sql` table CHECK is extended via the table-rebuild
dance in `0007_layer_attachments_connector_kind.sql`. No data migration
needed — only the constraint changes.

**Why here and not a bespoke `connector_configs` table?**

- Layer attachments are already the place where "stuff scoped to a
  layer" lives (`agent`, `skill`, `mcp_server` — see ADR 0009 §4 on
  scoping). Connectors are the fourth member of that family.
- The phase-3 `LayerAttachmentsRepo` already exposes the access pattern
  (`listAttachments(layerId, kind)`), so the dispatcher does not need
  any new SQL.
- A future per-deployment "all layers share this connector" mode would
  attach the row to the `everyone` layer; no new table required.

### 2. Async dispatch via the bus

`POST /l/:slug/<kind>/:entitySlug/external-links` returns **201
immediately** with the just-inserted link in `sync_state = 'idle'`.
The route then publishes one `entity.connector.sync.requested` event.
A single per-process subscriber (`ConnectorDispatcher`) consumes the
event, resolves the connector via `getConnector(kind, connectorId)`,
resolves the per-layer config via `LayerAttachmentsRepo`, and runs
`connector.pull(ctx, { externalId })`.

Sync-state transitions are owned by the dispatcher, not the connector:

```text
idle -> syncing (dispatcher: setSyncingState, no publish)
syncing -> idle (dispatcher: markSucceeded, publish .succeeded)
syncing -> error (dispatcher: markFailed, publish .failed)
```

The `markSyncing` helper used to be one call that wrote the row AND
published `requested`. 4a.2 splits it into `setSyncingState` (DB only)
and `publishSyncRequested` (publish only) so the request-event
subscriber never republishes the same event it just received.

**Why async and not synchronous?**

- KvK calls have unpredictable latency (50ms–5s observed in dev).
  Blocking the HTTP response on the network would compromise the
  request-budget discipline established in ADR 0006.
- The dispatcher subscriber is the natural place to centralize secret
  resolution + error mapping. Every future connector inherits the
  same handler, so a 4b.2 vCard connector or a 4c.2 Google connector
  does not duplicate the boilerplate.
- Tests can drive the dispatcher directly via `dispatcher.handle(...)`
  — no event loop required, no real `setInterval` needed for unit
  coverage.

**Why one dispatcher per process and not one per `createApp` call?**

`makeTestApp` builds dozens of `createApp` instances against the same
bus. If the dispatcher subscribed inside `createApp` / a
route-registration helper, each rebuild would stack another handler
on `entity.connector.sync.requested` and every dispatch would fan out
N×. The production wiring (`apps/server/src/index.ts`) instantiates
the dispatcher exactly once; tests instantiate their own per fixture.

### 3. Poll runner — interval-driven, per-link `pollIntervalMinutes`

`ConnectorRunner` runs a `setInterval` (default 60s, configurable via
`config.connectors.tickMs`). On each tick it iterates every
`(kind, connector)` in the registry, fetches every active external
link for that pair, reads the per-layer `pollIntervalMinutes` from the
attachment, and emits `entity.connector.sync.requested` for each link
whose `synced_at` is older than that interval. The dispatcher consumes
the event the same way it does for HTTP-triggered syncs — one code
path, two callers.

Links whose `sync_state` is `syncing` or `error` are SKIPPED. A failed
link does not loop the runner forever; a developer / user retries via
`POST /external-links` (which republishes `requested`).

`config.connectors.runnerEnabled` (default `true`) controls boot-time
`start()`. Smoke / offline runs pass `false`.

### 4. Secret-stripping invariants

The dispatcher is the choke point. Two invariants enforced by code and
asserted by `companies-kvk-connector.test.ts`:

- **Bus events never carry the apiKey.** `entity.connector.sync.*`
  payloads contain `{ ref, connector, externalId, [error|syncState] }` —
  nothing else. The connector receives `apiKey` via `ctx.config`,
  resolved from `layer_attachments` at dispatch time. The bus event
  shape is closed; there is no path to add `config` to it without
  changing `EntityConnectorSyncRequestedPayload`.
- **`entity_external_links.payload_json` never carries the apiKey.**
  The connector's `pull` does NOT update the link payload row; the
  dispatcher only sets the sync-state columns + `synced_at`. A future
  connector that wants to persist non-secret link state writes via the
  generic store helper, which `scrubConnectorPayload` filters before
  writing.

A regression test (`secret-stripping invariant`) captures every event
published during a happy-path AND failure-path sync, JSON-stringifies
the payload + metadata, and asserts the literal apiKey value never
appears.

### 5. KvK-specific choices

- **Endpoint.** Default `https://api.kvk.nl/api/v1/basisprofielen`,
  overridable per-attachment (`endpoint` field) so a test deployment
  can point at a mock. The Basisprofiel endpoint is the leanest one
  that returns the legal name, trade name, address, website, and SBI
  industry — exactly what `CompanyPayload` wants.
- **Auth.** `apikey: <key>` header. KvK supports IP-allow-listed
  apikeys; the connector does not encode that policy — operators
  manage it on the KvK developer portal.
- **`push` is a no-op success.** KvK has no write API.
- **Pull does not write payload.** The connector hands the mapped
  partial-payload through `deps.onPayloadPatch?` so 4a.3's AI
  enrichment can decide which fields to apply. Splitting the read
  from the write keeps the connector deterministic (every input
  produces the same patch) and lets the LLM-assisted decisions live
  in the enrichment job, not in the connector.

---

## Consequences

- **Positive.** Future connectors (vCard 4b.2, Google Calendar 4c.2,
  Trello placeholder 4d.2) inherit the dispatch + runner without any
  new wiring. Each one ships a `verify` schema, a `pull`, and a
  `push` — that's it.
- **Positive.** The secret-stripping invariant is a single test that
  every future connector author can re-run. The boundary is the
  dispatcher, not the connector — there is no copy-paste audit burden.
- **Positive.** The poll runner is `tickOnce`-driven for tests, so
  scheduled refreshes are testable without `setTimeout`.
- **Negative.** The HTTP response of `POST /external-links` does NOT
  return the connector-produced payload. Clients that want immediate
  feedback poll the link's read API (or subscribe to
  `entity.connector.sync.succeeded` via a future SSE stream). For the
  4a.5 UI this is acceptable — the list view re-fetches; for
  long-tail connectors (Google Calendar OAuth-redirect flow) the
  4c.2 ADR will revisit.
- **Negative.** A connector author who throws a raw `Error` instead
  of an `errors.` key string sees `errors.entity.syncFailed` surfaced
  instead. This is a deliberate guardrail — see the dispatcher's
  `safe = message.startsWith('errors.') ? message : 'errors.entity.syncFailed'`
  line. Documented in the connector base file header.
- **Open.** Rate-limiting (KvK enforces 60 req/min per apikey). Not
  in 4a.2 scope; a follow-up adds a token-bucket inside the
  dispatcher when a second connector with rate limits lands.

---

## Alternatives considered

- **Synchronous dispatch inside the HTTP route.** Rejected because
  it couples request latency to the upstream API. Also makes test
  setup harder — every test would need a stubbed connector wired in
  globally.
- **Per-connector subscriber instead of a central dispatcher.**
  Rejected because each subscriber would have to re-resolve config
  and re-implement the `markSucceeded` / `markFailed` boilerplate,
  exposing four future connector authors to the secret-stripping
  invariants.
- **Storing connector config in a new `connector_configs` table.**
  Rejected because `layer_attachments` already exists and answers
  the same access pattern; adding a fifth table for one new dimension
  would proliferate joins without buying anything.
- **Per-attachment `lastPolledAt` column on `layer_attachments`.**
  Rejected because the staleness signal lives on the _external link_,
  not on the attachment — one attachment can have N entities each
  with their own `synced_at`. The current design walks links;
  attachments only carry the interval.
