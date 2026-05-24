# ADR 0013 — Entity enrichment: per-process runner, event-driven jobs, per-layer rate limit, telemetry routing

- Status: accepted
- Date: 2026-05-24
- Phase: 4 (4a.3 — companies AI enrichment lands on top of the §4.0 entity contract and the 4a.2 connector dispatch model)
- Related: `docs/dev/plans/phase-04-first-entities.md` §1, §4a.3, §7, §13;
  ADR [`0011`](./0011-entity-contract.md) — entity contract;
  ADR [`0012`](./0012-kvk-connector.md) — KvK connector + dispatch;
  `apps/server/src/entities/enrichment-runner.ts`;
  `apps/server/src/entities/companies/enrichment.ts`;
  `apps/server/src/entities/module.ts` (`EnrichmentJob<P>`);
  `apps/server/src/entities/events.ts` (`entity.enrichment.*`);
  `apps/server/src/entities/connectors/base.ts` (`ConnectorContext.onPayloadPatch`, `persistConnectorPayloadPatch`).

---

## Context

Phase 4a.3 ships the first concrete AI-enrichment consumer of the
phase-4 foundation. The brief is the same one every later entity kind
will reuse: given a row, ask the system LLM to fill missing structured
fields and to generate a short summary.

Four design questions had to be answered before any enrichment code
landed:

1. **Per-kind runner vs. one generic runner?** Companies, contacts,
   calendar, and todos all want enrichment in 4b.3 / 4c.3 / 4d.3. If
   the runner is companies-specific the next three phases repeat the
   plumbing.
2. **Event-driven vs. polling?** A polling job would be uniform with
   the connector runner but would lag user-visible state. Event-driven
   reacts immediately at the cost of needing coalescing.
3. **Where does the connector's mapped patch (from 4a.2) live so the
   enrichment job can read it as ground-truth?** ADR 0012 deferred
   this to the `4a.3` close-out.
4. **How is the per-call LLM cost surfaced?** The telemetry wrapper
   (phase 1.4) writes a `llm_calls` row but does not return cost to
   the caller.

---

## Decision

### 1. One generic runner under `apps/server/src/entities/enrichment-runner.ts`

The runner is foundation-shaped, exactly like
`connector-runner.ts`:

- `createEnrichmentRunner({ db, bus, llm, pricing, config, resolveStore })`
  returns `{ start, stop, tickOnce }`.
- `start()` subscribes once per module to
  `entity.<kind>.{created,updated}` for every registered module that
  declares `enrichmentJobs`, plus a single subscription to
  `entity.connector.sync.succeeded`.
- `tickOnce()` flushes every pending debounced entry synchronously
  — tests use it to drive the runner without fake timers.

Per-kind code only contributes `EntityModule.enrichmentJobs` (a new
optional field on the §4.0 contract). The runner walks `runOn` to
decide which jobs to invoke for which trigger, owns patch
application, owns rate limiting, and owns event emission.

This means 4b.3 / 4c.3 / 4d.3 are zero-runner-code changes — they
just ship their own jobs.

### 2. Event-driven primary, periodic flush via `tickOnce` for tests

Subscribers are the production trigger surface. The runner intercepts
each event, debounces in a `Map<key, ScheduledEntry>` keyed on
`${kind}:${entityId}`, and re-arms a timer to
`now + config.enrichment.debounceMs` (default 5000ms). The
`tickOnce()` method exists for tests; production wiring uses the
event-driven path exclusively.

A polling-style "sweep stale entities" job is explicitly NOT in 4a.3.
Phase 5 (general scheduled tasks) can add a sweeper that publishes
synthetic events if needed; the runner does not need to change.

### 3. Connector patch lives on `entity_external_links.payload_json` as `{ lastPatch, lastPatchedAt }`

The 4a.2 dispatcher now provides `ConnectorContext.onPayloadPatch?(...)`
to every connector's `pull(ctx, …)` call. The dispatcher's
implementation runs `scrubConnectorPayload(...)` on the connector's
mapped patch and merges it into the link row's existing JSON as
`lastPatch` + `lastPatchedAt`. The 4a.3 `companies.fillFields` job
reads `entity.externalLinks.find(l => l.connector === 'kvk').payload.lastPatch`
as KvK ground-truth and feeds it to the LLM alongside the current
payload.

