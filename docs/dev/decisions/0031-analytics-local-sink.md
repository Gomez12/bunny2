# ADR 0031 — Local SQLite analytics sink

- Status: proposed (accepted on phase 6 ship per plan §5)
- Date: 2026-05-25
- Phase: 6 of `docs/dev/plans/admin-observability-viewer.md`
- Related:
  - `docs/dev/plans/admin-observability-viewer.md` (the plan this ADR resolves Q1 for)
  - `docs/dev/observability/analytics.md` (event catalogue + privacy rules; currently says "no sink by default")
  - `docs/dev/observability/logging.md` §1 + §4 ("durable diagnostics in SQLite tables" stance)
  - `docs/dev/observability/telemetry.md` §1 ("persisted, queryable, structured rows in SQLite")
  - ADR [`0002`](./0002-sqlite-first-postgres-later.md) — SQLite-first stance
  - ADR [`0019`](./0019-durable-sqlite-message-bus.md) — same "durable, local, queryable" trade-off applied to the bus
  - `docs/dev/audits/admin-observability-redaction-2026-05-25.md` — the redaction audit this ADR cites for R4

---

## Context

`apps/web/src/lib/analytics.ts` ships `trackEvent(name, properties)` as a
no-op primitive. The destination is deferred. The admin-observability
viewer plan needs analytics to be **readable in-app**, and the project's
existing observability conventions (logging.md §1, telemetry.md §1) all
land durable structured rows in SQLite, not in an external collector.

Three sink options were on the table per `analytics.md §Picking a real
sink`:

1. **PostHog (self-hosted)** — full product analytics. Owns the data
   when self-hosted; supports session recording (we would keep that
   off); needs an HTTP egress allowance and a separate service to
   operate.
2. **Plausible (self-hosted)** — privacy-friendly; designed around
   pageviews + a small custom-property set. Limited expressiveness for
   the per-event property bags this project already documents in the
   catalogue.
3. **Server-side `analytics_events` SQLite table** — keeps everything
   in the project's own database. Needs a small ingest endpoint, a
   batching client sink, a retention prune job, and an admin viewer
   (the whole point of the plan).

Two open questions hung off whichever option we picked:

- **Q1** (`docs/dev/plans/admin-observability-viewer.md §15`) — should
  the ingest endpoint **reject** unknown event names or **bucket** them
  under `_unknown_` for catalogue-drift detection?
- **R4** (same plan, §14) — what concretely are the redaction
  guarantees the admin viewer can rely on? Today's redactor lives at
  `apps/server/src/llm/redaction.ts` and is wired only into the
  `llm_calls` write path; the audit at
  `docs/dev/audits/admin-observability-redaction-2026-05-25.md`
  catalogues what is and is not redacted across every surface this
  plan exposes.

---

## Decision

### D1 — Sink: local `analytics_events` SQLite table

We will ship a server-side `analytics_events` table plus a single
`POST /analytics/events` ingest endpoint. The web client gets a thin
batching HTTP sink wired via `configureAnalytics({ sink: ... })` in
`apps/web/src/main.tsx`. No external service is added.

Reasons:

- **Consistency with the rest of the stack.** Logging (logging.md §1)
  and telemetry (telemetry.md §1) both treat durable SQLite tables as
  the canonical sink. A fourth durable signal (analytics) following
  the same shape removes one decision and one operational surface.
- **Local-first deployment stays local.** ADR 0002 + ADR 0019 already
  argued the "no external dependencies on the hot path" line for the
  database and the bus; analytics is the smallest data stream of the
  four and least worth breaking the rule for.
- **The admin viewer becomes a 1:1 mirror of the other surfaces.**
  The plan already ships filter + drawer pages for `events`,
  `llm_calls`, `chat_pipeline_steps`, and `scheduled_task_runs`.
  Adding `analytics_events` to the same `<AdminTablePage>` shell is
  cheap; integrating PostHog / Plausible's own UI would mean two
  shapes of admin viewer.
- **R5 mitigation is kept in place.** `configureAnalytics` stays
  pluggable. The local sink is the default, not the only option;
  a future cloud deployment can wire a PostHog sink and reduce the
  retention window on the local table to zero without touching call
  sites. The decision is reversible.

### D2 — Q1: ingest rejects unknown event names

The endpoint validates `event_name` against the catalogue documented
in `docs/dev/observability/analytics.md` (the union of every "Event"
column across the per-domain tables). Unknown event names are
rejected with `400` and logged once as `analytics.events.rejected`
with `{ eventName, reason: 'unknown_name' }`. The catalogue stays
the source of truth.

Reasons:

- **R1 mitigation.** The endpoint is reachable by every authenticated
  session; tight validation is the cheapest way to keep it from
  becoming an abuse target. A bucketed `_unknown_` event makes the
  table grow under any compromised browser.
- **Catalogue drift detection is already covered.** The
  `analytics.events.rejected` log line names the offending event;
  CI grep + the admin events viewer (Phase 2) surface it without a
  separate `_unknown_` row class.
- **No new schema surface.** Bucketing forces an opinion on what
  `properties_json` looks like for an unknown event; rejection
  side-steps the question entirely.
