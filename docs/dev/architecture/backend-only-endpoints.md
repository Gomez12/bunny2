# Backend-only endpoints

Snapshot: 2026-05-25 (closes
[`docs/dev/plans/ui-exposure-gaps.md`](../plans/ui-exposure-gaps.md)
Phase 5; seeded from
[`docs/dev/audits/ui-route-exposure-audit-2026-05-25.md`](../audits/ui-route-exposure-audit-2026-05-25.md)).

Owner: cross-cutting (HTTP routes; route audit).

This file lists every HTTP endpoint that is intentionally not invoked
from the web UI. A row here means: the route exists in
`apps/server/src` on purpose, but no `apps/web` caller reads or writes
it. Future audits diff against this list — if an audit re-run surfaces a
"backend route with no web caller" that is not in this file, either the
UI lost a feature OR a new backend-only endpoint shipped without being
documented here.

This file does **not** list:

- Routes the UI calls today (those are reachable via the web bundle).
- Generic HTTP middleware (`requireAuth`, `requireAdmin`,
  `requirePasswordCurrent`, `withEffectiveLayers`) — those are not
  endpoints.
- Internal IPC channels in `apps/desktop` (Electron preload bridge);
  see [`packaging.md`](./packaging.md).
- Bus subscribers / job runners; see
  [`event-bus.md`](./event-bus.md) and
  [`job-inventory.md`](./job-inventory.md).

## 1. Intentionally backend-only HTTP routes

| Method | Path            | Why it exists                                                                                                                                                                                                                                                                                                                                                                                                                             | Caller                                                     | Stability                                                                                                                 |
| ------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/layers/:slug` | Single-resource read of a layer. The UI's layer-switcher data flow uses `GET /me/layers` (filtered to the caller's effective set) plus the targeted setters (`PATCH /layers/:slug`, attachments, visibility, members). A standalone single-layer GET is kept for REST symmetry and for ad-hoc operator / scripting use against the API. Phase 5 (ui-exposure-gaps) removed the unused `getLayer()` helper from `apps/web/src/lib/api.ts`. | Operator / scripting / internal tooling; no web UI caller. | Stable. Endpoint is part of the public layer CRUD shape and has the same authz contract as the rest of `/layers/:slug/*`. |

## 2. Routes deliberately not mounted

| Method | Path                         | What was removed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/l/:slug/whiteboard/_stats` | Auto-generated `_stats` route from the generic entity router (`apps/server/src/entities/router.ts`). Whiteboards opt out via `mountEntityRoutes({ optOutOfStats: true })` because the whiteboard dashboard widget reads `_recent` thumbnails, not aggregate counts. When opted out the route is not registered and the literal slug `_stats` falls through to the `:entitySlug` matcher and surfaces as `errors.entity.notFound` (404). The aggregate provider (`whiteboardStatsProvider`) is still exported from `apps/server/src/entities/whiteboards/stats.ts` for a future widget. |

The four other entity kinds (`company`, `contact`, `calendar_event`,
`todo`) keep their `_stats` mount — each has a dashboard widget that
calls it.

## 3. Categories that currently have no entries

The audit covers only HTTP-exposed routes. The following backend-only
categories explicitly have no entries in this file today, listed here
so a future audit understands the absence is intentional, not an
omission:

- **Cron callbacks** — none. Scheduled work is dispatched via the
  in-process scheduler (`apps/server/src/scheduled-tasks/*`) and the
  message bus; no external cron pings an HTTP endpoint.
- **Worker-only HTTP routes** — none. Workers run in-process under the
  same Hono app and communicate via the bus, not via HTTP loopback.
- **System-actor HTTP routes** — none. The `system` actor writes to the
  bus and the database directly; it does not call its own HTTP API.
- **External webhook ingest** — none. Connector ingest happens via
  `POST /l/:slug/<kind>/_ingest/:connectorId`, which is UI-driven (the
  vCard import page and the calendar Google-sync button), not a
  third-party webhook receiver.

If any of these categories grow an HTTP endpoint in future, add a row
to §1 above with its caller and stability note.

## 4. Update procedure

When you ship a new HTTP route that is not consumed by the web UI:

1. Add a row under §1 with the method, path, reason, caller, and
   stability note.
2. Cross-reference the audit's "backend routes with no web caller"
   table the next time a route audit is run; the row must appear there
   too.
3. If the route is auto-generated by `mountEntityRoutes` and not
   reached by any widget, prefer opting out (§2) over silent retention
   — dead routes clutter the audit re-run.

When the UI grows a caller for a row in §1:

1. Remove the row from this file.
2. Update the relevant API client helper in `apps/web/src/lib/api.ts`.
3. The next audit run will confirm the route is no longer in the
   "no web caller" table.
