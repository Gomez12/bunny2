# ADR 0016 — Google Calendar connector (phase 4c.2)

Status: accepted (2026-05-24).

## Context

Phase 4c.2 is the calendar block's first integration with an upstream
system. Google Calendar exposes both per-event reads (`events.get` —
matches our `EntityConnector.pull` slot) and bulk-list reads
(`events.list` — matches `EntityConnector.ingest`). It is also the first
connector with non-trivial auth: OAuth refresh tokens that the server
must hold and rotate access tokens against.

This ADR records four decisions that are not obvious from the §4.0
contract alone.

## Decisions

### 1. Token storage model: encrypted envelopes in `layer_attachments`

`refreshToken`, `clientSecret`, and `clientId` live on a single per-layer
`layer_attachments` row with `kind = 'connector'`, `ref_id =
'google.calendar'`. The secrets are stored as `enc:v1:` envelopes — see
ADR 0015. The access token is held only in-memory, in a per-connector
cache keyed by `(clientId, refreshToken envelope)`, with a 60-second
clock-skew margin before TTL expiry.

Per-event state — `etag`, `lastSyncedAt`, the connector-mapped patch —
lives in `entity_external_links.payload_json`, scrubbed by the
existing `scrubConnectorPayload` helper. No secret ever lands in the
link payload.

### 2. Per-event link vs. per-layer link split

Each Google calendar event becomes one `entity_external_links` row
(`connector='google.calendar'`, `external_id=<google_event_id>`). The
poll runner (4a.2 infra) iterates these rows and dispatches one `pull`
per stale row — same model as KvK.

The per-layer OAuth config lives on the attachment row, NOT the link
row. This means a single OAuth grant authorizes many calendar events.

### 3. The connector implements BOTH `pull` and `ingest`

`pull` refreshes a single event by id (used by the runner for periodic
re-sync). `ingest` performs a bulk `events.list` sync (triggered by a
"Sync now" button OR programmatically by a future scheduled task).

This is the first connector to use both halves of the foundation. It
validates that the slots compose cleanly: zero contract changes, the
existing `ConnectorIngestPayload` shape carries an empty `bytes` and a
custom `contentType` (`application/x-google-calendar-list-request`).

### 4. Sync-token persistence

Google's `events.list` accepts an opaque `syncToken` so subsequent calls
return only the delta. We persist it directly into the attachment
config:

- The dispatcher's `resolveConfig` (via
  `createGoogleCalendarConfigResolver`) decorates the resolved blob with
  `attachmentId` so the connector knows which row to write back.
- After a successful `events.list`, the connector calls
  `layer_attachments.updateAttachmentConfig` (new repo method) to
  persist `syncToken: <nextSyncToken>` while preserving every other
  field (encrypted envelopes stay untouched).
- A 410 response from Google means the token expired — the connector
  surfaces a warning and the next call falls back to the full
  time-window sync.

The alternative — emit a structured warning and let the dispatcher
persist — is wordier and forces every future "stateful list" connector
to invent its own dispatcher contract. Direct repo write keeps the
connector's contract narrow: the dispatcher only persists patches.

## MVP scope

- **No OAuth UI yet.** The user obtains a refresh token via Google's
  OAuth playground (or any client), pastes it into a layer-attachment
  form (follow-up below), and the server encrypts it on receipt. A
  future sub-phase wires the full OAuth dance.
- **Read-only.** No `push` is implemented; calendar writes back to
  Google are out of scope.
- **Cancelled events are warnings, not deletes.** The 4b.2 ingest
  contract has create + update only. A follow-up
  (`docs/dev/follow-ups/ingest-delete-semantics.md`) tracks the proper
  soft-delete path.

## Follow-ups

- OAuth-dance UI (`docs/dev/follow-ups/google-calendar-oauth-ui.md`).
- Ingest delete semantics
  (`docs/dev/follow-ups/ingest-delete-semantics.md`).
- Operator runbook for `BUNNY2_ENCRYPTION_KEY` rotation — defer to v2 of
  the secrets envelope.

See implementation:
`apps/server/src/entities/calendar/google-connector.ts`. Test surface:
`apps/server/tests/entities/calendar-google-connector.test.ts`.
