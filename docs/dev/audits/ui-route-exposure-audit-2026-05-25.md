# UI / Route Exposure Audit — 2026-05-25

Question: are all backend HTTP routes reachable from the UI, and are all
web pages linked from navigation?

Method: walked every `app.{get,post,put,patch,delete}` registration in
`apps/server/src` (including the generic `mountEntityRoutes` factory in
`apps/server/src/entities/router.ts`), then every page / API client call
in `apps/web/src`. The desktop app (`apps/desktop`) is an Electron shell
that loads the same web bundle — it adds no HTTP routes and no extra
pages.

---

## Summary

- **No truly "stealth" features.** Every shipped phase (8.x proposals
  auto-rollback, 11.x whiteboards, per-message LLM trace inspector,
  6.6 chat board) IS reachable from the UI navigation.
- **Backend routes with no web caller: 8** — all are either intentional
  REST symmetry (single-resource GETs that the list endpoint already
  covers) or quietly shipped admin/recovery surfaces (soft-delete
  restore, layer-member removal, admin user detail, admin scheduled-task
  per-task runs, contact/calendar/whiteboard external-link mutations).
  None are entire features.
- **Pages reachable only by URL: 4** — the per-entity `…/new` deep-link
  routes for companies / contacts / calendar / todos / whiteboards are
  not in the nav; they're invoked via the dashboard widget "create"
  CTAs, which is by design. Plus the `LayerChatBoardPage` is reached
  only via an in-page link from `LayerChatPage`, not from the top nav.
- **Capabilities, Proposals, Trace inspector, Whiteboards, Chat board**
  — all wired correctly.

---

## 1. Backend route inventory

Source files: `apps/server/src/http/routes/*.ts`,
`apps/server/src/entities/router.ts` (generic kind CRUD),
`apps/server/src/entities/whiteboards/{routes,recent}.ts`,
`apps/server/src/entities/todos/calendar-projection-routes.ts`.

### Public / status / auth

| Method | Path              | File                                       |
| ------ | ----------------- | ------------------------------------------ |
| GET    | `/status`         | `routes/status.ts`                         |
| POST   | `/auth/login`     | `routes/auth.ts`                           |
| POST   | `/auth/logout`    | `routes/auth.ts`                           |
| GET    | `/auth/me`        | `routes/auth.ts`                           |
| POST   | `/auth/password`  | `routes/auth.ts`                           |
| POST   | `/chat`           | `routes/chat.ts` (legacy single-shot chat) |
| GET    | `/system/locales` | `routes/system-locales.ts`                 |

### Me / discovery

| Method | Path                 | File                   |
| ------ | -------------------- | ---------------------- |
| GET    | `/me/layers`         | `routes/me-layers.ts`  |
| GET    | `/me/visible-users`  | `routes/me-visible.ts` |
| GET    | `/me/visible-groups` | `routes/me-visible.ts` |

### Layers (CRUD + members + visibility + locales + attachments)

| Method | Path                                   | File               |
| ------ | -------------------------------------- | ------------------ |
| GET    | `/layers`                              | `routes/layers.ts` |
| POST   | `/layers`                              | `routes/layers.ts` |
| GET    | `/layers/:slug`                        | `routes/layers.ts` |
| PATCH  | `/layers/:slug`                        | `routes/layers.ts` |
| DELETE | `/layers/:slug`                        | `routes/layers.ts` |
| POST   | `/layers/:slug/members`                | `routes/layers.ts` |
| DELETE | `/layers/:slug/members/:memberId`      | `routes/layers.ts` |
| GET    | `/layers/:slug/visibility`             | `routes/layers.ts` |
| POST   | `/layers/:slug/visibility`             | `routes/layers.ts` |
| DELETE | `/layers/:slug/visibility/:parentSlug` | `routes/layers.ts` |
| POST   | `/layers/:slug/locales`                | `routes/layers.ts` |
| GET    | `/layers/:slug/attachments`            | `routes/layers.ts` |
| POST   | `/layers/:slug/attachments`            | `routes/layers.ts` |
| DELETE | `/layers/:slug/attachments/:id`        | `routes/layers.ts` |

