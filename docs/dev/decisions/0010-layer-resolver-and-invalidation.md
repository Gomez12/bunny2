# ADR 0010 — Layer resolver + invalidation strategy

- Status: accepted
- Date: 2026-05-23
- Phase: 3 (resolver lands in 3.2; URL-vs-header decision in 3.3;
  written up at 3.6 close-out)
- Related: `docs/dev/plans/done/phase-03-layers.md` §4.3, §4.5,
  §11.2; `apps/server/src/layers/resolver.ts`;
  `apps/server/src/layers/subscribers.ts`;
  `apps/server/src/http/middleware/layer.ts`;
  ADR `0009` (layer model); `auth-and-sessions.md` §0 (middleware
  chain).

---

## Context

ADR `0009` pins the layer model. This ADR pins the runtime question:
given that layer membership is graph-walked, how does the request
path answer "which layers may this user see right now?" cheaply,
and where does the "current layer" live for a request?

Three sub-decisions in one ADR because they fall together:

1. **Resolver contract** — what does a phase 4+ entity reader call
   to filter rows by layer access?
2. **Cache + invalidation** — how do we keep the answer fast without
   serving a stale graph after a membership / visibility flip?
3. **URL vs header vs cookie** — where does "the current layer"
   travel on a request?

---

## Decision

### Resolver contract

```ts
// apps/server/src/layers/resolver.ts
export interface LayerResolver {
  effectiveLayers(userId: string): Promise<readonly Layer[]>;
  invalidate(userId?: string): void;
}
```

`effectiveLayers(userId)` returns a deduped, sorted, frozen array of
the `Layer` rows the user can see, walking:

1. The user's personal layer (`personal-<…>`).
2. Every group layer for a group the user is in transitively (via
   the phase-2 `GroupResolver` — same recursive-CTE expansion the
   admin gate already uses).
3. The `everyone` layer.
4. Every project layer where the user is a direct
   `layer_user_members` row, or where one of the user's transitive
   groups is a direct `layer_group_members` row.
5. Followed by `layer_visibility_edges` per `direction`:
   - `bottom_up` — child→parent edge ADDS the parent when the
     child is reachable.
   - `top_down` — child→parent edge ADDS the child when the parent
     is reachable.
   - `both` — both directions count.

Soft-deleted layers (`deleted_at IS NOT NULL`) are filtered before
the walk — the resolver is the authoritative answer to
"may this user see this layer right now?", and **every phase 4+
entity read inherits this filter for free**. The phase 6 LanceDB
filter is the headline downstream consumer (§overall plan §5.8).

`invalidate(userId)` drops one cached entry; `invalidate()` drops
every entry. The shape mirrors the phase-2 `GroupResolver` cache so
test fixtures and call sites stay symmetric.

### Cache + invalidation

In-process LRU keyed on `userId`, defaulting to 5000 entries and a
**5-minute TTL**. The cap defends against a hostile request stream;
the TTL is a backstop — even if every subscriber slept, a stale
entry expires within 5 minutes.

Three invalidation signals stack:

| Signal                                                                         | Scope             | Why                                                          |
| ------------------------------------------------------------------------------ | ----------------- | ------------------------------------------------------------ |
| Inline `invalidate(callerId)` in the mutating route                            | one user          | The same handler can read its own write in the next request. |
| Bus subscriber on `layer.*`                                                    | broad (all)       | Layer / visibility / membership change can move many users.  |
| Bus subscriber on `user.created`, `user.deleted`, `group.member_added/removed` | targeted or broad | A user join/leave moves exactly that user (or branch).       |

The subscriber list is **explicit**, not wildcard:
`layer.created`, `layer.updated`, `layer.deleted`,
`layer.visibility.added`, `layer.visibility.removed`,
`layer.member.added`, `layer.member.removed`, `layer.locale.set`,
`layer.attachment.registered`, `layer.attachment.removed`,
`user.created`, `user.deleted`, `group.member_added`,
`group.member_removed`. Every subscription lives in
`apps/server/src/layers/subscribers.ts`; the `ALL_LAYER_EVENT_TYPES`
constant in `events.ts` keeps the list machine-checkable.

Broad invalidation on every layer mutation is intentionally coarse:
layers change rarely, and the alternative (compute which users were
affected) would re-walk the same graph the resolver is caching.

### URL strategy — current layer travels in the path

The "current layer" for a request is the **`:slug` URL segment** on
any layer-scoped route (`/l/:slug/dashboard`,
`/layers/:slug/settings`, etc.). Phase 3.3 decided this
explicitly:

- No header (`X-Bunny2-Layer: …`) — would break server-rendered
  links and copy-paste URLs.
- No cookie — would silently change the page's scope on a different
  tab.
- The URL **is** the contract. Bookmarks, browser history, and the
  Electron "reopen where you left off" feature all work for free.

The per-request middleware `withEffectiveLayers` enriches every
authenticated request with `c.var.effectiveLayers: readonly Layer[]`
(see `apps/server/src/http/middleware/layer.ts`). The per-route
`requireLayer` helper reads `c.req.param('slug')`, looks it up in
that array, and either attaches `c.var.layer` for the handler or
returns `404 errors.layer.notVisible` on a miss.

### 404, not 403, on a non-visible layer

`requireLayer` returns `404 errors.layer.notVisible` (not 403) when
the slug is unknown OR exists-but-not-in-`effectiveLayers`. The two
responses are byte-identical so a non-member cannot probe slug
existence — same shape as GitHub on a private repo.

The same rule extends to the `POST /layers/:slug/visibility`
parent-not-visible branch — the 3.4-discovered asymmetry there
(separate `errors.layer.visibilityParentNotFound` vs
`errors.layer.visibilityParentNotVisible` keys) is collapsed into a
single 404 response in 3.6. See the 3.6 close-out walkthrough.

### A member without edit rights gets 403, not 404

The asymmetry is deliberate. Once the caller is in the layer's
effective set (the slug is no longer probeable), the system can be
honest about authorization: "you're a member, but only owners can
edit this." Hiding edit failures behind 404 would confuse legitimate
members.

---

## Consequences

**Positive**

- One cache hit per request, one CTE per cache miss. The resolver
  is on the auth path and stays cheap.
- Soft-delete propagation is free — `deleted_at` filter sits in the
  same SELECT that builds the cache entry. Phase 4+ entity reads
  cannot accidentally surface a soft-deleted layer's content.
- The "current layer is the URL slug" contract removes a whole
  class of "wrong layer" bugs (a stale cookie, a missing header,
  two tabs disagreeing about scope).
- Phase 6 LanceDB pre-retrieval filter has exactly one upstream:
  it asks the resolver, gets back layer ids, and uses them as the
  pre-search auth tag. The phase-6 plan will cross-link this ADR.

**Negative / accepted**

- Broad invalidation on `layer.*` is cheap-when-rare-but-not-free
  at scale. Acceptable for an internal single-process tool;
  re-evaluate when we have a fleet.
- The 5-minute TTL means a missed invalidation can serve stale
  answers for up to 5 minutes. Bounded; the alternative is "stale
  forever".
- The URL-as-current-layer rule means every layer-scoped UI route
  pays a `/l/:slug/` prefix in its path. Worth it for the
  bookmark / history / copy-paste behaviour.

---

## Alternatives considered

1. **No cache** — recompute on every request. Rejected on
   per-request latency: the recursive CTE plus an outer join over
   `layer_visibility_edges` is fine occasionally but not on every
   page render in a long-lived session.
2. **Per-`(userId, layerId)` cache** — finer-grained, but the
   resolver also serves the "list all my layers" call for the
   switcher, which would have to enumerate the whole layer table.
   Rejected: the per-user set is the natural unit.
3. **Header (`X-Bunny2-Layer: …`)** — server-rendered HTML or a
   third-party link would not carry it. Rejected.
4. **Cookie** — a second open tab changes the first tab's scope
   silently. Rejected as a UX footgun.
5. **403 on a non-visible slug** — leaks slug existence. Rejected.
6. **Wildcard subscription (`'*'`)** — would invalidate on every
   single bus event, including unrelated chat / LLM / session
   events. The explicit list keeps the resolver's invalidation
   surface auditable and grep-able.

---

## Follow-ups

- Phase 6 LanceDB pre-retrieval filter is the resolver's first
  downstream user beyond the request path; the phase-6 plan will
  cross-link this ADR explicitly so the dependency does not get
  lost.
- `docs/dev/follow-ups/group-layer-admin-role.md` — the per-group
  admin role question is gated by `canEditLayer`, not the resolver
  itself. ADR `0009` references the same follow-up.
- The three 3.5-discovered surface gaps
  (`layer-members-picker.md`, `layer-visibility-list.md`,
  `layer-attachments-on-get.md`) are read-side issues that ride on
  top of the resolver but do not change its contract.