This closes the gap ADR 0012 §"Pull does not write payload"
deliberately left open ("the 4a.3 AI-enrichment job will consume
`entity.connector.sync.succeeded` events … and decide which patch
fields to apply"). The KvK connector still calls its
`CreateKvkConnectorDeps.onPayloadPatch` hook (test-only) so the
4a.2 deterministic-mapping assertion stays valid.

### 4. Per-job declaration on `EntityModule.enrichmentJobs`

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

The job is a small, pure function. It does NOT call `store.update` —
the runner owns patch application so future cross-cutting concerns
(retry, idempotency, audit) land in one place. The job returns a
partial; the runner applies the rules.

### 5. Patch application rules — overwrite policy lives in the runner

For every field in the returned patch:

- `null` / `undefined` → skip (LLM uncertainty, asserted by the
  prompt instructions).
- Current field already has a non-empty string value AND the field
  name is NOT `description` → skip ("do not stomp on user input").
  `description` is the one field enrichment is allowed to refresh
  outright by contract.
- Otherwise apply.

If anything survives the filter the runner calls `store.update` —
which bumps `version`, snapshots `entity_versions`, and publishes
`entity.<kind>.updated`. The runner stamps
`entity_souls.memory_json.lastEnrichedAtVersionByJob[jobId]` so future
tick decisions (in phase 5 / 7) can be source-version-driven the way
the translator already is.

### 6. Per-layer rate limit — sliding 60s bucket per `layerId`

A burst on a single layer (e.g. 200 new contacts imported at once)
must not melt the LLM budget. The runner enforces
`config.enrichment.maxRunsPerLayerPerMinute` (default 30) by keeping
a sliding window of run timestamps per layer. When the window is
full:

- the runner publishes `entity.enrichment.deferred` (one of the four
  new event types — see §8) and re-arms the entry's timer to the
  next minute boundary;
- the LLM is NOT called.

The 30/min/layer figure is conservative; cost dashboards over the
first month of real usage drive the value. Per `overall.md` §13 the
risk row "translation cost blows up" applies here too — coalescing

- rate limit is the same mitigation pattern.

### 7. Telemetry routes through the existing wrapped LLM client

`apps/server/src/index.ts` instantiates the enrichment runner with the
already-telemetry-wrapped `llmClient` (the same instance the HTTP
chat route uses). Every enrichment call:

- writes a `llm_calls` row (prompt + response, redacted, with cost);
- propagates `metadata.layerId` so cost-by-layer dashboards work;
- propagates `metadata.correlationId` from the originating
  bus event so a trace ties together event → enrichment LLM call →
  `entity.<kind>.updated`.

The runner also passes the result's `tokensIn` / `tokensOut` / `model`
through `estimateCostUsd(model, ...)` (using the same `PricingMap`
the wrapper consumes) so `entity.enrichment.succeeded` carries an
operationally useful USD figure without joining `llm_calls`. When
the model is unpriced the field is `null`, matching ADR 0006's
"uncertain values are NULL, not zero" rule.

### 8. New event types — `entity.enrichment.*`

```
entity.enrichment.started    { kind, entityId, jobId }
entity.enrichment.succeeded  { kind, entityId, jobId, hasPatch, tokensIn, tokensOut, costUsd }
entity.enrichment.failed     { kind, entityId, jobId, error }
entity.enrichment.deferred   { kind, entityId, jobId, layerId, reason: 'rate_limited' }
```

Closed shapes. No `prompt`, no `response`, no `config`. The canonical
record of the full content is `llm_calls`. The enrichment events are
for dashboards, audits, and the future phase-5 scheduler.

### 9. Failure isolation

A job that throws does NOT propagate. The runner catches, sanitizes
the error to an `errors.*` key (default `errors.entity.enrichment.failed`
when the thrown message is not an i18n key), publishes
`entity.enrichment.failed`, and moves on. Sibling jobs on the same
entity still run. This mirrors the connector dispatcher's
`errors.entity.syncFailed` discipline from ADR 0012.

### 10. The two companies jobs

`apps/server/src/entities/companies/enrichment.ts`:

- `companies.summary` runs on `created` / `updated` / `sync.succeeded`.
  Asks the LLM for a ≤300-char description in the row's locale.
  Skips when `payload.description` is already populated AND the
  trigger is `created` (no need to overwrite a freshly-authored
  description on the same tick).
- `companies.fillFields` runs on `sync.succeeded` only. Reads the
  scrubbed KvK ground-truth patch from
  `entity_external_links.payload_json.lastPatch`, feeds it to the
  LLM, and asks the LLM to return a JSON object with non-null values
  for fields it is confident about. Null fields are skipped by the
  job itself (defense in depth — the runner skips them too).

Both jobs are registered via `companyModule.enrichmentJobs`. Tests
inject `createCompanyModule({ enrichmentJobs: [...] })` to drive the
runner with deterministic stubs.

### 11. Connector-filter heuristic for cross-kind reuse

`companies.fillFields` runs on every `sync.succeeded` event, not just
KvK-specific ones. The job itself bails (returns `{}`) when no
matching external link is present. This keeps the runner generic for
future connectors (e.g. a future "OpenCorporates" connector also
producing patches): the same job becomes responsible for either
external source, and a hypothetical second job can specialize on its
own connector by inspecting `entity.externalLinks`.

---

## Consequences

**Positive**

- Phase 4b.3 / 4c.3 / 4d.3 ship without any new runner code. They
  add per-kind jobs to their module and inherit debounce, rate
  limit, telemetry routing, secret-strip, and the event surface.
- Cost-by-layer dashboards work day one (every LLM call carries
  `metadata.layerId`).
- The secret-strip invariant added in 4a.2 stays intact: the
  dispatcher writes a scrubbed patch onto the link row; the
  enrichment job reads that scrubbed copy. There is no path from
  `layer_attachments.config.apiKey` into an LLM prompt.
- A failing job is observable on the bus AND in `llm_calls` — both
  the dashboard view and the per-call deep-dive work.

**Negative / accepted**

- The runner is now another piece of state with its own subscriptions.
  Same discipline as the connector dispatcher: construct once at
  boot, never inside `createApp`. Tests instantiate their own
  per-fixture and never touch the production singleton.
- The 30 calls/min/layer rate limit is a flat constant. A real
  deployment may need per-tenant tuning; phase 5 (general scheduled
  tasks) is the natural place to surface that as configurable per
  layer.
- The runner's "do not overwrite non-empty user fields" rule is a
  guardrail that may bite if a job genuinely should replace a value.
  The escape hatch is the `description` field (allowed by name).
  A future kind that wants finer control will need to extend the
  rule — that lands when the second exception appears, not
  speculatively now.

---

## Alternatives considered

- **Inline enrichment from the `EntityModule.onCreate` / `onUpdate`
  lifecycle hooks.** Rejected — those hooks run inside the request
  transaction. An LLM call has unpredictable latency; blocking the
  HTTP response is the same anti-pattern ADR 0012 rejected for
  connector dispatch.
- **A per-kind enrichment runner.** Rejected — the foundation has
  to exist now to keep 4b.3 / 4c.3 / 4d.3 cheap. The contract test
  suite (§4.0) is the precedent.
- **Store the connector patch in a new `connector_payload_patches`
  table.** Rejected — `entity_external_links.payload_json` already
  exists for non-secret per-link state; adding a fifth table for
  one new field would proliferate joins. The `lastPatch` /
  `lastPatchedAt` keys are stable and tested.
- **Cost on the success event = null, force callers to join
  `llm_calls`.** Rejected — the event is the dashboard surface,
  and the per-event USD field saves one join everywhere. The
  authoritative record is still `llm_calls`; the event carries a
  pre-computed copy.

---

## Follow-ups

- Per-tenant or per-layer rate-limit tuning lands in phase 5
  (general scheduled tasks) when the UI for "what jobs are running"
  also lands.
- The "skip on non-empty user value (except description)" overwrite
  policy will likely need extension when a kind genuinely wants
  enrichment to update a structured field (e.g. calendar wants to
  refresh `attendees` after a Google poll). File a follow-up the
  first time that comes up.
- The summary prompt is locale-blind in 4a.3 — it asks for English
  unless the payload makes another locale obvious. When the
  translator (4.0) and enrichment land in the same loop the prompts
  should consult `entity.originalLocale`. Not a 4a.3 concern.

---

## Update (4c.3) — per-module `enrichmentOverwriteFields` slot

The "Follow-ups" entry above ("The skip on non-empty user value
(except description) overwrite policy will likely need extension
when a kind genuinely wants enrichment to update a structured
field") was answered in 4c.3.

Calendar enrichment needs two structured-field exceptions in a
single commit (`attendees` and `meetingSummaryNote`), so the
hardcoded `description` branch in `applyPatch` was generalised into
a per-module list:

```ts
// EntityModule<P>
readonly enrichmentOverwriteFields?: readonly string[];
```

The runner consults the registered module's list on every patched
field. Empty / null / whitespace-only fields remain overridable
regardless of the list. Per-module declarations:

- `company` → `['description']` (preserves the 4a.3 behaviour).
- `contact` → omitted (the existing job only writes empty fields).
- `calendar_event` → `['attendees', 'meetingSummaryNote']`.

This is the SIXTH foundation extension on top of the §4.0
contract, and the 4a.3 close-out predicted it. See
`docs/dev/architecture/entities.md` §10c.i and
`docs/dev/plans/phase-04-first-entities.md` §14 "4a.3 shipped"
follow-up bullet for the prediction.
