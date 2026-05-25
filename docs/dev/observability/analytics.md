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

### No sink by default

`trackEvent` is a **no-op** when no sink is configured. The actual
destination (PostHog vs Plausible vs a server-side `analytics_events`
table) is a deferred product decision; shipping a stable primitive
lets call sites stay clean while we wait. Production never crashes
because analytics is mis-wired.

To wire a real sink later, call `configureAnalytics({ sink })` exactly
once during bootstrap — the natural place is `apps/web/src/main.tsx`,
after `i18n` is ready. `configureAnalytics()` (no arg) or
`configureAnalytics({ sink: undefined })` clears the sink and restores
no-op behaviour.

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

| Event                       | Properties                                    | Privacy                                                                     |
| --------------------------- | --------------------------------------------- | --------------------------------------------------------------------------- |
| `chat_conversation_started` | `layerSlug`                                   | Slug only, no user content.                                                 |
| `chat_message_sent`         | `layerSlug`, `conversationId`, `lengthBucket` | `lengthBucket` is the `bucketContentLength` enum (S/M/L); raw text dropped. |
| `chat_stream_aborted`       | `layerSlug`, `conversationId`                 | Stable IDs only.                                                            |
| `chat_feedback_submitted`   | `value`                                       | Thumbs enum (`'up' \| 'down'`); reason textarea content is **not** sent.    |

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

| Event             | Properties          | Privacy                                                                                                                      |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `entity_restored` | `kind`, `layerSlug` | `kind` is the closed `RestorableEntityKind` enum (`company`/`contact`/`calendar_event`/`todo`/`whiteboard`); no row content. |

Call sites (Phase 1 of `docs/dev/plans/ui-exposure-gaps.md`):

- [`apps/web/src/pages/CompanyDetailPage.tsx`](../../../apps/web/src/pages/CompanyDetailPage.tsx)
- [`apps/web/src/pages/ContactDetailPage.tsx`](../../../apps/web/src/pages/ContactDetailPage.tsx)
- [`apps/web/src/pages/CalendarEventDetailPage.tsx`](../../../apps/web/src/pages/CalendarEventDetailPage.tsx)
- [`apps/web/src/pages/TodoDetailPage.tsx`](../../../apps/web/src/pages/TodoDetailPage.tsx)
- [`apps/web/src/pages/WhiteboardDetailPage.tsx`](../../../apps/web/src/pages/WhiteboardDetailPage.tsx)

## Adding a new event

1. Pick a stable, snake-case name with clear product meaning. See the
   "Good analytics names" examples in `AGENTS.md §Analytics`.
2. Audit the properties against the privacy rules above. Prefer
   stable IDs / enums / buckets over raw values.
3. Add a row to the relevant table in this file.
4. Add a unit test under `apps/web/tests/` if the call site has
   non-obvious property derivation (e.g. bucketing).

## Picking a real sink

The sink decision is tracked under the same history that closed the
follow-up
[`docs/dev/follow-ups/done/web-analytics-primitive.md`](../follow-ups/done/web-analytics-primitive.md).
Candidates and constraints discussed in `AGENTS.md §Analytics`:

- **PostHog (self-hosted)** — owns the data, supports session
  recordings (off by default); needs an HTTP egress allowance.
- **Plausible (self-hosted)** — privacy-friendly, no PII by design,
  but limited custom properties.
- **Server-side `analytics_events` table** — keeps everything in
  Postgres; needs a thin `/me/analytics` ingestion route and a
  client-side batcher.

Once chosen, wire it from `apps/web/src/main.tsx`:

```ts
import { configureAnalytics } from './lib/analytics';
import { httpSink } from './lib/analytics-http-sink'; // future module

configureAnalytics({ sink: httpSink });
```

## See also

- [`AGENTS.md` §Analytics](../../../AGENTS.md#analytics)
- [`AGENTS.md` §Privacy and Data Protection](../../../AGENTS.md#privacy-and-data-protection)
- [`apps/web/src/lib/analytics.ts`](../../../apps/web/src/lib/analytics.ts) — the primitive
- [`apps/web/tests/analytics.test.ts`](../../../apps/web/tests/analytics.test.ts) — primitive tests
