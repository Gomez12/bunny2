# Layers and per-layer authorization

> Status: living document.
> Owners: phase-3 introduced this; phase-3.6 close-out wrote it up.
> Source code: `apps/server/src/layers/`,
> `apps/server/src/http/routes/layers.ts`,
> `apps/server/src/http/routes/me-layers.ts`,
> `apps/server/src/http/routes/system-locales.ts`,
> `apps/server/src/http/middleware/layer.ts`,
> `apps/server/src/repos/layer-*-repo.ts`,
> `packages/shared/src/layer.ts`.

This is the single-page tour of bunny2's layer model — the scoping
unit every phase 4+ entity inherits. Companion to
[`auth-and-sessions.md`](./auth-and-sessions.md),
[`overview.md`](./overview.md), [`event-bus.md`](./event-bus.md), and
ADRs [`0009`](../decisions/0009-layer-model.md) /
[`0010`](../decisions/0010-layer-resolver-and-invalidation.md).

---

## 0. Phase 3 surface map (cheat sheet)

Every route + middleware introduced across phase 3, in one table.
Mirrors `auth-and-sessions.md §0`.

### Authenticated only (no admin gate, no layer gate)

| Method | Path              | Owner phase | Notes                                                               |
| ------ | ----------------- | ----------- | ------------------------------------------------------------------- |
| `GET`  | `/me/layers`      | 3.4         | Caller's `effectiveLayers`. Convenience alias for the switcher.     |
| `GET`  | `/layers`         | 3.4         | Same set + `type` / `search` / `includeDeleted` (admin-only) query. |
| `POST` | `/layers`         | 3.4         | Create a `project` layer; caller is inserted as `owner` in same tx. |
| `GET`  | `/system/locales` | 3.4         | System-configured locale list. Used by the locale tab.              |

### Layer-scoped (`requireLayer` → 404 `errors.layer.notVisible` on a non-member)

| Method   | Path                                   | Owner phase | Edit gate                                  |
| -------- | -------------------------------------- | ----------- | ------------------------------------------ |
| `GET`    | `/layers/:slug`                        | 3.4         | Visibility only (no `canEditLayer`)        |
| `PATCH`  | `/layers/:slug`                        | 3.4         | `canEditLayer`                             |
| `DELETE` | `/layers/:slug`                        | 3.4         | `canEditLayer` + type ≠ project rejected   |
| `POST`   | `/layers/:slug/members`                | 3.4         | `canEditLayer` (project only)              |
| `DELETE` | `/layers/:slug/members/:memberId`      | 3.4         | `canEditLayer` (project only)              |
| `POST`   | `/layers/:slug/visibility`             | 3.4         | `canEditLayer`; v1 direction = `bottom_up` |
| `DELETE` | `/layers/:slug/visibility/:parentSlug` | 3.4         | `canEditLayer`                             |
| `POST`   | `/layers/:slug/locales`                | 3.4         | `canEditLayer`                             |
| `POST`   | `/layers/:slug/attachments`            | 3.4         | `canEditLayer`                             |
| `DELETE` | `/layers/:slug/attachments/:id`        | 3.4         | `canEditLayer`                             |

### Middleware chain (request order)

```
CORS preflight short-circuit
  → createAuthMiddleware (2.2)        — session resolve (Bearer ∨ cookie)
    → requirePasswordCurrent (2.3)    — mustChangePassword gate
      → withEffectiveLayers (3.3)     — attaches c.var.effectiveLayers
        → requireAdmin (2.4, /admin/*) — transitive admin-group check
          → requireLayer (3.3, /layers/:slug, /l/:slug) — slug → c.var.layer or 404
            → route handler
```

`withEffectiveLayers` runs **once per authenticated request** and
fills `c.var.effectiveLayers: readonly Layer[]`. `requireLayer`
reads from that same array — there is no second resolver call per
request. Public routes (status, login, logout, CORS preflight) skip
the layer middleware because `c.var.user` is undefined there.

---

## 1. Model

Single `layers` table with `type IN ('personal','project','group','everyone')`.
ADR [`0009`](../decisions/0009-layer-model.md) records the rationale
for four types in one table. Summary:

| Type       | Created by | Owner column              | Edit authority (v1)                             |
| ---------- | ---------- | ------------------------- | ----------------------------------------------- |
| `personal` | seed       | `owner_user_id` NOT NULL  | owning user                                     |
| `project`  | user (any) | neither owner column      | `owner`-role `layer_user_members` or site-admin |
| `group`    | seed       | `owner_group_id` NOT NULL | site-admin only (see follow-up below)           |
| `everyone` | seed       | neither                   | site-admin only                                 |

Hierarchy: `layer_visibility_edges (parent_layer_id, child_layer_id,
direction)` with `direction IN ('top_down','bottom_up','both')`.
**Default and v1 API-accepted direction: `bottom_up`** — a child
layer sees its parent's entities (matches `overall.md` §5.4). The
schema keeps the column wide so phase 4+ can lift the v1
"only `bottom_up`" restriction without a migration.

Schema details: `apps/server/src/storage/migrations/0003_layers.sql`.

### Personal-layer slug stability

Default: `personal-<username>`. Fallback (when the username does
not fit the slug grammar): `personal-<userId>` (UUID-suffix). The
seed code in `apps/server/src/layers/seed.ts` is the single
authority on the rule, with a test that covers a username
containing dots / dashes / mixed case.

---

## 2. Resolver + cache

`apps/server/src/layers/resolver.ts` exports `LayerResolver`:

```ts
export interface LayerResolver {
  effectiveLayers(userId: string): Promise<readonly Layer[]>;
  invalidate(userId?: string): void;
}
```

Contract: returns a deduped, sorted, frozen array of `Layer` rows
visible to `userId`. The walk follows the union of:

1. Personal layer for `userId`.
2. Group layers for every group `userId` is transitively in (via
   the phase-2 `GroupResolver` — same CTE the admin gate uses).
3. The `everyone` layer.
4. Every project layer where `userId` (or a transitive group) is a
   direct member.
5. Followed by `layer_visibility_edges` in the configured direction.

Soft-deleted layers (`deleted_at IS NOT NULL`) are filtered before
the walk — the resolver is the source of truth for "may this user
see this layer right now?".

### Cache

In-process LRU keyed on `userId`, defaulting to **5000 entries** and
a **5-minute TTL**. The cap defends against a hostile probe stream
(matches the phase-2 `GroupResolver` cache shape); the TTL is a
backstop against a missed bus invalidation.

### Invalidation triggers (explicit subscriber list)

`apps/server/src/layers/subscribers.ts` registers handlers on:

| Event                                  | Invalidation scope                                |
| -------------------------------------- | ------------------------------------------------- |
| `layer.*` (10 types, see §6)           | broad (`invalidate()`) — layers change rarely     |
| `user.created`                         | broad after seeding the personal layer            |
| `user.deleted`                         | targeted (`invalidate(userId)`)                   |
| `group.member_added` (`kind: 'user'`)  | targeted (`invalidate(affectedUserId)`)           |
| `group.member_added` (`kind: 'group'`) | targeted per user under the affected child branch |
| `group.member_removed`                 | same                                              |

Plus inline invalidation in every mutating route: a `POST /layers`
call invalidates the caller's entry before returning so the very next
handler in the same process sees the new layer without depending on
subscriber ordering.

ADR [`0010`](../decisions/0010-layer-resolver-and-invalidation.md)
records the trade-off (broad-vs-targeted, TTL bound, future LanceDB
consumer).

---

## 3. Request-scoped enrichment

`apps/server/src/http/middleware/layer.ts` exports two pieces:

### `withEffectiveLayers({ resolver })`

Chained after `requireAuth` and `requirePasswordCurrent`. Calls
`resolver.effectiveLayers(user.id)` exactly once per authenticated
request and attaches the frozen result as
`c.var.effectiveLayers`. On resolver failure, the response is
`500 errors.server.unavailable` — internals never leak.

Public routes (status, login, logout, OPTIONS) skip this middleware
because `c.var.user` is undefined; handlers on public routes must
NOT read `c.var.effectiveLayers`.

### `createRequireLayer()`

Per-route middleware mounted on every `/layers/:slug/...` route.

1. Reads `:slug` from the URL.
2. Looks it up in `c.var.effectiveLayers`.
3. On hit: attaches `c.var.layer: Layer` for the handler.
4. On miss (unknown slug OR exists-but-not-visible):
   **`404 errors.layer.notVisible`** — byte-identical, so a
   non-member cannot probe slug existence.

