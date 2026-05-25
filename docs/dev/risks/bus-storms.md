# Risk — Event-bus storms when AI enrichment cascades

- Status: mitigated, monitored
- Owner / area: enrichment runner + durable bus
  (`apps/server/src/entities/enrichment-runner.ts`,
  `apps/server/src/entities/translator.ts`,
  `apps/server/src/chat/embeddings/subscriber.ts`,
  `packages/bus/src/adapters/durable-sqlite.ts`)
- Related: `docs/dev/plans/overall.md` §9 (risk row 2);
  `docs/dev/architecture/event-bus.md`;
  ADR [`0019`](../decisions/0019-durable-sqlite-message-bus.md);
  ADR [`0013`](../decisions/0013-entity-enrichment.md);
  ADR [`0021`](../decisions/0021-embedding-and-lance-auth-tag.md).

---

## Description

Every entity write publishes `entity.<kind>.created|updated|...` to
the durable SQLite bus. Several heavy subscribers fan out from
those events:

- `translator` — re-encodes the payload per non-original locale.
- `enrichment-runner` — calls the LLM to fill auto-fields
  (contact priority, todo due-date inference, etc.).
- LanceDB embedding `subscriber` — re-encodes
  `searchable_text` and upserts the vector row.
- (Phase 7) `chat.review-layer` — mines telemetry on a cadence,
  but a high-frequency proposal-minting loop could also spin if
  the upstream signal storms.

A few cascade shapes can turn one user action into a flood:

1. **Connector ingest pull** — a single Google-Calendar sync
   imports 500 events, each one publishes `entity.calendar.created`,
   each subscriber fires, each LLM call publishes more events
   (`entity.enrichment.completed`, `entity.translation.completed`).
2. **Enrichment write triggers re-enrichment.** An enrichment
   handler that PATCHes back into the entity store would loop
   through the bus (write → event → enrichment → write → …).
3. **DLQ replay storm.** An admin clicks "replay" on a backlog of
   DLQ rows; each one re-enters the outbox at the head and all
   subscribers see a synchronous burst.

Storms hurt three ways: LLM token bills (see also
`llm-cost-blowup.md`), SQLite write pressure on `bus_outbox`,
and tail latency for interactive routes that share the bus.

## Impact

Medium. No data loss — the durable adapter holds every event in
`bus_outbox`. But user-visible: chat latency degrades while the
worker drains; LLM provider rate-limits fire; cost spikes.

## Likelihood

Medium. The cascade-into-the-bus pattern is the default shape of
every domain in bunny2 — it ships with the architecture. The
known-good defaults are tuned, but a new entity kind or a new
subscriber can change the picture overnight.

## Mitigation

1. **Per-entity-per-layer debounce on enrichment.** The runner
   collapses bursts: every `entity.created` / `entity.updated` for
   `(layerId, kind, id)` arms a timer at `now + debounceMs` and
   merges payloads; only the last payload's enrichment fires.
   Default `config.enrichment.debounceMs = 1000`. Connector
   bulk-imports get one enrichment call per entity, not one per
   intermediate write.
2. **Per-layer rate limit on enrichment.** The runner caps LLM
   calls per 60s at `config.enrichment.maxRunsPerLayerPerMinute`.
   When the cap is hit, the runner publishes
   `entity.enrichment.deferred` and re-arms for the next window
   — defers instead of drops.
3. **Enrichment handlers cannot trigger their own loop.** The
   handler writes back through the entity store with a dedicated
   `source: 'enrichment'` flag; the enrichment subscriber filters
   `entity.updated` events where the cause is itself.
   (ADR 0013 §3.)
4. **Sequential per-handler dispatch + middleware-chain isolation.**
   `packages/bus/src/adapters/durable-sqlite.ts` runs handlers
   sequentially in registration order (event-bus.md §2). One slow
   handler does not race a peer or cause re-ordering. A handler
   throw is caught by the per-handler dispatcher; only
   middleware-chain throws land in `bus_dlq`.
5. **Idempotent subscribers + boot replay.** Subscribers that
   declare `{ idempotent: true }` (translator runner, LanceDB
   embedding subscriber, scheduled-task run subscriber) survive
   boot replay safely. Non-idempotent subscribers get
   `status='abandoned'` on boot — `bus.abandoned` admin signal
   fires; no silent re-fire storm.
6. **Outbox prune.** `bus.outbox.prune` (default 7-day retention
   on `delivered` rows) keeps `bus_outbox` bounded so SQLite
   write pressure stays predictable
   (see [`event-bus.md`](../architecture/event-bus.md) §9).
7. **DLQ replay is one-at-a-time.** `POST /admin/bus/dlq/:id/replay`
   re-inserts one row per call as `pending` — there is no
   "replay all" endpoint by design. An operator who batches a
   thousand replays does it deliberately.
8. **`error` strings clipped, payloads not echoed in DLQ events.**
   `bus.dlq.added` carries the `subscriberKey` and `type` but
   not the payload (event-bus.md §5). DLQ consumers cannot
   inadvertently amplify the storm by re-publishing payload
   bytes.

## What would invalidate the mitigation

- A new heavyweight subscriber added without an idempotency
  declaration, or one that PATCHes the entity store without the
  `source` filter pattern from ADR 0013 §3.
- Removing the per-layer rate limit or shipping
  `maxRunsPerLayerPerMinute = ∞`.
- A connector that publishes one event per upstream record without
  batching — phase 5+ should prefer `entity.connector.sync.*`
  bracket events around bulk imports so subscribers can choose
  to wait for the bracket close.
- The phase-7 `chat.review-layer` agent firing on every chat
  message instead of its scheduled cadence (current behaviour is
  cadence-based; an event-driven variant is rejected by the
  phase 7 plan partly for this reason).
