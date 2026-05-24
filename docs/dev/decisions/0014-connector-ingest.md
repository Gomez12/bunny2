# ADR 0014 — Connector `ingest`: a second method on `EntityConnector`, synchronous HTTP dispatch, dedup-by-matchKey

- Status: accepted
- Date: 2026-05-24
- Phase: 4 (4b.2 — vCard import lands on top of the §4.0 entity contract + 4a.2 dispatcher)
- Related: `docs/dev/plans/done/phase-04-first-entities.md` §4.1 4b.2;
  ADR [`0011`](./0011-entity-contract.md) — entity contract;
  ADR [`0012`](./0012-kvk-connector.md) — KvK connector (pull, async dispatch);
  `apps/server/src/entities/connectors/base.ts` (`EntityConnector` extended with `ingest`);
  `apps/server/src/entities/connector-dispatcher.ts` (synchronous `ingest(...)` entry point);
  `apps/server/src/entities/contacts/vcard.ts` (parser);
  `apps/server/src/entities/contacts/vcard-connector.ts` (first ingest-only connector);
  `apps/server/src/entities/router.ts` (`POST /l/:slug/<kind>/_ingest/:connectorId`).

---

## Context

ADR 0012 defined the connector framework around `pull` — "the dispatcher
knows an `externalId`, please fetch one external record". That covers
KvK (4a.2) and will cover Google Calendar (4c.2). It does NOT cover the
shape vCard import needs:

- The user uploads a `.vcf` file.
- The parser produces **N contact payloads** from one upload.
- Each parsed contact becomes a NEW contact entity, or updates an
  EXISTING one matched by primary email.
- There is no upstream "external id" to keep linked — the file is a
  one-shot import, not a stay-in-sync feed.

Three options were on the table:

1. **Bypass the connector framework.** Add a one-off `POST
/l/:slug/contact/import-vcard` route that parses + creates inline.
   Simple — but vCard would not appear in the connector registry, in
   the layer-attachment story, or in the bus event taxonomy.
2. **Extend `EntityConnector` with an `ingest` method.** Both methods
   coexist on the interface; vCard implements only `ingest`. The
   dispatcher gains an `ingest(...)` entry point that the HTTP route
   awaits synchronously.
3. **Treat the file checksum as an `externalId` and reuse `pull`.**
   Conceptually awkward — the checksum isn't an id you can fetch from,
   and `pull` semantics would have to change to "create N entities"
   instead of "fetch one record".

Option 2 wins because it generalises: Google Contacts (planned
follow-up) will use `ingest` for the webhook-delivered single-contact
change, CSV import will use it, Trello import (4d.2 placeholder) will
use it. The shape is a fifth foundation extension after
`indexedColumns` (4a.1) / `getConnector` + dispatcher (4a.2) /
`enrichmentJobs` (4a.3) / `statsProvider` (4a.4) — a real second-
consumer gap, addressed once.

---

## Decision

### 1. `EntityConnector.ingest` is a second optional method on the interface

`pull` and `push` become optional on the interface (they were always
required before 4b.2). `ingest` is the third optional method:

```ts
interface EntityConnector<Payload> {
  readonly id: string;
  readonly kind: string;
  pull?(ctx, input): Promise<void>;
  push?(ctx, entity): Promise<void>;
  verify(config): Promise<string | null>;
  ingest?(ctx, payload): Promise<ConnectorIngestResult<Payload>>;
}
```

A connector implements whichever subset matches its shape. KvK keeps
implementing `pull` (and a no-op `push`); vCard implements only
`ingest`. The dispatcher rejects pull dispatch for a connector with no
`pull` (`errors.connectors.pullNotSupported`) and ingest dispatch for a
connector with no `ingest` (`errors.connectors.ingestNotSupported`).

### 2. `ConnectorIngestPayload` carries the raw bytes

```ts
interface ConnectorIngestPayload {
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly filename?: string;
}
```

Generic enough for vCard, CSV, JSON-import bodies, and OAuth-callback
payloads. The connector decides what to do with the bytes — vCard's
connector validates the content type or filename extension and hands
the bytes to its parser. The dispatcher does not inspect the bytes.

### 3. `ConnectorIngestResult<P>` carries N entities + warnings

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

The connector parses and maps; the dispatcher iterates the array and
creates or updates each entity. The connector NEVER calls
`store.create` / `store.update` itself — that boundary lives in the
dispatcher so secret discipline + event emission stay centralized.

### 4. `matchKey` drives dedup against the layer

The dispatcher resolves each `matchKey` against the per-kind table in
the entity's layer:

- `email`: case-insensitive lookup on the per-kind `primary_email`
  indexed column. The contacts module already maintains this column
  (4b.1) — no new SQL, no new indexed column.
- `externalId`: lookup via `entity_external_links` for a row with
  `{ connector, external_id }` in the layer. Reserved for upcoming
  webhook-style connectors (Google Contacts).

A `null` / missing `matchKey` ⇒ no dedup ⇒ always create. vCard sets a
`matchKey` only when the parsed contact has a primary email; cards
without an email are always created (and the parser warns if the same
file has duplicates that drift through this path).