### Admin: users / groups / scheduled-tasks / DLQ

| Method | Path                                  | File                              |
| ------ | ------------------------------------- | --------------------------------- |
| GET    | `/admin/users`                        | `routes/admin-users.ts`           |
| GET    | `/admin/users/:id`                    | `routes/admin-users.ts`           |
| POST   | `/admin/users`                        | `routes/admin-users.ts`           |
| PATCH  | `/admin/users/:id`                    | `routes/admin-users.ts`           |
| DELETE | `/admin/users/:id`                    | `routes/admin-users.ts`           |
| POST   | `/admin/users/:id/reset-password`     | `routes/admin-users.ts`           |
| GET    | `/admin/groups`                       | `routes/admin-groups.ts`          |
| GET    | `/admin/groups/:id`                   | `routes/admin-groups.ts`          |
| POST   | `/admin/groups`                       | `routes/admin-groups.ts`          |
| PATCH  | `/admin/groups/:id`                   | `routes/admin-groups.ts`          |
| DELETE | `/admin/groups/:id`                   | `routes/admin-groups.ts`          |
| POST   | `/admin/groups/:id/members`           | `routes/admin-groups.ts`          |
| DELETE | `/admin/groups/:id/members/:memberId` | `routes/admin-groups.ts`          |
| GET    | `/admin/scheduled-tasks`              | `routes/admin-scheduled-tasks.ts` |
| GET    | `/admin/scheduled-tasks/:taskId/runs` | `routes/admin-scheduled-tasks.ts` |
| GET    | `/admin/bus/dlq`                      | `routes/admin-bus.ts`             |
| POST   | `/admin/bus/dlq/:outboxId/replay`     | `routes/admin-bus.ts`             |

### Per-layer scheduled tasks

| Method | Path                                        | File                        |
| ------ | ------------------------------------------- | --------------------------- |
| GET    | `/l/:slug/scheduled-tasks`                  | `routes/scheduled-tasks.ts` |
| GET    | `/l/:slug/scheduled-tasks/_kinds`           | `routes/scheduled-tasks.ts` |
| GET    | `/l/:slug/scheduled-tasks/_recent-runs`     | `routes/scheduled-tasks.ts` |
| GET    | `/l/:slug/scheduled-tasks/:taskSlug`        | `routes/scheduled-tasks.ts` |
| POST   | `/l/:slug/scheduled-tasks`                  | `routes/scheduled-tasks.ts` |
| PATCH  | `/l/:slug/scheduled-tasks/:taskSlug`        | `routes/scheduled-tasks.ts` |
| DELETE | `/l/:slug/scheduled-tasks/:taskSlug`        | `routes/scheduled-tasks.ts` |
| POST   | `/l/:slug/scheduled-tasks/:taskSlug/pause`  | `routes/scheduled-tasks.ts` |
| POST   | `/l/:slug/scheduled-tasks/:taskSlug/resume` | `routes/scheduled-tasks.ts` |
| POST   | `/l/:slug/scheduled-tasks/:taskSlug/runs`   | `routes/scheduled-tasks.ts` |
| GET    | `/l/:slug/scheduled-tasks/:taskSlug/runs`   | `routes/scheduled-tasks.ts` |

### Per-layer chat (and trace)

| Method | Path                                                   | File                   |
| ------ | ------------------------------------------------------ | ---------------------- |
| POST   | `/l/:slug/chat/conversations`                          | `routes/layer-chat.ts` |
| GET    | `/l/:slug/chat/conversations`                          | `routes/layer-chat.ts` |
| GET    | `/l/:slug/chat/conversations/:id`                      | `routes/layer-chat.ts` |
| DELETE | `/l/:slug/chat/conversations/:id`                      | `routes/layer-chat.ts` |
| GET    | `/l/:slug/chat/conversations/:cid/messages/:mid/trace` | `routes/layer-chat.ts` |
| GET    | `/l/:slug/chat/conversations/:id/messages`             | `routes/layer-chat.ts` |
| POST   | `/l/:slug/chat/conversations/:id/messages` (SSE)       | `routes/layer-chat.ts` |
| GET    | `/l/:slug/chat/board`                                  | `routes/layer-chat.ts` |
| POST   | `/l/:slug/chat/messages/:id/feedback`                  | `routes/layer-chat.ts` |
| POST   | `/l/:slug/chat/conversations/:id/regenerate-title`     | `routes/layer-chat.ts` |

