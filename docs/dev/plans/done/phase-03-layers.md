# Phase 3 — Layers

> Parent: [`overall.md`](../overall.md) §8 Phase 3.
> Scope of this document: **detailed plan for phase 3 only**.
> Inherits from `overall.md` §4 (stack), §5 (event-sourced core,
> soft-delete, versioned entities, **layered scoping**,
> auth-aware retrieval, multi-language), §10. Builds on phase 2
> ([`phase-02-users-and-groups.md`](./phase-02-users-and-groups.md))
> — every route is auth-gated;
> `users`, `groups`, `user_group_memberships`,
> `group_group_memberships`, `sessions` already exist.

---

## 1. Goal

Introduce the **layer** as the project's primary scoping unit. From
phase 3 onward every entity (phase 4+) is born inside a layer, and
every read crosses a layer-aware access boundary. Phase 3 ships:

- The `layers` schema (types: `personal`, `project`, `group`,
  `everyone`).
- A deterministic, cached **effective-layer-set resolver** keyed on
  `userId`, so phase 4 entity reads and the phase 6 chat retrieval
  can ask "which layers may this user see right now?" once.
- HTTP CRUD for layers, layer hierarchy (visibility), layer locale
  subsets, and layer attachments (agents / skills / MCP servers —
  **registration only**; consumers arrive in later phases).
- A web app shell that always shows the **current layer**, lets a
  user switch layer, and renders an empty dashboard shell per layer.
- Seed data: an `everyone` layer, one `personal` layer per existing
  user, one `group` layer per existing group. Seed is idempotent.

After phase 3 a developer should be able to:

1. Log in as the seeded admin, open the layer switcher, and see
   `Everyone`, `Personal — admin`, `Group — admin`.
2. Create a `Project` layer named "Bunny2" and add another user.
3. Switch to that project layer and see the empty dashboard shell.
4. Verify (via `GET /auth/me` or `GET /me/layers`) that the second
   user sees the new project layer in their list and that a
   non-member does **not**.

---

## 2. Scope

In scope:

- Schema migration `0003_layers.sql` (see §4.2).
- Layer-type enum: `personal | project | group | everyone`.
- Layer hierarchy via directed edges with a `direction` of
  `top_down | bottom_up | both`, defaulting to `bottom_up`
  (a child layer sees its parent's entities — the "layer sees
  everything above it" rule from `overall.md` §5.4).
- Per-layer membership for **project** layers
  (`layer_user_members`, `layer_group_members`). Personal /
  group / everyone layers derive membership from existing tables.
- Per-layer locale subset (`layer_locales`), validated against the
  system-locale list already configured for the server.
- Per-layer attachment registry (`layer_attachments`) for
  `agent | skill | mcp_server`. Registration only — no executor
  reads it yet.
- Per-layer dashboard layout (`layer_dashboard_widgets`). Empty
  widget grid; widget kinds are stubs.
- Effective-layer-set resolver +
  cache + bus-invalidating subscriber on `layer.*`, `group.*`,
  `user.*` events.
- HTTP routes (no admin-only gate — see §4.5 for per-layer auth):
  - `GET /me/layers` — current user's visible layers (resolved;
    convenience alias for the switcher).
  - `GET /layers` — same set as `/me/layers`, with filter/sort
    query params (used by the "browse my layers" page).
  - `POST /layers` — create a `project` layer; caller becomes
    owner via a `layer_user_members` row with `role = 'owner'`.
  - `GET /layers/:slug` — layer detail if visible.
  - `PATCH /layers/:slug` — update name / description (owner or
    site-admin; personal layers also accept the owning user).
  - `DELETE /layers/:slug` — soft delete (owner or site-admin;
    personal / group / everyone layers reject).
  - `POST /layers/:slug/members { userId | groupId, role }`
    and `DELETE /layers/:slug/members/:memberId` (project
    layers only; owner-only).
  - `POST /layers/:slug/visibility { parentSlug, direction }`
    and `DELETE /layers/:slug/visibility/:parentSlug` (owner-
    only; v1 only accepts `direction = 'bottom_up'`, see §11.6).
  - `POST /layers/:slug/locales { locales[] }` (owner-only).
  - `POST /layers/:slug/attachments { kind, refId, config }`
    and `DELETE /layers/:slug/attachments/:id` (owner-only).
  - `GET /system/locales` — system-configured locale list.
- Event types persisted by the existing event log:
  `layer.created`, `layer.updated`, `layer.deleted`,
  `layer.visibility.added`, `layer.visibility.removed`,
  `layer.member.added`, `layer.member.removed`,
  `layer.locale.set`, `layer.attachment.registered`,
  `layer.attachment.removed`.
- HTTP middleware extension: every authenticated request gets
  `c.var.effectiveLayers: Layer[]`. The **current layer** is no
  longer a separate concern — it's the `:slug` URL segment on
  any layer-scoped route, validated against `effectiveLayers`
  inside the route handler. Non-layer-scoped routes (the auth
  endpoints, `/me/*`, `/system/*`) stay flat.