### 5. The HTTP dispatch is synchronous

`POST /l/:slug/<kind>/_ingest/:connectorId` awaits
`dispatcher.ingest(...)` and returns 200 with the numeric summary:

```json
{ "created": 3, "updated": 0, "warnings": [] }
```

This is the opposite of the `pull` HTTP path (which returns 201
immediately with `sync_state='idle'` and dispatches via the bus). The
reason: the user just clicked "Import" and is staring at a spinner. An
async path would force the UI to either poll the dispatcher's bus
events (no SSE in v1 — see ADR 0012 §"Negative") or accept "submitted —
check back later" semantics, both worse than the few seconds the import
takes.

The synchronous path still emits bus events:

- One `entity.connector.ingest.requested` BEFORE the connector runs.
- Per-entity `entity.<kind>.{created,updated}` from the generic store
  during the processing loop.
- One `entity.connector.ingest.completed` AFTER, carrying the numeric
  summary.

Subscribers (translator runner, enrichment runner, future LanceDB
writer) see the per-entity events and do their work. They never see the
`bytes` field.

### 6. Event payload taxonomy split

`pull` events: `entity.connector.sync.{requested,succeeded,failed}` —
per-link, carry `{ ref, connector, externalId, ...}`.

`ingest` events: `entity.connector.ingest.{requested,completed}` —
per-import (not per-entity), carry `{ kind, connectorId, layerId,
contentType, byteLength }` and `{ kind, connectorId, layerId, created,
updated, warningCount }` respectively. There is no `failed` event for
ingest — a connector throw becomes the HTTP response's `errors.*` key
and never reaches the bus. (The per-entity `.created` / `.updated`
events emitted during the loop are the failure-resilient signal — if
the connector throws mid-loop, the UI sees the count it did manage.)

### 7. Anti-leak invariants for ingest

- `entity.connector.ingest.requested` carries `contentType` +
  `byteLength` only. **Never** the raw `bytes`. **Never** the
  `filename` (filename can leak PII — `Alice Doe contacts.vcf`).
- `entity.connector.ingest.completed` carries a numeric summary only.
- The connector NEVER copies `bytes` / `filename` into the bus or into
  `entity_external_links.payload_json`. vCard's connector touches
  neither (no external links created at all).

Asserted by the secret-strip test in
`apps/server/tests/entities/contacts-vcard-connector.test.ts`.

### 8. Per-attachment config slot stays for parity

Even though vCard takes no config, the connector still declares a
strict empty zod schema in `verify`. The framework's `layer_attachments`
slot is preserved so a future ingest connector that needs an OAuth
token (Google Contacts) plugs in without a fifth foundation tweak.

The current dispatcher passes `{}` when no attachment exists — vCard
ingest works without a `kind='connector'` attachment row.

---

## Consequences

- **Positive.** The connector framework now covers both
  pull-by-externalId and push-by-payload semantics. Future Google
  Contacts (webhook), CSV import, JSON import all reuse the same
  `ingest` shape with no further foundation changes.
- **Positive.** `pull` and `push` are optional, so future read-only or
  ingest-only connectors stop having to implement no-op stubs.
- **Positive.** Per-entity events surface during a multi-row ingest, so
  downstream subscribers (translator, enrichment, LanceDB) see normal
  `created` / `updated` events for every imported row — no special
  handling needed.
- **Negative.** The HTTP path is synchronous and blocks the request
  for the duration of the parse + N store writes. For a 5 MB vCard
  (~5k contacts) this can take a few seconds. The default
  `ingestMaxBytes = 5 MB` keeps the worst case bounded; operators that
  need bigger imports raise the cap and tolerate the latency.
- **Negative.** There is no per-row error event from the dispatcher;
  if the parser silently dropped 100 cards the user sees the warnings
  array in the HTTP response, but a subscriber that wants per-row
  warnings does not get them on the bus. Acceptable for the current
  scope — when a second consumer wants per-row signals we add an
  `entity.connector.ingest.itemFailed` event.
- **Open.** Streaming. The current path materialises the whole file
  in memory before calling the parser. A future streaming-parse variant
  could process line-by-line; not needed at 5 MB.

---

## Alternatives considered

- **Option A: One-off route, no connector framework.** Rejected
  because every future "import from file" connector would copy-paste
  the parsing-plus-create boilerplate, and "vCard" would not appear in
  the connector registry the chat agent (phase 6) enumerates.
- **Option C: File checksum as externalId.** Rejected because the
  semantics of `pull` would have to change to "create N entities from
  one record", and the per-entity `externalId` invariant (one external
  record ⇔ one entity) would break.
- **Async dispatch + SSE for progress.** Considered but rejected for
  v1. The UI would need polling or an SSE channel that does not yet
  exist; sub-5-second imports do not warrant the complexity. See ADR
  0012 §"Negative" for the same trade-off on the pull side.
- **Per-row warning events.** Considered but rejected: the warnings
  array in the response covers the UI's needs; the bus event keeps the
  closed numeric shape (per ADR 0011 §anti-leak).