### Per-layer proposals + capabilities + settings (phases 7-8)

| Method | Path                                    | File                                |
| ------ | --------------------------------------- | ----------------------------------- |
| GET    | `/l/:slug/proposals`                    | `routes/layer-proposals.ts`         |
| GET    | `/l/:slug/proposals/:id`                | `routes/layer-proposals.ts`         |
| POST   | `/l/:slug/proposals/:id/approve`        | `routes/layer-proposals.ts`         |
| POST   | `/l/:slug/proposals/:id/reject`         | `routes/layer-proposals.ts`         |
| POST   | `/l/:slug/proposals/:id/replay-sandbox` | `routes/layer-proposals.ts`         |
| POST   | `/l/:slug/proposals/:id/rollback`       | `routes/layer-proposals.ts`         |
| GET    | `/l/:slug/capabilities`                 | `routes/layer-capabilities.ts`      |
| POST   | `/l/:slug/capabilities/:id/deactivate`  | `routes/layer-capabilities.ts`      |
| GET    | `/l/:slug/settings/proposals`           | `routes/layer-proposal-settings.ts` |
| PUT    | `/l/:slug/settings/proposals`           | `routes/layer-proposal-settings.ts` |
| GET    | `/l/:slug/settings/chat`                | `routes/layer-chat-settings.ts`     |
| PUT    | `/l/:slug/settings/chat`                | `routes/layer-chat-settings.ts`     |

### Generic per-kind entity CRUD (companies, contacts, calendar_event, todo, whiteboard)

Generated by `mountEntityRoutes` in `apps/server/src/entities/router.ts`.
`<kind>` ∈ {`company`, `contact`, `calendar_event`, `todo`, `whiteboard`}.