- Web UI (every layer-scoped page nests under `/l/:slug/...`,
  so bookmarks, browser-history and the Electron "reopen where
  you left off" work natively):
  - App-shell `LayerSwitcher` (current layer + dropdown);
    selecting a layer **navigates** to the same logical page
    under the new slug (`/l/personal-admin/dashboard` →
    `/l/bunny2/dashboard`).
  - `MyLayersPage` (`/layers`): list of visible layers with a
    `Create project layer` button. Available to every
    authenticated user.
  - `LayerSettingsPage` (`/l/:slug/settings`): tabs for
    `General`, `Members`, `Visibility`, `Locales`,
    `Attachments`. Tabs render disabled controls for users
    without owner / site-admin rights.
  - `LayerDashboardPage` (`/l/:slug/dashboard`): empty widget
    grid scoped to the URL's layer.
- i18n namespaces: `layer.*`, `admin.layers.*`, `errors.layer.*`.
- Smoke test extended to cover the layer-aware visibility cycle.

Out of scope (deferred):

- Entity CRUD that **uses** layers — that is phase 4.
- LanceDB pre-retrieval auth filter — implemented at the LanceDB
  call site in phase 6; phase 3 just ships the resolver it will
  consume.
- Real dashboard widgets — only the grid + slot contract.
- Agent / skill / MCP execution wiring — phase 7.
- Personal-layer rename UI (users get the seeded
  "Personal — `{displayName}`" until a follow-up adds rename).
- Per-layer LLM override (already plannable, but the
  attachment registry is sufficient for now).

---

## 3. Non-Goals (phase 3)

- No automatic layer creation on user/group create-after-3-ships
  beyond what the bus subscriber wires (see §4.4). No retro UI to
  reshuffle the seed.
- No fine-grained per-route permission system beyond
  "user is in layer's effective set". Layer-role-level RBAC is a
  follow-up.
- No layer transfer / merge / split.

---

## 4. Approach

> **Status (2026-05-23):** sub-phases 3.1–3.6 are all `done`; this
> plan is the canonical close-out (see §14). The active developer
> narrative lives in `docs/dev/architecture/layers-and-auth.md` and
> the user-facing tour in `docs/user/guides/working-with-layers.md`.

### 4.1 Sub-phases (delivery order — one tasklist row each)

**3.1 — Schema + repos**
Migration `0003_layers.sql` (see §4.2). Repos:
`layers-repo.ts`, `layer-visibility-repo.ts`,
`layer-members-repo.ts`, `layer-locales-repo.ts`,
`layer-attachments-repo.ts`. Zod schemas in
`packages/shared/src/layer.ts`. No HTTP yet.

**3.2 — Seed + effective-layer-set resolver + cache**
Idempotent seed in `apps/server/src/layers/seed.ts`:

- One `everyone` layer (slug `everyone`).
- One `personal` layer per non-deleted user (slug
  `personal-<username>`), `owner_user_id` set.
- One `group` layer per non-deleted group (slug
  `group-<group.slug>`), `owner_group_id` set.
- Default visibility edges: every layer has a `bottom_up` edge to
  `everyone`; every personal layer has a `bottom_up` edge to each
  of the user's group layers (transitive groups expanded once on
  seed; runtime resolution still walks the edges).

`resolveEffectiveLayers(userId)` returns the deduped set of
layer ids visible to `userId`, walking:

- personal layer for `userId`,
- group layers for every group `userId` is transitively in,
- `everyone`,
- every project layer where `userId` (or a group `userId` is in)
  is a `layer_user_members` / `layer_group_members` member,
- followed by edges in the configured direction.

Backed by an in-process LRU keyed on `userId` and invalidated by a
bus subscriber on `layer.*`, `group.member_*`, `user.deleted`.
Cache TTL bounded so a missed invalidation cannot stick forever.

**3.3 — Auth middleware extension + layer-scoped route helper**
Extend `requireAuth` (or a chained middleware) to:

- Compute `effectiveLayers` once per request using the resolver
  and attach as `c.var.effectiveLayers`.
- Public routes from phase 2 stay public.

Add a small route helper `requireLayer` for layer-scoped routes:

- Reads `c.req.param('slug')`.
- Looks the layer up in `effectiveLayers`; if not found returns
  `404 errors.layer.notVisible` (we use 404, not 403, so a
  non-member cannot probe layer-slug existence).
- Attaches `c.var.layer` for the handler.

This keeps the contract simple: **layer scope = URL slug**. No
header, no cookie. Per-layer auth lives in §4.5.

**3.4 — HTTP routes**
Per the §2 list. Authorization rules per route are listed in
§4.5. Every mutation publishes one event from §2.

**3.5 — Web UI**

- React Router restructure: `/l/:layerSlug/*` becomes the layer-
  scoped subtree. Default landing for an authenticated user with
  no `:layerSlug` is `/l/personal-<username>/dashboard`. A
  visited slug that's no longer visible (e.g. after a soft
  delete) falls back to the personal layer with a toast.
- `LayerSwitcher` in `AppShell` header (next to `UserMenu`):
  label = current layer name (from `useParams`), dropdown lists
  `effectiveLayers` grouped by type. Selecting an entry
  `navigate()`s to the same logical page under the new slug
  (`/l/<old>/dashboard` → `/l/<new>/dashboard`).
