# Web analytics

The web app records product / user-flow events via a single primitive
in [`apps/web/src/lib/analytics.ts`](../../../apps/web/src/lib/analytics.ts):

```ts
import { trackEvent } from '../lib/analytics';

trackEvent('chat_message_sent', { layerSlug, conversationId, lengthBucket });
```

This document is the source of truth for the event catalogue and the
project-wide rules from [`AGENTS.md` §Analytics](../../../AGENTS.md#analytics).

## Design

### Production sink — local `analytics_events` SQLite table

Phase 6 of [`docs/dev/plans/admin-observability-viewer.md`](../plans/admin-observability-viewer.md)
ships the production sink. ADR
[`0031`](../decisions/0031-analytics-local-sink.md) picks a local
SQLite `analytics_events` table over an external collector
(PostHog / Plausible) because it keeps the four durable observability
surfaces (logging, telemetry, bus, analytics) on the same SQLite
substrate.

Pieces (all wired today):

- **Web sink** —
  [`apps/web/src/lib/analytics-http-sink.ts`](../../../apps/web/src/lib/analytics-http-sink.ts).
  Batches up to 20 events or 5 seconds (whichever fires first),
  POSTs `/analytics/events`, retries once on transient network /
  5xx / 408 / 429 responses, drops non-retryable 4xx batches.
  Bounded buffer (200 events) — overflow drops oldest with a
  `console.warn`. Never throws.
- **`configureAnalytics({ sink: httpAnalyticsSink })`** — called once
  from [`apps/web/src/main.tsx`](../../../apps/web/src/main.tsx).
- **Ingest endpoint** —
  `POST /analytics/events`,
  [`apps/server/src/http/routes/analytics.ts`](../../../apps/server/src/http/routes/analytics.ts).
  Gated by `requireAuth` (every signed-in user can write — NOT
  `requireAdmin`). Body cap 32 KB. Validates against the closed
  catalogue below: rejects an unknown event name with `400` +
  `analytics.events.rejected` log; rejects a known event with an
  unknown property key the same way. `user_id` is hashed
  server-side before insert (HMAC-SHA256 keyed off
  `BUNNY2_ENCRYPTION_KEY`, falls back to SHA-256 when the env is
  missing). The raw id never lands on disk for this surface.
- **`analytics_events` table** — migration
  [`0022_analytics_events.sql`](../../../apps/server/src/storage/migrations/0022_analytics_events.sql).
  Indexed on `occurred_at`, `event_name`, `layer_slug`,
  `user_id_hash`.
- **Admin viewer** —
  [`AdminAnalyticsPage`](../../../apps/web/src/pages/admin/AdminAnalyticsPage.tsx)
  at `/admin/observability/analytics`. Filters by event name (drop-down
  sourced from the catalogue), layer slug, user-id hash, time range.
  Rollups card shows 24h / 7d per-event counts; the drawer pairs the
  row's `properties_json` with the catalogue's documented schema for
  drift detection.
- **Retention** — `analytics.events.prune` scheduled task (default
  90 days, override via env `ANALYTICS_RETENTION_DAYS` or per-task
  `config.retentionDays`). Registered with the other built-in prune
  jobs; row in
  [`job-inventory.md`](../architecture/job-inventory.md).

### Reverting to no-op

`configureAnalytics()` (no arg) or `configureAnalytics({ sink: undefined })`
clears the active sink and restores no-op behaviour. Production
never crashes because analytics is mis-wired.

### Dev opt-in console mirror

During local development, set the localStorage flag to surface every
event in the browser console:

```js
localStorage.setItem('bunny2.debug.analytics', '1');
```

When that flag is `'1'` **and** `import.meta.env.DEV` is true, each
`trackEvent` call additionally emits a single line:

```
[analytics] chat_message_sent { layerSlug: "demo", conversationId: "…", lengthBucket: "s" }
```

The flag is read at every call (no reload needed) and is independent
of the configured sink — both can coexist.

### Never throws

The primitive guards both the dev mirror and the sink invocation with
try/catch. A broken sink, a closed renderer, or a storage exception
in private-browsing mode cannot crash the page.

## Privacy

Per `AGENTS.md §Privacy and Data Protection`:

- No raw user content (chat messages, rejection reasons, rollback
  reasons, search text).
- No PII (email addresses, phone numbers, IP, full names).
- No secrets or tokens.

Every property in the catalogue below is a stable identifier
(`layerSlug`, `proposalId`, `capabilityId`, `conversationId`), a
closed enum (`outcome`, thumbs `value`), or a bucketed numeric
(`lengthBucket`). Reason text from the proposal reject / rollback
dialogs is intentionally omitted; the supporting comments in
`LayerProposalDetailPage.tsx` flag this at the call site.

## Event catalogue

Mined from the actual call sites under `apps/web/src/pages/`. Every
event name is stable (in production from phase 6.5 / phase 7.6 / phase
8). Add a row when you add an event; remove a row when you remove
one.

### Chat

| Event                                 | Properties                                    | Privacy                                                                     |
| ------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `chat_conversation_started`           | `layerSlug`                                   | Slug only, no user content.                                                 |
| `chat_conversation_title_regenerated` | `layerSlug`                                   | Slug only.                                                                  |
| `chat_message_sent`                   | `layerSlug`, `conversationId`, `lengthBucket` | `lengthBucket` is the `bucketContentLength` enum (S/M/L); raw text dropped. |
| `chat_message_trace_inspected`        | `layerSlug`                                   | Slug only.                                                                  |
| `chat_stream_aborted`                 | `layerSlug`, `conversationId`                 | Stable IDs only.                                                            |
| `chat_feedback_submitted`             | `value`                                       | Thumbs enum (`'up' \| 'down'`); reason textarea content is **not** sent.    |

Call sites:

- [`apps/web/src/pages/LayerChatPage.tsx`](../../../apps/web/src/pages/LayerChatPage.tsx)

### Proposals

| Event                       | Properties                           | Privacy                                                                                             |
| --------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `proposals_page_opened`     | `layerSlug`                          | Slug only.                                                                                          |
| `proposal_detail_opened`    | `layerSlug`, `proposalId`            | Fired from both the list (link click) and the detail page (mount). Both call sites are intentional. |
| `proposal_approved`         | `layerSlug`, `proposalId`, `outcome` | `outcome` is the closed `ApprovalOutcome` enum from the API.                                        |
| `proposal_sandbox_replayed` | `layerSlug`, `proposalId`, `outcome` | Same `outcome` enum as approve.                                                                     |
| `proposal_rejected`         | `layerSlug`, `proposalId`            | Reason textarea content is **not** sent.                                                            |
| `proposal_rolled_back`      | `layerSlug`, `proposalId`            | Reason textarea content is **not** sent (ADR 0027 §3).                                              |

Call sites:

- [`apps/web/src/pages/LayerProposalsListPage.tsx`](../../../apps/web/src/pages/LayerProposalsListPage.tsx)
- [`apps/web/src/pages/LayerProposalDetailPage.tsx`](../../../apps/web/src/pages/LayerProposalDetailPage.tsx)

### Capabilities

| Event                      | Properties                  | Privacy          |
| -------------------------- | --------------------------- | ---------------- |
| `capabilities_page_opened` | `layerSlug`                 | Slug only.       |
| `capability_deactivated`   | `layerSlug`, `capabilityId` | Stable IDs only. |

Call sites:

- [`apps/web/src/pages/LayerCapabilitiesPage.tsx`](../../../apps/web/src/pages/LayerCapabilitiesPage.tsx)

### Entities

| Event                          | Properties          | Privacy                                                                                                                                                                                                                           |
| ------------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `entity_restored`              | `kind`, `layerSlug` | `kind` is the closed `RestorableEntityKind` enum (`company`/`contact`/`calendar_event`/`todo`/`whiteboard`); no row content.                                                                                                      |
| `entity_external_link_added`   | `kind`, `layerSlug` | `kind` is the closed `ExternalLinkEntityKind` enum (`contact`/`calendar_event`/`todo`/`whiteboard`); Companies still emits its own KvK-specific call site. No connector / external-id / payload values are sent (plan §13 + §10). |
| `entity_external_link_removed` | `kind`, `layerSlug` | Same closed enum as `entity_external_link_added`; no link id, no connector, no external-id leaks (plan §13 + §10).                                                                                                                |

Call sites:

- `entity_restored` (Phase 1 of `docs/dev/plans/ui-exposure-gaps.md`):
  - [`apps/web/src/pages/CompanyDetailPage.tsx`](../../../apps/web/src/pages/CompanyDetailPage.tsx)
  - [`apps/web/src/pages/ContactDetailPage.tsx`](../../../apps/web/src/pages/ContactDetailPage.tsx)
  - [`apps/web/src/pages/CalendarEventDetailPage.tsx`](../../../apps/web/src/pages/CalendarEventDetailPage.tsx)
  - [`apps/web/src/pages/TodoDetailPage.tsx`](../../../apps/web/src/pages/TodoDetailPage.tsx)
  - [`apps/web/src/pages/WhiteboardDetailPage.tsx`](../../../apps/web/src/pages/WhiteboardDetailPage.tsx)
- `entity_external_link_added` / `_removed` (Phase 3 of `docs/dev/plans/ui-exposure-gaps.md`):
  - [`apps/web/src/components/EntityExternalLinks.tsx`](../../../apps/web/src/components/EntityExternalLinks.tsx)
    — consumed by `ContactDetailPage`, `CalendarEventDetailPage`,
    `TodoDetailPage`, `WhiteboardDetailPage`. Companies is intentionally
    not migrated yet (see
    [`docs/dev/follow-ups/shared-entity-external-links-component.md`](../follow-ups/shared-entity-external-links-component.md)).

### Layers

| Event                  | Properties          | Privacy                                                                  |
| ---------------------- | ------------------- | ------------------------------------------------------------------------ |
| `layer_member_removed` | `layerSlug`, `kind` | `kind` is the closed `LayerMemberKind` enum (`user`/`group`); slug only. |

Call sites:

- [`apps/web/src/pages/LayerSettingsPage.tsx`](../../../apps/web/src/pages/LayerSettingsPage.tsx)

## Adding a new event

The catalogue above is **enforced** by
[`apps/server/src/analytics/catalogue.ts`](../../../apps/server/src/analytics/catalogue.ts).
The ingest endpoint rejects unknown event names AND unknown
property keys (ADR 0031 D2). Adding a new event therefore requires
two coordinated changes:

1. Pick a stable, snake-case name with clear product meaning. See the
   "Good analytics names" examples in `AGENTS.md §Analytics`.
2. Audit the properties against the privacy rules above. Prefer
   stable IDs / enums / buckets over raw values.
3. Add a row to the relevant table in this file.
4. Add the matching entry to `ANALYTICS_EVENT_CATALOGUE` in
   `apps/server/src/analytics/catalogue.ts` (same property keys).
5. Add the `trackEvent('…', { … })` call site in `apps/web`.
6. Add a unit test under `apps/web/tests/` if the call site has
   non-obvious property derivation (e.g. bucketing).

Skipping steps 4–5 ships an event that the production sink will
reject with `analytics.events.rejected`. The CI check for this is
the closed-tuple typecheck on the catalogue module.

## Sink alternatives (for future cloud deploys)

ADR [`0031`](../decisions/0031-analytics-local-sink.md) leaves the
door open to swap the local sink for a managed product. The
`configureAnalytics({ sink })` interface does not change; only the
imported sink does. Candidates discussed in `AGENTS.md §Analytics`:

- **PostHog (self-hosted)** — owns the data, supports session
  recordings (off by default); needs an HTTP egress allowance.
- **Plausible (self-hosted)** — privacy-friendly, no PII by design,
  but limited custom properties.

## See also

- [`AGENTS.md` §Analytics](../../../AGENTS.md#analytics)
- [`AGENTS.md` §Privacy and Data Protection](../../../AGENTS.md#privacy-and-data-protection)
- [`apps/web/src/lib/analytics.ts`](../../../apps/web/src/lib/analytics.ts) — the primitive
- [`apps/web/tests/analytics.test.ts`](../../../apps/web/tests/analytics.test.ts) — primitive tests