| Method | Path                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/l/:slug/<kind>` (list summaries, with `?from=&to=` for calendar_event)                                                        |
| POST   | `/l/:slug/<kind>`                                                                                                               |
| GET    | `/l/:slug/<kind>/_stats`                                                                                                        |
| GET    | `/l/:slug/<kind>/:entitySlug`                                                                                                   |
| PATCH  | `/l/:slug/<kind>/:entitySlug`                                                                                                   |
| DELETE | `/l/:slug/<kind>/:entitySlug` (soft-delete)                                                                                     |
| POST   | `/l/:slug/<kind>/:entitySlug/restore`                                                                                           |
| POST   | `/l/:slug/<kind>/:entitySlug/external-links`                                                                                    |
| DELETE | `/l/:slug/<kind>/:entitySlug/external-links/:linkId`                                                                            |
| POST   | `/l/:slug/<kind>/_ingest/:connectorId` (only when the module has connectors: `contact/vcard`, `calendar_event/google-calendar`) |

### Whiteboard-specific overrides + dashboard endpoint

| Method | Path                                            | File                             |
| ------ | ----------------------------------------------- | -------------------------------- |
| GET    | `/l/:slug/whiteboard/_recent`                   | `entities/whiteboards/recent.ts` |
| GET    | `/l/:slug/whiteboard/_list-with-thumbnails`     | `entities/whiteboards/routes.ts` |
| POST   | `/l/:slug/whiteboard` (size-cap override)       | `entities/whiteboards/routes.ts` |
| PATCH  | `/l/:slug/whiteboard/:slug/_checkpoint`         | `entities/whiteboards/routes.ts` |
| PATCH  | `/l/:slug/whiteboard/:slug` (size-cap override) | `entities/whiteboards/routes.ts` |

### Todo → calendar projection (phase 4d.6)

| Method | Path                                   | File                                           |
| ------ | -------------------------------------- | ---------------------------------------------- |
| GET    | `/l/:slug/calendar/_projections/todos` | `entities/todos/calendar-projection-routes.ts` |

---

## 2. Frontend page / route inventory

From `apps/web/src/App.tsx` (React Router v6, BrowserRouter).

Layer-agnostic:
`/`, `/status`, `/chat`, `/layers`, `/account`,
`/admin/users`, `/admin/groups`, `/admin/scheduled-tasks`, `/admin/bus/dlq`.

Layer-scoped (`/l/:layerSlug/...`):
`dashboard`, `settings`, `companies`, `companies/new`,
`companies/:companySlug`, `contacts`, `contacts/new`, `contacts/import`,
`contacts/:contactSlug`, `calendar`, `calendar/new`,
`calendar/:eventSlug`, `todos`, `todos/new`, `todos/:todoSlug`,
`whiteboards`, `whiteboards/new`, `whiteboards/:whiteboardSlug`,
`scheduled-tasks`, `chat`, `chat/board`, `proposals`, `proposals/:id`,
`capabilities`. Plus `LayerSlugIndexRedirect` and `NotFound`.

Top-nav (always visible): Status, Chat, Layers.
Top-nav (when on `/l/:slug/*`): + Proposals, Capabilities.
Top-nav (admin only): + Admin Users, Admin Groups, Admin Scheduled
Tasks, Admin Bus DLQ.
Layer-switcher dropdown navigates between layer dashboards.
Dashboard widgets are the navigation surface for per-entity pages —
the top nav does NOT contain Companies / Contacts / Calendar / Todos /
Whiteboards / Scheduled Tasks / per-layer Chat as standalone buttons;
they're reached through the dashboard widgets, the layer dashboard
("Configure widgets" → `LayerSettingsPage`), and `LayerSlugIndexRedirect`.

---

## 3. Cross-reference findings

### 3.1 Backend routes with NO web caller

| Method | Path                                                   | Server file                       | Notes                                                                                                                                                                                                               |
| ------ | ------------------------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/admin/users/:id`                                     | `routes/admin-users.ts`           | `getAdminUser` exists in `lib/api.ts` but no caller. AdminUsersPage uses the list rows; there is no AdminUserDetailPage.                                                                                            |
| GET    | `/layers/:slug`                                        | `routes/layers.ts`                | `getLayer(slug)` defined in `lib/api.ts`, no caller. The layer detail in `LayerSettingsPage` is reached via the slug from the router and uses `/me/layers` + targeted setters.                                      |
| DELETE | `/layers/:slug/members/:memberId`                      | `routes/layers.ts`                | `removeLayerMember` defined in `lib/api.ts`, no caller. MembersTab in `LayerSettingsPage` lets users _add_ members but offers no remove control.                                                                    |
| GET    | `/admin/scheduled-tasks/:taskId/runs`                  | `routes/admin-scheduled-tasks.ts` | No client helper, no caller. The per-layer runs endpoint IS used by `ScheduledTasksListPage`.                                                                                                                       |
| POST   | `/l/:slug/<kind>/:entitySlug/restore`                  | `entities/router.ts`              | All 5 kinds expose this; no web UI for it. Delete buttons exist on every detail page; restoring a soft-deleted row requires direct API access.                                                                      |
| POST   | `/l/:slug/contact/:slug/external-links`                | `entities/router.ts`              | Only Companies UI offers external-link CRUD. Contact externalLinks are read-only in the UI (vCard import populates them).                                                                                           |
| DELETE | `/l/:slug/contact/:slug/external-links/:linkId`        | `entities/router.ts`              | Same as above.                                                                                                                                                                                                      |
| POST   | `/l/:slug/calendar_event/:slug/external-links`         | `entities/router.ts`              | Calendar event externalLinks shown read-only in detail page.                                                                                                                                                        |
| DELETE | `/l/:slug/calendar_event/:slug/external-links/:linkId` | `entities/router.ts`              | Same.                                                                                                                                                                                                               |
| POST   | `/l/:slug/whiteboard/:slug/external-links`             | `entities/router.ts`              | Whiteboard externalLinks read-only (enrichment subscriber writes them).                                                                                                                                             |
| DELETE | `/l/:slug/whiteboard/:slug/external-links/:linkId`     | `entities/router.ts`              | Same.                                                                                                                                                                                                               |
| POST   | `/l/:slug/todo/:slug/external-links`                   | `entities/router.ts`              | Todo externalLinks not surfaced anywhere.                                                                                                                                                                           |
| DELETE | `/l/:slug/todo/:slug/external-links/:linkId`           | `entities/router.ts`              | Same.                                                                                                                                                                                                               |
| GET    | `/l/:slug/whiteboard/_stats`                           | `entities/router.ts`              | Auto-generated by `mountEntityRoutes`; whiteboard widget uses `_recent` instead, so `_stats` for whiteboard is dead. (`company`, `contact`, `calendar_event`, `todo` stats are wired into their dashboard widgets.) |

### 3.2 Web pages NOT linked from primary navigation

Each is intentional; documenting how they're reached.

| Page                                     | Route                      | How reached                                                                                       |
| ---------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------- |
| `CompaniesListPage` (new mode)           | `/l/:slug/companies/new`   | Dashboard CompaniesWidget "Create" CTA. List page opens a create dialog.                          |
| `ContactsListPage` (new mode)            | `/l/:slug/contacts/new`    | Dashboard ContactsWidget "Import" CTA falls back to list new.                                     |
| `ContactsImportPage`                     | `/l/:slug/contacts/import` | Dashboard ContactsWidget "Import" CTA.                                                            |
| `CalendarPage` (new)                     | `/l/:slug/calendar/new`    | Dashboard CalendarWidget "New event" CTA.                                                         |
| `TodosPage` (new)                        | `/l/:slug/todos/new`       | Dashboard TodosWidget "New todo" CTA.                                                             |
| `WhiteboardsListPage` (new)              | `/l/:slug/whiteboards/new` | Dashboard WhiteboardsWidget "New" CTA.                                                            |
| `LayerChatBoardPage`                     | `/l/:slug/chat/board`      | In-page link from `LayerChatPage` ("Open board") only — no top-nav entry.                         |
| `LayerSettingsPage`                      | `/l/:slug/settings`        | "Configure widgets" / per-widget settings deep link from `LayerDashboardPage`. No top-nav button. |
| `ScheduledTasksListPage`                 | `/l/:slug/scheduled-tasks` | Dashboard `RecentRunsWidget` "View all" CTA only. No top-nav button.                              |
| `LayerDashboardPage`                     | `/l/:slug/dashboard`       | Layer switcher and `RootRedirect`.                                                                |
| `MyLayersPage`                           | `/layers`                  | Top-nav "Layers" button.                                                                          |
| Per-entity detail pages (`/:entitySlug`) | various                    | Reached from each list / widget.                                                                  |

All layer-scoped per-entity pages (Companies, Contacts, Calendar, Todos,
Whiteboards) and per-layer Chat / Scheduled Tasks are reached only via
the layer dashboard widgets, never the top nav. This is a deliberate
"dashboard-first" pattern but worth noting: a layer with all widgets
disabled would technically have no UI path to these pages.

### 3.3 Features built but exposure status

| Feature / phase                                            | Server                                                   | UI Surface                                                                   | Reachable from nav?                                                                 |
| ---------------------------------------------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Phase 6.6 Chat board (kanban)                              | `GET /chat/board`                                        | `LayerChatBoardPage`                                                         | Yes — `LayerChatPage` → "Open board" link. NOT in top nav.                          |
| Per-message LLM trace inspector                            | `GET .../trace`                                          | `MessageTracePanel` in `LayerChatPage`                                       | Yes — collapsed `<details>` under each assistant message.                           |
| Phase 7.6 Proposals + Capabilities                         | `/l/:slug/proposals*`, `/capabilities*`                  | `LayerProposalsListPage`, `LayerProposalDetailPage`, `LayerCapabilitiesPage` | Yes — top nav (when on `/l/:slug/*`).                                               |
| Phase 8.4 Per-layer proposal settings                      | `GET/PUT /settings/proposals`                            | `LayerSettingsProposalsTab`                                                  | Yes — LayerSettingsPage tab.                                                        |
| Phase 8.5 Manual rollback                                  | `POST .../proposals/:id/rollback`                        | `LayerProposalDetailPage` rollback button with confirmation dialog           | Yes.                                                                                |
| Phase 9 (auto-rollback watcher)                            | follow-up `proposals-auto-rollback-watcher.md`           | none yet (storage migration shipped)                                         | n/a — work still open.                                                              |
| Phase 11 Whiteboards (full CRUD + Excalidraw + checkpoint) | `/l/:slug/whiteboard*`                                   | `WhiteboardsListPage`, `WhiteboardDetailPage`, `WhiteboardsWidget`           | Yes — via dashboard widget; list page is at `/l/:slug/whiteboards`. NOT in top nav. |
| Whiteboard external-links / restore                        | yes                                                      | no UI                                                                        | NOT reachable.                                                                      |
| Per-layer chat settings tab                                | `GET/PUT /settings/chat`                                 | `ChatTab` in `LayerSettingsPage`                                             | Yes.                                                                                |
| Calendar Google sync                                       | `POST .../_ingest/google-calendar` (via empty multipart) | `CalendarPage` button                                                        | Yes.                                                                                |
| Contacts vCard import                                      | `POST .../_ingest/vcard`                                 | `ContactsImportPage`                                                         | Yes.                                                                                |
| Layer member removal                                       | `DELETE /layers/:slug/members/:memberId`                 | none                                                                         | NOT reachable from UI.                                                              |
| Soft-delete restore                                        | `POST .../restore` (all 5 kinds)                         | none                                                                         | NOT reachable from UI.                                                              |
| Admin scheduled-task per-task runs view                    | `GET /admin/scheduled-tasks/:id/runs`                    | none                                                                         | NOT reachable from UI.                                                              |
| Admin single user fetch                                    | `GET /admin/users/:id`                                   | none (list shows enough)                                                     | NOT reachable from UI.                                                              |
| `getLayer(slug)`                                           | `GET /layers/:slug`                                      | not used by UI                                                               | n/a — `/me/layers` and `LayerSwitcher` cover the data flow.                         |

---

## 4. Notes on apps/desktop

`apps/desktop` is an Electron shell. It does not register any HTTP
routes of its own; it spawns `apps/server` as a sidecar and loads the
built web bundle, injecting `window.bunny2.apiBase` from
`preload.ts`. IPC channels are: theme set/get, open-external, and
dev/log forwarding. No additional / fewer / different routes versus
the web app.

---

## 5. Caveats

- Inventory built from grep against `app.{get,post,...}` + the generic
  `mountEntityRoutes` factory. WebSocket handlers: none found
  (Hono-based, the only stream is SSE on the messages endpoint).
- "Reachable from nav" is interpreted broadly: top-nav button OR
  dashboard widget OR in-page Link counts. Direct URL typing also
  works for every route in `App.tsx` but is not counted.
- The "no caller" verdict for `getLayer`, `getAdminUser`,
  `removeLayerMember` is based on a grep against `apps/web/src` only;
  I did not check tests, fixtures, or `apps/desktop`.
- A handful of API helpers exist for symmetry only
  (`listCompanyExternalLinks`, `listContactExternalLinks`,
  `listCalendarEventExternalLinks`) and project from the full detail
  response. They're not wired as primary fetches — checked and called
  nowhere in pages. Not flagged as orphans because the underlying
  endpoint IS hit via `getCompany` / `getContact` / `getCalendarEvent`.
- Authentication middleware (`requireAuth`, `requireAdmin`,
  `requirePasswordCurrent`, `withEffectiveLayers`) is global and not
  itemized — every protected route assumes a session cookie.
- The `_stats` audit only flags `whiteboard/_stats` as dead because
  the widget chose `_recent`. The endpoint still exists and would be
  available to a future widget.