- `MyLayersPage` (`/layers`, layer-agnostic): table of visible
  layers + `Create project layer` dialog; row click opens
  `/l/:slug/dashboard`. Available to everyone — not in an
  admin section.
- `LayerSettingsPage` (`/l/:slug/settings`): tabs `General`,
  `Members`, `Visibility`, `Locales`, `Attachments`. Controls
  the caller doesn't have permission for render as read-only
  (per §4.5), not hidden — discoverability matters.
- `LayerDashboardPage` (`/l/:slug/dashboard`): empty grid with
  a "no widgets yet" empty state and a `Configure widgets` link
  that opens the Attachments / Dashboard tab in
  `LayerSettingsPage`. Link is enabled only when the caller has
  edit rights on the layer.
- Every string from i18n. The current layer's name appears next
  to page titles so the user always knows the scope.

**3.6 — Docs + ADRs + extended smoke**

- ADR `0009 — layer model` (types, hierarchy default = bottom_up,
  why edge-based vs nested-set).
- ADR `0010 — effective-layer-set resolver + invalidation
strategy` (LRU + bus subscriber; future LanceDB consumer).
- `docs/dev/architecture/layers-and-auth.md` — new doc; covers
  the model, the resolver, the request-scoped enrichment, and how
  phase 4 entities will inherit the scope.
- Update `architecture/overview.md` (layer band in the spine
  diagram) and `architecture/event-bus.md` (new event types).
- `docs/user/guides/working-with-layers.md` — new user-facing
  doc with screenshots of the switcher and admin pages.
- Smoke extended (see §6).

### 4.2 Schema sketch

```sql
-- 0003_layers.sql
CREATE TABLE layers (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('personal','project','group','everyone')),
  slug TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  description TEXT,
  owner_user_id TEXT REFERENCES users(id),  -- personal layers
  owner_group_id TEXT REFERENCES groups(id), -- group layers
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  CHECK (
    (type = 'personal' AND owner_user_id IS NOT NULL AND owner_group_id IS NULL) OR
    (type = 'group'    AND owner_group_id IS NOT NULL AND owner_user_id IS NULL) OR
    (type IN ('project','everyone') AND owner_user_id IS NULL AND owner_group_id IS NULL)
  )
);
CREATE INDEX idx_layers_type ON layers(type);
CREATE INDEX idx_layers_deleted_at ON layers(deleted_at);

CREATE TABLE layer_visibility_edges (
  parent_layer_id TEXT NOT NULL REFERENCES layers(id),
  child_layer_id  TEXT NOT NULL REFERENCES layers(id),
  direction       TEXT NOT NULL CHECK (direction IN ('top_down','bottom_up','both')),
  created_at      TEXT NOT NULL,
  PRIMARY KEY (parent_layer_id, child_layer_id),
  CHECK (parent_layer_id != child_layer_id)
);
CREATE INDEX idx_layer_visibility_child ON layer_visibility_edges(child_layer_id);

CREATE TABLE layer_user_members (
  layer_id TEXT NOT NULL REFERENCES layers(id),
  user_id  TEXT NOT NULL REFERENCES users(id),
  role     TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (layer_id, user_id)
);

CREATE TABLE layer_group_members (
  layer_id TEXT NOT NULL REFERENCES layers(id),
  group_id TEXT NOT NULL REFERENCES groups(id),
  role     TEXT NOT NULL DEFAULT 'member',
  created_at TEXT NOT NULL,
  PRIMARY KEY (layer_id, group_id)
);

CREATE TABLE layer_locales (
  layer_id TEXT NOT NULL REFERENCES layers(id),
  locale   TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (layer_id, locale)
);

CREATE TABLE layer_attachments (
  id          TEXT PRIMARY KEY,
  layer_id    TEXT NOT NULL REFERENCES layers(id),
  kind        TEXT NOT NULL CHECK (kind IN ('agent','skill','mcp_server')),
  ref_id      TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL,
  UNIQUE (layer_id, kind, ref_id)
);

CREATE TABLE layer_dashboard_widgets (
  id          TEXT PRIMARY KEY,
  layer_id    TEXT NOT NULL REFERENCES layers(id),
  widget_kind TEXT NOT NULL,
  position    INTEGER NOT NULL,
  layout_json TEXT NOT NULL DEFAULT '{}',
  created_at  TEXT NOT NULL
);
```

### 4.3 Resolver contract

```ts
// apps/server/src/layers/resolver.ts
export interface LayerResolver {
  effectiveLayers(userId: string): Promise<readonly Layer[]>;
  invalidate(userId?: string): void;
}
```

Cache is process-local; replaceable adapter (similar shape to the
phase-2 transitive-group cache) so a future Redis-backed adapter
stays additive.

### 4.4 Per-layer authorization

No admin-only gate on `/layers/*`. Authorization is computed per
route from the caller's relationship to the layer:

| Route                                          | Allowed for                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /me/layers`, `GET /layers`                | any authenticated user (returns `effectiveLayers`)                                                                                                      |
| `GET /layers/:slug`                            | any authenticated user **iff** the slug is in `effectiveLayers` (else 404 `errors.layer.notVisible`)                                                    |
| `POST /layers` (create project layer)          | any authenticated user; caller is inserted into `layer_user_members` with `role = 'owner'` in the same transaction                                      |
| `PATCH /layers/:slug` / `DELETE /layers/:slug` | personal: owning user only • project: any `owner` member or site-admin • group: any admin of the owning group or site-admin • everyone: site-admin only |
| `POST/DELETE /layers/:slug/members`            | project layers only; `owner` members or site-admin                                                                                                      |
| `POST/DELETE /layers/:slug/visibility`         | same as `PATCH /layers/:slug`; v1 rejects any `direction` other than `'bottom_up'` (see §11.6)                                                          |
| `POST /layers/:slug/locales`                   | same as `PATCH /layers/:slug`                                                                                                                           |
| `POST/DELETE /layers/:slug/attachments`        | same as `PATCH /layers/:slug`                                                                                                                           |
| `GET /system/locales`                          | any authenticated user                                                                                                                                  |

"Site-admin" = transitive membership of the `admin` group from
phase 2.4 — same check, just no longer the **only** allowed
identity. Helper `canEditLayer(user, layer)` centralises the
rule and is unit-tested.

### 4.5 Bus subscribers

- `user.created` → seed personal layer.
- `user.deleted` (soft) → soft-delete personal layer, invalidate.
- `group.created` → seed group layer + bottom_up edge to
  `everyone`.
- `group.deleted` (soft) → soft-delete group layer, invalidate.
- `group.member_added` / `group.member_removed` → invalidate
  resolver for the affected user (or all users in the group when
  a group is added to a group).
- `layer.*` → invalidate broadly (cheap; layers change rarely).

---

## 5. Affected Modules

| Module                                        | What changes                                                                                                                                              |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/storage/migrations/`         | New `0003_layers.sql`                                                                                                                                     |
| `apps/server/src/layers/` (new)               | `seed.ts`, `resolver.ts`, `subscribers.ts`                                                                                                                |
| `apps/server/src/repos/`                      | New: `layers-repo.ts`, `layer-visibility-repo.ts`, `layer-members-repo.ts`, `layer-locales-repo.ts`, `layer-attachments-repo.ts`, `layer-widgets-repo.ts` |
| `apps/server/src/auth/middleware.ts`          | Chain layer enrichment after `requireAuth`; add `requireLayer` helper                                                                                     |
| `apps/server/src/layers/authz.ts` (new)       | `canEditLayer(user, layer)` per the §4.4 table                                                                                                            |
| `apps/server/src/http/routes/`                | New: `me-layers.ts`, `layers.ts`, `system-locales.ts` (no `admin-layers.ts`)                                                                              |
| `apps/server/src/http/router.ts`              | Register new routes; per-layer authz via `canEditLayer`, no admin gate                                                                                    |
| `apps/server/src/index.ts`                    | Boot resolver + seed call; expose `status.layers` block                                                                                                   |
| `apps/web/src/components/`                    | `LayerSwitcher`, layer-list table primitives                                                                                                              |
| `apps/web/src/App.tsx`                        | Router restructure: `/l/:layerSlug/*` subtree + slug-fallback redirect                                                                                    |
| `apps/web/src/pages/`                         | `MyLayersPage`, `LayerSettingsPage` (+ tabs), `LayerDashboardPage`                                                                                        |
| `apps/web/src/lib/api.ts`                     | Layer + system-locale calls (with credentials, slug in path)                                                                                              |
| `apps/web/src/lib/use-current-layer.ts` (new) | Hook returning the resolved layer from `useParams()` + caller's edit permission                                                                           |
| `apps/web/src/i18n/locales/`                  | `layer.*`, `admin.layers.*`, `errors.layer.*` keys (en base + nl showcase subset, rest warn-only)                                                         |
| `packages/shared/src/layer.ts` (new)          | Zod schemas: `Layer`, `LayerVisibilityEdge`, `LayerMember`, `LayerAttachment`, `LayerDashboardWidget`                                                     |
| `docs/dev/`                                   | `architecture/layers-and-auth.md`, ADRs `0009` + `0010`, follow-ups as needed                                                                             |
| `docs/dev/tasklist.md`                        | Sub-phase rows 3.1–3.6                                                                                                                                    |

---

## 6. Tests

- **Unit:**
  - Seed is idempotent (run twice → same row counts).
  - Resolver returns expected set for: admin only, group-of-groups
    chain, soft-deleted group, soft-deleted layer, edge with
    `top_down` direction.
  - Cycle prevention on `layer_visibility_edges` insert.
  - Zod schemas reject invalid `type` / direction / unknown
    locale.
- **Integration:**
  - Bus subscribers wire end-to-end:
    `user.created` → personal layer created;
    `group.member_added` → resolver cache invalidates;
    `layer.deleted` → resolver excludes it.
  - Migration `0003` runs on a phase-2 data-dir without data
    loss.
- **HTTP:**
  - `GET /me/layers` returns the seeded triple for the admin.
  - `GET /layers/:slug` on a non-visible layer returns 404
    `errors.layer.notVisible` (no leak of slug existence).
  - `POST /layers` as any authenticated user creates a project
    layer and inserts the caller as `owner` in the same tx.
  - `POST /layers` rejects `type` ≠ `project`.
  - `PATCH /layers/:slug` is allowed for the owner, allowed for
    site-admin, forbidden (403) for a plain member.
  - `DELETE /layers/:slug` on a personal / group / everyone
    layer is rejected (400 `errors.layer.notDeletable`).
  - `POST /layers/:slug/visibility` rejects
    `direction !== 'bottom_up'` in v1.
  - Project-layer member add → second user's `GET /me/layers`
    now includes it.
