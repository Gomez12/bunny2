# UI / Route Exposure Audit — 2026-05-25 (closure re-run)

Re-run of [`ui-route-exposure-audit-2026-05-25.md`](./ui-route-exposure-audit-2026-05-25.md)
after the five phases of [`docs/dev/plans/done/ui-exposure-gaps.md`](../plans/done/ui-exposure-gaps.md)
shipped.

Method: same as the original audit — walked every
`app.{get,post,put,patch,delete}` registration in `apps/server/src`
(including the generic `mountEntityRoutes` factory in
`apps/server/src/entities/router.ts` and the whiteboard-specific
overrides in `apps/server/src/entities/whiteboards/{routes,recent}.ts`,
plus `apps/server/src/entities/todos/calendar-projection-routes.ts`),
then every API client helper and direct `fetch(...)` call in
`apps/web/src`.

There is no scripted audit — the re-run is a manual `grep` /
cross-reference procedure. This document is the artefact.

---

## Closure findings

| Original gap (audit §3.1)                                                                            | Closed by                                                                                                                                                  | Commit    |
| ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `POST /l/:slug/<kind>/:slug/restore` (5 kinds)                                                       | Phase 1 — `restoreEntity()` helper + per-detail `RestoreBanner` (Companies/Contacts/Calendar/Todos/Whiteboards) + `?includeDeleted=1` list toggle          | `068dc03` |
| `DELETE /layers/:slug/members/:memberId`                                                             | Phase 2 — `removeLayerMember()` helper + Members tab Remove button + sole-owner guard + new `GET /layers/:slug/members` for hydrated read                  | `0b96cf5` |
| External-link CRUD on `contact` / `calendar_event` / `whiteboard` / `todo` (4 kinds × POST + DELETE) | Phase 3 — shared `<EntityExternalLinks>` component + generic `addEntityExternalLink` / `removeEntityExternalLink` helpers wired into all four detail pages | `9edf005` |
| `GET /admin/users/:id`                                                                               | Phase 4 — `AdminUserDetailPage` (`/admin/users/:userId`) consumes `getAdminUser()`                                                                         | `f908e9b` |
| `GET /admin/scheduled-tasks/:taskId/runs`                                                            | Phase 4 — `AdminScheduledTaskRunsPage` (`/admin/scheduled-tasks/:taskId/runs`) consumes new `listAdminScheduledTaskRuns()` helper                          | `f908e9b` |
| `getLayer()` dead helper in `lib/api.ts`                                                             | Phase 5 — helper deleted; the `GET /layers/:slug` route is retained for REST symmetry / operator scripting and documented in `backend-only-endpoints.md`   | `d3a05b3` |
| `GET /l/:slug/whiteboard/_stats` auto-mount                                                          | Phase 5 — `mountEntityRoutes({ optOutOfStats: true })` for whiteboards; route is no longer registered; rationale + opt-out docs added                      | `d3a05b3` |

All seven gaps closed. No phase deferred or partial.

---

## Backend routes with NO web caller (re-run)

The same grep was repeated against the current tree.