- **`analytics.md` already treats the catalogue as authoritative**
  ("Add a row when you add an event; remove a row when you remove
  one"). Rejection enforces that contract; bucketing weakens it.

### D3 — Privacy contract for the new table

The `analytics_events` table will store **hashed** `user_id`
(`user_id_hash`), not the raw UUID. Hashing happens server-side on
ingest so the raw id never lands on disk for this surface. This is
the **deliberate asymmetry** with `llm_calls.user_id`, which keeps
the raw UUID (admin-only viewer + ties to layer membership).

The reasoning is in `analytics.md §Privacy`: analytics is the
product-flow signal, not the per-user audit log. The hash gives us
per-user uniqueness for funnel math without exposing the id when a
viewer or an export inevitably leaks the data set somewhere.

### D4 — Retention

Default 90 days, configurable per env via the
`analytics.events.prune` scheduled task (registered alongside the
other prune jobs listed in `logging.md §4`). Same shape as
`llm.calls.prune` and `chat.runs.prune`.

### D5 — Redaction guarantees the viewer can rely on

The redaction audit at
`docs/dev/audits/admin-observability-redaction-2026-05-25.md` is the
authoritative breakdown per surface. The headline guarantees the
admin viewer (and this ADR) commits to:

- **`analytics_events.properties_json`** is bounded by the catalogue
  in `analytics.md`. Every documented property is a stable id, a
  closed enum, or a bucketed numeric. The ingest endpoint rejects
  payloads that include properties not in the catalogue for that
  event name. Raw user content (chat text, search text, reason
  textareas) cannot reach this table.
- **`llm_calls.request` / `.response`** are redacted at write time
  by `apps/server/src/llm/redaction.ts` (key-name + value-pattern
  match — see `logging.md §5`). The admin viewer renders the
  already-redacted JSON; no unredacted path exists server-side.
- **`chat_pipeline_steps.input_json`** for the `intent` step
  contains the raw user message (`{ userContent: <raw text> }`).
  This is durable by design — the Kanban (phase 6.6) and the
  pipeline-replay path rely on it. The audit calls this out
  explicitly so the admin viewer's drawer is gated behind an
  explicit "show raw chat content" expander, not rendered inline.
- **`events.payload` / `bus_outbox.payload_json`** carry the
  domain payloads as published. The bus contract
  (`event-bus.md §5`) keeps DLQ-broadcast events free of payload
  bodies; the admin viewer renders payloads in the detail drawer
  only (collapsed by default).

Full per-surface breakdown lives in the audit. This ADR pins the
viewer contract; the audit pins the per-column reality.

---

## Consequences

- A new migration adds `analytics_events`
  (`id`, `occurred_at`, `event_name`, `layer_slug`, `user_id_hash`,
  `properties_json`, `ingested_at`). Postgres-portable per ADR 0002.
- A new route `POST /analytics/events` ships with `requireAuth`
  (not `requireAdmin`) — every signed-in user can write to it via
  the browser sink. Validation rejects unknown names per D2.
- A new scheduled task `analytics.events.prune` joins
  `docs/dev/architecture/job-inventory.md` (per `docs/check`).
- `docs/dev/observability/analytics.md` drops the "no sink by
  default" caveat once the sink is wired in phase 6; until then it
  keeps the existing language.
- The web sink batches and retries on failure but never throws —
  the existing `trackEvent` never-throws guarantee carries through.
- The admin viewer is a sibling of the existing admin pages; no
  new UI shell is required beyond the `<AdminTablePage>` extracted
  in phase 1.
- Reversibility: dropping the table + flipping
  `configureAnalytics({ sink: httpSink })` back to no-arg restores
  the pre-plan state. No external dependency to wind down.

---

## Alternatives considered

- **PostHog self-hosted.** Better product-analytics tooling out of
  the box (funnels, retention curves, session recordings). Rejected
  for v1 because it doubles the operational surface and forces a
  second admin UI shape; the project explicitly avoids external
  dependencies on the hot path (`logging.md §7` "what's
  intentionally missing").
- **Plausible self-hosted.** Privacy-aligned, but the property
  catalogue is richer than Plausible's custom-property model
  comfortably supports (per-event property bags vary by event).
- **Accept unknown event names under a `_unknown_` bucket** (Q1
  alternative). Rejected per D2 — weaker abuse-resistance, weaker
  catalogue discipline, and a new schema surface for the bucket.
- **Hash `user_id` lazily at read time** instead of at ingest.
  Rejected — leaves raw ids at rest in the table; the asymmetry
  with `llm_calls.user_id` is the wrong direction.
- **Skip retention and let the table grow.** Rejected — every
  other durable telemetry surface in this project has a prune job
  (`logging.md §4`); analytics should not be the exception.

---

## Open follow-ups (not blocking acceptance)

- Per-event-name aggregation views (24h / 7d / 30d count) live on
  the admin page only for v1. A read-model that backs a future
  product dashboard is out of scope here.
- A cloud-deploy sink swap (PostHog, Segment, GA4) stays open per
  R5. The `configureAnalytics({ sink })` interface does not
  change; only the imported sink does.