- **Component (web):**
  - `LayerSwitcher` keyboard nav + selecting a layer calls
    `navigate('/l/<new>/<sameSubpath>')`; reloading the URL
    restores the same layer (no client state needed).
  - `MyLayersPage` row click navigates to `/l/:slug/dashboard`;
    new-layer dialog focus-trap.
  - `LayerSettingsPage` renders Members / Visibility / Locales /
    Attachments tabs read-only for a non-owner, editable for an
    owner.
  - `LayerDashboardPage` empty state copy + a11y of the
    `Configure widgets` link (disabled state when no edit
    rights).
- **i18n:** every new string flows through `t()`; `i18n:check`
  stays green; en + nl coverage matches the phase-2 ratio.
- **Smoke (e2e):** extend `apps/server/tests/smoke.test.ts`:
  1. Login as `user2` (not admin) and `POST /layers` to create a
     project layer — proves it's not admin-gated.
  2. `user2` adds `user3` as member.
  3. `GET /me/layers` as `user2` and `user3` both include the
     new layer; a fourth user does not.
  4. `GET /layers/:slug` as the fourth user → 404
     `errors.layer.notVisible`.
  5. `user2` soft-deletes the project layer (owner); both
     members no longer see it.
  6. Re-run seed on the same data-dir; no duplicate rows.

---

## 7. Docs Impact

New docs:

- `docs/dev/architecture/layers-and-auth.md`
- `docs/dev/decisions/0009-layer-model.md`
- `docs/dev/decisions/0010-layer-resolver-and-invalidation.md`
- `docs/user/guides/working-with-layers.md`

Updated docs:

- `docs/dev/architecture/overview.md` — layer band in the spine
  diagram and prose; add `c.var.effectiveLayers` to the request
  shape.
- `docs/dev/architecture/event-bus.md` — new `layer.*` event
  types.
- `docs/dev/architecture/auth-and-sessions.md` — note the
  resolver chained after `requireAuth`; cross-link to the new
  layers doc.
- `docs/dev/setup/running.md` — `/status.layers` block + the
  seeded `everyone` row.
- `docs/user/guides/getting-started.md` — layer switcher screenshot
  - "your personal layer".
- `docs/dev/tasklist.md` — rows 3.1–3.6.

---

## 8. i18n Impact

- New namespaces: `layer.switcher.*`, `layer.dashboard.*`,
  `admin.layers.list.*`, `admin.layers.detail.*`,
  `admin.layers.members.*`, `admin.layers.visibility.*`,
  `admin.layers.locales.*`, `admin.layers.attachments.*`,
  `errors.layer.*`.
- `en` is base + fallback. `nl` gets the switcher + dashboard
  empty-state + create-dialog keys translated as a showcase; the
  remaining new keys are warn-only — matches the phase-2 ratio.
- `i18n:check` continues unchanged.

---

## 9. Accessibility Impact

- `LayerSwitcher`: real `<button>` trigger, `aria-haspopup="menu"`,
  arrow-key navigation, focus restored on close. Current layer is
  also announced via an `aria-current="true"` on the active row.
- Layer admin pages: semantic `<table>`, sortable headers with
  `aria-sort`, row actions as real `<button>`, dialog focus trap
  (shadcn covers it).
- Dashboard empty state: heading + descriptive text; the
  "configure widgets" link is a real `<a>` (router-link), not a
  div.
- axe-core stays green on every new page; smoke runs the same
  audit it does today on the new pages.
- Visible focus rings everywhere.

---

## 10. Risks

| Risk                                                            | Likelihood | Impact | Mitigation                                                                                                                                                                 |
| --------------------------------------------------------------- | ---------- | -----: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Effective-layer resolver becomes a hot path / N+1 query         | Med        |    Med | LRU cache per `userId`; one recursive CTE per miss; benchmarked at end of 3.2; documented in ADR `0010`                                                                    |
| Stale cache after a missed bus event                            | Med        |   High | TTL bound (e.g. 5 min); broad invalidation on `layer.*`; subscriber test asserts invalidation; documented in ADR `0010`                                                    |
| Cycle in `layer_visibility_edges`                               | Low        |    Med | Reject at insert via recursive-CTE walk before insert; tests cover diamond + self-edge                                                                                     |
| Soft-deleted layer still serves entities in phase 4             | Med        |   High | Resolver filters `deleted_at IS NULL`; tests assert exclusion; cross-linked in `layers-and-auth.md`                                                                        |
| Slug in URL leaks layer existence                               | Low        |    Med | `GET /layers/:slug` returns 404 (not 403) on a non-visible slug, so a non-member cannot probe — same shape as GitHub on a private repo                                     |
| Layer-slug rename breaks bookmarks / Electron reopen            | Low        |    Med | Rename is out of v1 scope; once added, keep a slug-history table and 301-redirect from old slugs. Tracked in `docs/dev/follow-ups/layer-rename.md` at close-out            |
| Any-user-can-create-project-layer floods the layer list         | Low        |    Low | List is per-user-visibility-filtered by the resolver; the switcher groups by type so a long project list stays scannable. Quota / soft cap is a follow-up if it ever bites |
| LanceDB filter coupling slips back into phase 6 unaware         | Low        |    Med | ADR `0010` explicitly lists "phase 6 LanceDB consumer" as the resolver's first downstream user; phase 6 plan will cross-link                                               |
| Personal-layer collision when a username has special characters | Low        |    Low | Slug derived from `users.id` (UUID-suffix) fallback, not the raw username; documented in the seed code; tested with a username containing dots / dashes                    |
| Migration risk on existing phase-2 data                         | Low        |    Med | `0003_layers.sql` is purely additive; seed runs after migrate; tested by running phase-2 smoke first, then phase-3 smoke against the same data-dir                         |