| Method | Path            | Server file        | In allow-list?                                                                                                                                                                    |
| ------ | --------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/layers/:slug` | `routes/layers.ts` | Yes — `docs/dev/architecture/backend-only-endpoints.md` §1 (single-layer GET kept for REST symmetry + operator scripting; the UI uses `GET /me/layers` and the targeted setters). |

The table contains exactly one entry, and that entry is the only row
in `backend-only-endpoints.md` §1. Cross-check passes: every "no web
caller" route is documented as intentionally backend-only.

`GET /l/:slug/whiteboard/_stats` does NOT appear in the table because
Phase 5 opted whiteboards out of `mountEntityRoutes`'s auto `_stats`
registration; the route is no longer mounted at all. It is referenced
in `backend-only-endpoints.md` §2 ("Routes deliberately not mounted")
as a historical note.

---

## Cross-reference: every server route → web caller (current state)

For traceability the full inventory is reproduced. Headers mirror the
original audit so a future audit can diff line-by-line.

### Public / status / auth

| Method | Path              | Web caller                        |
| ------ | ----------------- | --------------------------------- |
| GET    | `/status`         | `getStatus()` → `StatusPage`      |
| POST   | `/auth/login`     | `login()` → `LoginPage`           |
| POST   | `/auth/logout`    | `logout()` → top-nav              |
| GET    | `/auth/me`        | `getMe()` direct fetch            |
| POST   | `/auth/password`  | `changePassword()` → account page |
| POST   | `/chat`           | `chat()` → legacy `ChatPage`      |
| GET    | `/system/locales` | `getSystemLocales()` → app shell  |

### Me / discovery

| Method | Path                 | Web caller                                  |
| ------ | -------------------- | ------------------------------------------- |
| GET    | `/me/layers`         | `listMyLayers()` → layer switcher, MyLayers |
| GET    | `/me/visible-users`  | `listVisibleUsers()` → Members picker       |
| GET    | `/me/visible-groups` | `listVisibleGroups()` → Members picker      |

### Layers

| Method | Path                                   | Web caller                                           |
| ------ | -------------------------------------- | ---------------------------------------------------- |
| GET    | `/layers`                              | `listLayers()` admin filter                          |
| POST   | `/layers`                              | `createLayer()` → MyLayersPage                       |
| GET    | `/layers/:slug`                        | **none** — intentional (see allow-list §1)           |
| PATCH  | `/layers/:slug`                        | `updateLayer()` → LayerSettingsPage                  |
| DELETE | `/layers/:slug`                        | `deleteLayer()` → LayerSettingsPage                  |
| GET    | `/layers/:slug/members`                | `listLayerMembers()` → Members tab (Phase 2)         |
| POST   | `/layers/:slug/members`                | `addLayerMember()` → Members tab picker              |
| DELETE | `/layers/:slug/members/:memberId`      | `removeLayerMember()` → Members tab Remove (Phase 2) |
| GET    | `/layers/:slug/visibility`             | `listLayerVisibility()` → Visibility tab             |
| POST   | `/layers/:slug/visibility`             | `addLayerVisibility()` → Visibility tab              |
| DELETE | `/layers/:slug/visibility/:parentSlug` | `removeLayerVisibility()` → Visibility tab           |
| POST   | `/layers/:slug/locales`                | `setLayerLocales()` → Locales tab                    |
| GET    | `/layers/:slug/attachments`            | `listLayerAttachments()` → Attachments tab           |
| POST   | `/layers/:slug/attachments`            | `addLayerAttachment()` → Attachments tab             |
| DELETE | `/layers/:slug/attachments/:id`        | `removeLayerAttachment()` → Attachments tab          |

### Admin: users / groups / scheduled-tasks / DLQ

| Method | Path                                  | Web caller                                                            |
| ------ | ------------------------------------- | --------------------------------------------------------------------- |
| GET    | `/admin/users`                        | `listAdminUsers()` → AdminUsersPage                                   |
| GET    | `/admin/users/:id`                    | `getAdminUser()` → AdminUserDetailPage (Phase 4)                      |
| POST   | `/admin/users`                        | `createAdminUser()` → AdminUsersPage                                  |
| PATCH  | `/admin/users/:id`                    | `updateAdminUser()` → AdminUsersPage / detail                         |
| DELETE | `/admin/users/:id`                    | `deleteAdminUser()` → AdminUsersPage                                  |
| POST   | `/admin/users/:id/reset-password`     | `resetAdminUserPassword()` → AdminUsersPage                           |
| GET    | `/admin/groups`                       | `listAdminGroups()` → AdminGroupsPage                                 |
| GET    | `/admin/groups/:id`                   | `getAdminGroup()` → AdminGroupsPage / detail                          |
| POST   | `/admin/groups`                       | `createAdminGroup()` → AdminGroupsPage                                |
| PATCH  | `/admin/groups/:id`                   | `updateAdminGroup()` → AdminGroupsPage                                |
| DELETE | `/admin/groups/:id`                   | `deleteAdminGroup()` → AdminGroupsPage                                |
| POST   | `/admin/groups/:id/members`           | `addAdminGroupMember()` → AdminGroupsPage                             |
| DELETE | `/admin/groups/:id/members/:memberId` | `removeAdminGroupMember()` → AdminGroupsPage                          |
| GET    | `/admin/scheduled-tasks`              | `listAdminScheduledTasks()` → AdminScheduledTasksPage                 |
| GET    | `/admin/scheduled-tasks/:taskId/runs` | `listAdminScheduledTaskRuns()` → AdminScheduledTaskRunsPage (Phase 4) |
| GET    | `/admin/bus/dlq`                      | `listAdminBusDlq()` → AdminBusDlqPage                                 |
| POST   | `/admin/bus/dlq/:outboxId/replay`     | `replayAdminBusDlq()` → AdminBusDlqPage                               |

### Per-layer scheduled tasks

All paths under `/l/:slug/scheduled-tasks*` retain a 1:1 helper +
`ScheduledTasksListPage` consumer. No change vs. the original audit.

### Per-layer chat (and trace)

All paths under `/l/:slug/chat/*` retain helpers consumed by
`LayerChatPage`, `LayerChatBoardPage`, and `MessageTracePanel`. The
per-message trace endpoint added in commit `53b52b1` is consumed by
the inline `<details>` trace inspector under each assistant message.

### Per-layer proposals + capabilities + settings

All paths under `/l/:slug/proposals*`, `/l/:slug/capabilities*`,
`/l/:slug/settings/{proposals,chat}` retain helpers consumed by the
matching pages / settings tabs. No change vs. the original audit.

### Generic per-kind entity CRUD

For `<kind>` ∈ {`company`, `contact`, `calendar_event`, `todo`,
`whiteboard`} (`whiteboard` uses the route overrides in
`apps/server/src/entities/whiteboards/routes.ts` for POST + PATCH +
`_checkpoint` + `_list-with-thumbnails` instead of the generic
implementations):

| Method | Path pattern                                          | Web caller after closure                                                                                                   |
| ------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/l/:slug/<kind>`                                     | `list…Summaries()` per kind                                                                                                |
| POST   | `/l/:slug/<kind>`                                     | `create…()` per kind (whiteboards via override)                                                                            |
| GET    | `/l/:slug/<kind>/_stats`                              | dashboard `*Widget` per kind (whiteboards opt out — see allow-list §2)                                                     |
| GET    | `/l/:slug/<kind>/:slug`                               | `get…()` per kind                                                                                                          |
| PATCH  | `/l/:slug/<kind>/:slug`                               | `patch…()` per kind (whiteboards via override)                                                                             |
| DELETE | `/l/:slug/<kind>/:slug`                               | `softDelete…()` per kind                                                                                                   |
| POST   | `/l/:slug/<kind>/:slug/restore`                       | `restoreEntity(layerSlug, kind, slug)` → `RestoreBanner` (Phase 1)                                                         |
| POST   | `/l/:slug/<kind>/:slug/external-links`                | Companies-native `addCompanyExternalLink` + generic `addEntityExternalLink` for contact/calendar/todo/whiteboard (Phase 3) |
| DELETE | `/l/:slug/<kind>/:slug/external-links/:linkId`        | Companies-native `removeCompanyExternalLink` + generic `removeEntityExternalLink` (Phase 3)                                |
| POST   | `/l/:slug/<kind>/_ingest/:connectorId` (when present) | `ContactsImportPage` (`contact/vcard`) + `CalendarPage` (`calendar_event/google.calendar`)                                 |

### Whiteboard-specific overrides + dashboard endpoint

| Method | Path                                        | Web caller                                                |
| ------ | ------------------------------------------- | --------------------------------------------------------- |
| GET    | `/l/:slug/whiteboard/_recent`               | `listRecentWhiteboards()` → `WhiteboardsWidget`           |
| GET    | `/l/:slug/whiteboard/_list-with-thumbnails` | `listWhiteboardsWithThumbnails()` → `WhiteboardsListPage` |
| POST   | `/l/:slug/whiteboard` (override)            | `createWhiteboard()`                                      |
| PATCH  | `/l/:slug/whiteboard/:slug/_checkpoint`     | `patchWhiteboardCheckpoint()` → `WhiteboardDetailPage`    |
| PATCH  | `/l/:slug/whiteboard/:slug` (override)      | `patchWhiteboard()` → `WhiteboardDetailPage`              |

### Todo → calendar projection

| Method | Path                                   | Web caller                                       |
| ------ | -------------------------------------- | ------------------------------------------------ |
| GET    | `/l/:slug/calendar/_projections/todos` | `listTodoCalendarProjections()` → `CalendarPage` |

---

## 2. Frontend pages — no change

Phase 4 added `/admin/users/:userId` and
`/admin/scheduled-tasks/:taskId/runs`. Both are reachable via row
links from their respective list pages; both are admin-only (gated by
`requireAdmin`) and intentionally absent from the global top nav.

No other web routes were added or removed since the original audit.

---

## 3. Cross-reference findings

### 3.1 Backend routes with NO web caller (after closure)

Single row, listed above. Matches `backend-only-endpoints.md` §1.

### 3.2 Web pages NOT linked from primary navigation (after closure)

Original audit §3.2 + two Phase-4 additions:

| Page                         | Route                                 | How reached                                |
| ---------------------------- | ------------------------------------- | ------------------------------------------ |
| Original §3.2 rows           | unchanged                             | unchanged                                  |
| `AdminUserDetailPage`        | `/admin/users/:userId`                | `AdminUsersPage` row link.                 |
| `AdminScheduledTaskRunsPage` | `/admin/scheduled-tasks/:taskId/runs` | `AdminScheduledTasksPage` row "Runs" link. |

Both intentional: deep admin views reached from the matching admin
list page, never from the global top nav.

### 3.3 Stealth features

None. Every shipped surface, including the trace inspector
(`53b52b1`), the Phase 8 manual rollback button, and the Phase 11
whiteboards module, remains reachable.

---

## 4. Verdict

Closure cross-check passes. The `ui-exposure-gaps` plan can be moved
to `docs/dev/plans/done/`.

No regressions detected. No new backend-only endpoints were added
after `0a145c1`; the single allow-listed row (`GET /layers/:slug`) is
documented and stable.