The contract is `layer scope = URL slug`. No header, no cookie.

---

## 4. Per-layer authorization (the §4.4 table)

No admin-only gate on `/layers/*`. Authorization is computed per
route from the caller's relationship to the layer, via
`apps/server/src/layers/authz.ts` `canEditLayer(user, layer, …)`:

| Route                                          | Allowed for                                                                                                                                                        |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /me/layers`, `GET /layers`                | any authenticated user (returns `effectiveLayers`)                                                                                                                 |
| `GET /layers/:slug`                            | any authenticated user **iff** the slug is in `effectiveLayers` (else 404 `errors.layer.notVisible`)                                                               |
| `POST /layers` (create project layer)          | any authenticated user; caller is inserted into `layer_user_members` with `role = 'owner'` in the same transaction                                                 |
| `PATCH /layers/:slug` / `DELETE /layers/:slug` | personal: owning user only • project: any `owner` member or site-admin • group: **site-admin only** (v1 fallback, see follow-up below) • everyone: site-admin only |
| `POST/DELETE /layers/:slug/members`            | project layers only; `owner` members or site-admin                                                                                                                 |
| `POST/DELETE /layers/:slug/visibility`         | same as `PATCH /layers/:slug`; v1 rejects any `direction` other than `'bottom_up'` (§11.6)                                                                         |
| `POST /layers/:slug/locales`                   | same as `PATCH /layers/:slug`                                                                                                                                      |
| `POST/DELETE /layers/:slug/attachments`        | same as `PATCH /layers/:slug`                                                                                                                                      |
| `GET /system/locales`                          | any authenticated user                                                                                                                                             |

"Site-admin" = transitive membership of the seeded `admin` group
from phase 2.4 — same `GroupResolver.isUserInGroup` call the admin
gate uses.

### 4.1 Group-layer edit follow-up

`canEditLayer` currently returns `false` for non-site-admins on
group layers. The phase-3 plan §4.4 originally listed "any admin of
the owning group OR site-admin", but phase 2's group model does not
have a per-group admin role — see
[`docs/dev/follow-ups/group-layer-admin-role.md`](../follow-ups/group-layer-admin-role.md)
for the design options (per-group `role` column vs `<group>-admin`
subgroup convention).

---

## 5. URL strategy

Every layer-scoped page nests under `/l/:slug/...`. Rationale:

1. **Bookmarks survive.** A user can bookmark
   `/l/bunny2/dashboard` and reopen it tomorrow.
2. **Browser history works for free.** Back / forward restore the
   previous layer without any client state machine.
3. **Electron "reopen where you left off" is free.** The window
   reopens at the last URL; the same slug routes to the same scope.
4. **Copy-paste is unambiguous.** A link in chat or email lands on
   the same layer for the recipient — assuming they have access; if
   not, they get the same 404 a non-member would, no leak.

Trade-off: every layer-scoped UI route pays a `/l/:slug/` prefix in
its path. ADR [`0010`](../decisions/0010-layer-resolver-and-invalidation.md)
walks through the rejected alternatives (header, cookie).

The `LayerSwitcher` component in `apps/web/src/components/`
preserves the sub-path on switch:
`/l/personal-admin/dashboard` → `/l/bunny2/dashboard`. A slug that
falls out of the user's `effectiveLayers` mid-session (e.g. after
a soft delete elsewhere) falls back to the personal layer with a
toast (handled by the `/l/:slug/*` route layout).

---

## 6. Events

`apps/server/src/layers/events.ts` declares the contracts:

| Type                          | Producer                                                            | Payload (shape)                                                       |
| ----------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `layer.created`               | seed; `POST /layers`; `user.created` / `group.created` subscriber   | `{ layerId, type, slug, name, ownerUserId?, ownerGroupId?, seeded? }` |
| `layer.updated`               | `PATCH /layers/:slug`                                               | `{ layerId, slug }`                                                   |
| `layer.deleted`               | `DELETE /layers/:slug`; `user.deleted` / `group.deleted` subscriber | `{ layerId, slug, type, ownerUserId?, ownerGroupId? }`                |
| `layer.visibility.added`      | seed; `POST /layers/:slug/visibility`                               | `{ parentLayerId, childLayerId, direction, seeded? }`                 |
| `layer.visibility.removed`    | `DELETE /layers/:slug/visibility/:parentSlug`                       | `{ parentLayerId, childLayerId }`                                     |
| `layer.member.added`          | `POST /layers/:slug/members`; `POST /layers` (owner)                | `{ layerId, kind: 'user' \| 'group', role, userId? \| groupId? }`     |
| `layer.member.removed`        | `DELETE /layers/:slug/members/:memberId`                            | `{ layerId, kind, userId? \| groupId? }`                              |
| `layer.locale.set`            | `POST /layers/:slug/locales`                                        | `{ layerId, locales[], defaultLocale }`                               |
| `layer.attachment.registered` | `POST /layers/:slug/attachments`                                    | `{ layerId, attachmentId, kind, refId, configPreview }`               |
| `layer.attachment.removed`    | `DELETE /layers/:slug/attachments/:id`                              | `{ layerId, attachmentId, kind, refId }`                              |

The `ALL_LAYER_EVENT_TYPES` constant in `events.ts` keeps the list
machine-checkable. Subscribers register against this array, so a new
event type cannot land without a subscriber decision.

Cross-event narrative: every layer mutation emits **one** primary
event (e.g. `layer.created`). When a mutation has secondary effects
(creating a layer adds the caller as owner — `layer.member.added` —
and an `everyone` edge — `layer.visibility.added`), each effect emits
its own event in the same `correlationId`. Subscribers should look at
the primary event for "what happened"; the secondary events are
there so a future projection rebuilt from the log alone can recreate
the full graph without re-running the write-time logic.

---

## 7. What phase 4+ inherits

Phase 4 (Companies, Contacts, Calendar, Todos) is **born inside a
layer**. Every entity table gets a `layer_id TEXT NOT NULL REFERENCES
layers(id)` column and every entity-read route inherits the same
contract:

1. Resolve `layer` from `:slug` via `requireLayer` (or, for non-URL
   reads such as a cross-layer search, ask the resolver directly).
2. Filter rows by `layer_id IN (…effectiveLayers ids…)`.
3. Soft-delete filter is free — the resolver excludes
   `deleted_at IS NOT NULL` already.

The phase-6 LanceDB pre-retrieval auth filter (`overall.md` §5.8)
is the next-step downstream consumer: the chat retrieval pipeline
calls `layerResolver.effectiveLayers(userId)` once, passes the
layer-id set as the LanceDB pre-search filter, and **only then**
runs the vector search. This is the invariant `overall.md` §3 calls
out ("LanceDB never surfaces content a user is not authorized to
see") — phase 3 ships the resolver that makes it cheap.

### Phase 4 entity-row checklist

Each entity-CRUD sub-phase MUST:

- Add `layer_id` to the entity schema with a NOT NULL FK.
- Wire the `requireLayer` middleware on the entity routes.
- Use `c.var.effectiveLayers` for cross-layer list/search.
- Emit `entity.created { layerId, … }` etc. so a future per-layer
  projection / dashboard widget can join on `layer_id`.
- Cross-link this doc in the entity-specific architecture write-up
  so the layer contract stays visible.

---

## 8. Related docs

- `docs/dev/architecture/overview.md` — spine diagram including the
  layer band.
- `docs/dev/architecture/auth-and-sessions.md` — phase-2 auth
  surface; §0 shows where `withEffectiveLayers` slots into the
  middleware chain.
- `docs/dev/architecture/event-bus.md` — `layer.*` event types in
  the registry.
- `docs/dev/decisions/0009-layer-model.md` — layer types +
  hierarchy + slug stability.
- `docs/dev/decisions/0010-layer-resolver-and-invalidation.md` —
  resolver contract, cache, invalidation, URL-as-current-layer.
- `docs/user/guides/working-with-layers.md` — end-user-facing
  walkthrough.
- `docs/dev/plans/done/phase-03-layers.md` — the phase plan and
  the §14 close-out walkthrough.
- `docs/dev/follow-ups/group-layer-admin-role.md` — the per-group
  admin gap that the v1 fallback covers.
- `docs/dev/follow-ups/layer-members-picker.md` /
  `layer-visibility-list.md` / `layer-attachments-on-get.md` — the
  three 3.5-discovered UI / API gaps deferred from phase 3.