---

## 11. Open Questions (phase 3)

1. **Default visibility direction.** `bottom_up` matches the
   `overall.md` §5.4 wording ("a layer sees everything above
   it"). Confirmed default in 3.1; ADR `0009` records it. Other
   directions are still configurable per edge.
2. **Where does the current-layer choice live?**
   In the URL path (`/l/:slug/...`). Bookmarks, browser history,
   and Electron "reopen where you left off" work for free. No
   cookie, no header. Decided in 3.3, ADR `0010` records it.
3. **Project-layer create — who can?**
   Any authenticated user. The creator becomes the layer's
   `owner` member in the same transaction. Site-admin can edit
   any layer in addition to its owners.
4. **Personal layer rename / delete.**
   Not exposed in v1 UI. Seeded slug is stable; rename is a
   follow-up.
5. **Locale subset enforcement.**
   `POST /layers/:slug/locales` validates against the system
   locale list (config). The enforcement at write time for
   per-layer entities lives in phase 4.
6. **Visibility direction v1.**
   Only `bottom_up` is accepted by the API in v1 — adding a
   `top_down` or `both` edge would grant the parent layer extra
   read rights, which needs a "parent owner accepts" handshake
   we're not building yet. The schema keeps the column so phase
   4+ can lift the restriction without a migration.
7. **Attachment registry shape.**
   `config_json` is opaque TEXT in v1 — the schema is enforced
   per `kind` only when a consumer reads it (phase 7). The
   registration HTTP route still requires a valid `kind` and a
   non-empty `refId`.

---

## 12. Definition of Done (phase 3)

Per `AGENTS.md` §Done Means Done, plus phase-specific:

- All sub-phase tasklist rows 3.1–3.6 are `done`.
- On a fresh `bun run dev:server` (no `.data`):
  - The phase-2 admin-seed message still prints.
  - The layer seed runs, creating `everyone`, `personal-admin`,
    `group-admin`; this is observable via `GET /status.layers`.
- Visiting `/` redirects to `/l/personal-<username>/dashboard`.
  Visiting `/l/:slug/...` with a slug not in
  `effectiveLayers` redirects to the personal layer with a toast.
  `GET /layers/:slug` returns 404 `errors.layer.notVisible` for
  a non-visible slug (no admin-channel difference).
- Any authenticated user (not just admin) can create a project
  layer, add a second user, and the second user's
  `GET /me/layers` includes it. A third user does not see it.
- Switching the layer in the URL changes the page's scope; the
  back/forward buttons restore the previous layer; copying the
  URL into another tab (or reopening Electron) lands on the
  same layer.
- Layer switcher is reachable by keyboard and announces the
  current layer to a screen reader (axe-core scan stays green).
- Extended smoke test covers the §6 e2e steps.
- All CI matrix checks green on macOS, Linux (Windows stays
  `continue-on-error` until
  `docs/dev/follow-ups/windows-bun-sqlite-ebusy.md` lands).
- ADRs `0009` and `0010` exist (status `accepted`,
  date `2026-…`).
- `overall.md` §8 phase-3 status flipped to the appropriate state
  at close-out; this plan moves to `docs/dev/plans/done/`.

---

## 13. Concrete Next Step

Add sub-phase rows 3.1–3.6 to `docs/dev/tasklist.md` as `open`,
then start sub-phase **3.1 — Schema + repos**. Land 3.1 behind
its own commit and run the phase-2 smoke once to prove the
migration is additive on top of an existing data-dir.

---

## 14. Phase 3 close-out (authored 2026-05-23 at the end of 3.6)

Walkthrough of §12 Definition of Done. Tracked here so a reader does
not have to chase the tasklist + git history to know what is done
and what is gated. Mirrors the close-out shape of
[`phase-02-users-and-groups.md`](./phase-02-users-and-groups.md)
§14.

| §12 line                                                                                                                                                                                                  | State   | Evidence / notes                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| All sub-phase tasklist rows 3.1–3.6 are `done`                                                                                                                                                            | done    | 3.1–3.5 flipped at the end of each sub-phase; 3.6 flips at the end of this commit. The plan-detail row also flips to `done` once §14 lands.                                                                                                                                                                                                                                                                |
| On a fresh `bun run dev:server`, the phase-2 admin-seed message still prints AND the layer seed creates `everyone`, `personal-admin`, `group-admin` — observable via `GET /status.layers`                 | done    | `apps/server/src/auth/seed.ts` is unchanged; `apps/server/src/layers/seed.ts` is idempotent and reads `kv_meta` for the seed marker. The smoke test asserts `status.layers.total === 3` and `byType.{everyone,personal,group} === 1`. Phase string bumped to `'3.6'` so the `GET /status` shape is unambiguous about the current cut.                                                                      |
| Visiting `/` redirects to `/l/personal-<username>/dashboard`. Non-visible slug redirects to personal layer with a toast. `GET /layers/:slug` returns 404 `errors.layer.notVisible` for a non-visible slug | done    | Router-side redirect lives in `apps/web/src/App.tsx`; the slug-fallback toast is in `apps/web/src/lib/use-current-layer.ts`. Server-side covered by `apps/server/tests/require-layer.test.ts` and the new smoke step 4 (`user4` GETs `/layers/smoke-project` → 404). No admin-channel difference: `requireLayer` returns the same 404 for member-without-edit-rights vs unknown-slug.                      |
| Any authenticated user (not just admin) can create a project layer, add a second user, and the second user's `GET /me/layers` includes it. A third user does not see it                                   | done    | Smoke step 7b is fully refactored to do this with non-admin actors — `user2` (not admin) creates `smoke-project`, adds `user3`, both see it in `/me/layers`, `user4` does not. Server-side cover is also `apps/server/tests/http-layers-crud.test.ts` + `http-layers-members.test.ts` + `http-me-layers.test.ts`.                                                                                          |
| Switching the layer in the URL changes the page's scope; back/forward + copy-paste + Electron reopen restore the layer                                                                                    | partial | Server-side contract is provably done: every layer-scoped route reads `:slug` from the URL only (no header, no cookie); ADR `0010` records the rationale; smoke proves the round-trip. UI-side click-through verification is a manual smoke against `bun run dev:web` until DOM tests land — tracked in `docs/dev/follow-ups/web-component-tests.md`.                                                      |
| Layer switcher reachable by keyboard, announces current layer to screen reader, axe-core scan stays green                                                                                                 | partial | `LayerSwitcher` ships with semantic `<button>` + `aria-haspopup="menu"` + `aria-current="true"` on the active row (see `apps/web/src/components/`). The axe-core scan run is gated on the same `web-component-tests.md` follow-up — phase-2 close-out tracked the same gap.                                                                                                                                |
| Extended smoke test covers the §6 e2e steps                                                                                                                                                               | done    | `apps/server/tests/smoke.test.ts` 7b is the full §6 round-trip: create-as-non-admin (step 1), add-member (step 2), `/me/layers` visibility split across `user2`/`user3`/`user4` (step 3), 404 on `/layers/:slug` for `user4` (step 4), owner soft-delete + members lose access (step 5), re-run seed → row counts unchanged (step 6). Step 4b also covers the new 404-visibility-leak fix (see §14 below). |
| All CI matrix checks green on macOS, Linux (Windows continues `continue-on-error` until `docs/dev/follow-ups/windows-bun-sqlite-ebusy.md` lands)                                                          | gated   | `.github/workflows/ci.yml` runs `format:check + lint + typecheck + test + build + docs:check + i18n:check` on all three OSes; the Windows leg is `continue-on-error: true` per the deferred follow-up. This commit has not been pushed yet — the matrix runs when the user pushes. Phase-1 + phase-2 close-outs used the same `gated` wording.                                                             |
| ADRs `0009` and `0010` exist (status `accepted`, date `2026-…`)                                                                                                                                           | done    | [`docs/dev/decisions/0009-layer-model.md`](../../decisions/0009-layer-model.md) (status: accepted, dated 2026-05-23) and [`docs/dev/decisions/0010-layer-resolver-and-invalidation.md`](../../decisions/0010-layer-resolver-and-invalidation.md) (status: accepted, dated 2026-05-23) — both follow the house ADR shape (Context, Decision, Consequences, Alternatives, Status).                           |
| `overall.md` §8 phase-3 status flipped to the appropriate state at close-out; this plan moves to `docs/dev/plans/done/`                                                                                   | done    | `overall.md` §8 phase-3 status flipped to `done` in this commit; the plan moves from `docs/dev/plans/` to `docs/dev/plans/done/` as the last step of 3.6. Every reference to `docs/dev/plans/phase-03-layers.md` is rewritten to `docs/dev/plans/done/phase-03-layers.md` in the same commit.                                                                                                              |

### Release-matrix verification

`bun install && bun run format:check && bun run lint && bun run typecheck && bun test && bun run i18n:check && bun run docs:check && bun run build`
all green on the macOS host at close-out. The Linux + Windows legs
are **gated** on the user pushing this commit — `.github/workflows/ci.yml`
runs the same recipe on all three OSes; flip the gated row above to
`done` once the matrix lands green. Windows stays
`continue-on-error: true` until
`docs/dev/follow-ups/windows-bun-sqlite-ebusy.md` lands.

### Test count at close-out

`bun test` reports **338 pass / 0 fail / 980 expect() calls** across
57 files. The single smoke run
(`bun test apps/server/tests/smoke.test.ts`) reports
**1 pass / 0 fail / 89 expect() calls** with the extended phase-3
invariants asserted (see the file-level docstring + the 7b
walkthrough).

### Final answer — 404 vs 403 visibility, and what we did about it

The 3.4 sub-agent flagged the `POST /layers/:slug/visibility` route
as the lone exception to the ADR `0010` "non-visible = 404, no leak"
rule:

- `parent === null` returned `400 errors.layer.visibilityParentNotFound`.
- `!effective.some(l => l.id === parent.id)` returned
  `400 errors.layer.visibilityParentNotVisible`.

Two different keys at the same 400 status is exactly the
slug-existence probe the policy is supposed to close: a caller could
read the error code to distinguish "this slug exists somewhere I
can't see" from "this slug doesn't exist". **Decision: fix it in this
commit** rather than leave it as a documented exception. The clean
fix is small, fully testable, and brings the route into line with
the rest of the layer surface.

What landed:

- `apps/server/src/http/routes/layers.ts` collapses both branches
  (and the soft-delete branch) into a single
  `404 errors.layer.visibilityParentNotFound` response. The 400 →
  404 status bump signals "this is a not-found shape, treat it the
  same as a missing slug." Comment cites ADR `0010` and this §14.
- `apps/server/tests/http-layers-visibility.test.ts` updates the
  "not-visible" test to assert the new 404 status + key, and adds a
  byte-identical assertion against a known-missing slug so the leak
  channel is provably closed.
- `apps/server/tests/smoke.test.ts` step 4b asserts the same:
  `user4` tries to attach its own layer to (a) `smoke-project`
  (exists, hidden) vs (b) `does-not-exist` (missing). Both return
  the same 404 body — `toEqual` proves byte-identical.
- `apps/web/src/i18n/locales/en.json` removes the now-dead
  `errors.layer.visibilityParentNotVisible` key.
- ADR `0010` records the decision in §"404, not 403, on a
  non-visible layer".

The `canEditLayer`-driven 403 on edit attempts stays — once the
caller is in the layer's effective set, the system can be honest
about authorization. Only the existence-probe branch needed
collapsing.

### Follow-ups created / referenced during phase 3

Created during 3.6 from 3.5-discovered UI gaps (all `open`,
all cross-linked from §0 of `layers-and-auth.md`):

- [`docs/dev/follow-ups/layer-members-picker.md`](../../follow-ups/layer-members-picker.md)
  — Members tab needs a non-admin user/group picker (no
  `GET /me/group-members`-style endpoint today). Server write side
  is fully covered by `apps/server/tests/http-layers-members.test.ts`.
- [`docs/dev/follow-ups/layer-visibility-list.md`](../../follow-ups/layer-visibility-list.md)
  — `GET /layers/:slug/visibility` to list current edges. Add /
  remove edge routes are live; the list endpoint is the missing
  read side.
- [`docs/dev/follow-ups/layer-attachments-on-get.md`](../../follow-ups/layer-attachments-on-get.md)
  — `GET /layers/:slug` (or a sibling
  `GET /layers/:slug/attachments`) should return attachments. The
  register / remove routes already work; the list-on-load is the
  missing read side.

Inherited from 3.4 (still `open`):

- [`docs/dev/follow-ups/group-layer-admin-role.md`](../../follow-ups/group-layer-admin-role.md)
  — per-group admin role for group-layer edits. `canEditLayer` v1
  falls back to "site-admin only" for group layers; the follow-up
  captures the design options.

Inherited from earlier phases and still relevant:

- `docs/dev/follow-ups/web-component-tests.md` — DOM-runtime
  component tests for the new layer pages. The two `partial` DoD
  rows above (URL→scope manual verification, axe-core scan) cite
  this follow-up.
- `docs/dev/follow-ups/windows-bun-sqlite-ebusy.md` — Windows CI
  leg stays `continue-on-error: true` until this lands.

No phase-3 follow-up moved to `done/` at close-out: every active
follow-up either pre-dates phase 3 (windows / desktop / packaging /
web-component-tests) or is one of the four above.

### Phase-3 surface map

For the at-a-glance route + middleware inventory of every endpoint
introduced in phase 3, see
[`layers-and-auth.md`](../../architecture/layers-and-auth.md) §0
("Phase 3 surface map"). The map covers public / authenticated /
layer-scoped, the `requireLayer` 404 policy, and the middleware
chain order including where `withEffectiveLayers` slots in.

### What flips after this commit lands

- Tasklist row 3.6 → `done`.
- This plan moves from `docs/dev/plans/` to
  `docs/dev/plans/done/` (every 3.x sub-phase row is `done`).
- Every doc that referenced `docs/dev/plans/phase-03-layers.md`
  is updated to point at the `done/` path. The tasklist rows
  3.1–3.6's `Related document` column is rewritten in the same
  commit (`bun run docs:check` would fail loudly otherwise).
- `overall.md` §8 phase-3 status flips from "open" to "done" with
  a close-out date pointer to this §14.
- The `phase` string in `apps/server/src/index.ts` and the test
  fixtures bumps from `'2.7'` to `'3.6'` so `GET /status` is
  unambiguous about the current cut. Mirrors the same bump phase-2
  close-out did at 2.7.
