# ADR 0009 — Layer model: typed layers + edge-based visibility

- Status: accepted
- Date: 2026-05-23
- Phase: 3 (decision landed in 3.1; written up at 3.6 close-out)
- Related: `docs/dev/plans/done/phase-03-layers.md` §1, §2, §4.2, §11.1,
  §11.4, §11.6;
  `apps/server/src/storage/migrations/0003_layers.sql`;
  `apps/server/src/layers/seed.ts`;
  `apps/server/src/repos/layers-repo.ts`;
  `apps/server/src/repos/layer-visibility-repo.ts`;
  `packages/shared/src/layer.ts`.

---

## Context

Phase 3 introduces the **layer** as the project's primary scoping unit
(`overall.md` §5.4). Two design questions had to be answered before any
phase-3 code could land:

1. **What kinds of layer exist?** The overall plan calls out four
   conceptual scopes — personal, project, group, everyone. Are they
   one polymorphic table or four tables? Are some user-creatable, are
   some seed-only?
2. **How is the parent-child / "sees what's above it" relationship
   modelled?** Two real options:
   - A directed-edge table (`layer_visibility_edges`) — additive,
     supports diamond inheritance, matches the event-sourced spirit
     because every visibility flip is one DDL-free row.
   - A nested-set / path-encoded tree — fast subtree reads, but
     awkward when a layer has multiple parents (e.g. a personal layer
     sees `everyone` AND every group the user is in).

The plan §11.1 and §11.6 record the chosen defaults; this ADR pins
the reasoning so a phase 4+ author cannot quietly walk it back.

---

## Decision

### Types

A single `layers` table with a `type` column constrained to
`('personal','project','group','everyone')`. Per-type rules live in a
SQL CHECK constraint on the same table:

| Type       | Created by | Owner column                                                  | Seed source                      |
| ---------- | ---------- | ------------------------------------------------------------- | -------------------------------- |
| `personal` | seed       | `owner_user_id` (NOT NULL)                                    | one per non-deleted user         |
| `group`    | seed       | `owner_group_id` (NOT NULL)                                   | one per non-deleted group        |
| `everyone` | seed       | neither owner column set                                      | exactly one row, slug `everyone` |
| `project`  | **user**   | neither owner column set; membership via `layer_user_members` | created via `POST /layers`       |

The CHECK constraint enforces the owner-column XOR per type so a
malformed row cannot exist at the storage layer. The decision to
make **project** layers user-creatable while every other type is
seed-only resolves §11.3 / §11.4: any authenticated user can spin up
a project layer, but rename / delete / re-seed of personal / group /
everyone is out of v1 scope.

### Hierarchy via directed edges

`layer_visibility_edges (parent_layer_id, child_layer_id, direction,
created_at)` with `direction IN ('top_down','bottom_up','both')`.
Default direction is **`bottom_up`** (a child layer sees its parent's
entities — matches `overall.md` §5.4 "a layer sees everything above
it"). In v1 the API only accepts `bottom_up` on the write side; the
schema keeps the column so phase 4+ can lift the restriction without
a migration (§11.6).

### Slug stability

- `personal-<username>` is the default slug for a personal layer;
  the seed falls back to `personal-<userId>` (UUID-suffix) when the
  username contains characters that don't fit the slug grammar
  (dots, dashes outside `[a-z0-9-]+`, etc.). The fallback is
  documented in `seed.ts` and covered by a test that uses a username
  with mixed dots / dashes.
- `group-<group.slug>` for group layers, `everyone` for the
  everyone layer.
- The `slug` column is `UNIQUE COLLATE NOCASE`, so a duplicate at any
  level fails the insert before any business logic runs.

Slug **rename** is deliberately out of v1: every layer-scoped URL
includes the slug (`/l/:slug/*`), so renaming requires a slug-history
table + a 301 redirect path. Tracked as a future follow-up in the
phase-3 §10 risk row.

---

## Why edges, not nested-set

Three reasons, in priority order:

1. **Diamond inheritance is the common case, not the edge case.** A
   personal layer typically has multiple parents:
   `personal-alice → group-engineering → everyone` AND
   `personal-alice → group-design → everyone`. Nested-set encodings
   either pick one canonical path (losing the second) or replicate
   subtree rows. Directed edges encode both with two rows.

2. **Additive change at runtime.** Adding a visibility edge is one
   `INSERT INTO layer_visibility_edges (...)` and one `layer.visibility.added`
   event. There is no `lft`/`rgt` reshuffle, no recursive update on
   neighbours. The same shape works under SQLite today and under
   Postgres later (overall plan §3 invariant).

3. **Matches the event-sourced spirit.** Every visibility flip is a
   single bus event with a single new row. Replay rebuilds the graph
   directly from the event log without needing to recompute subtree
   bounds. Nested-set would force the projection to re-walk the tree
   on every change.

The cost is that "which layers does this user effectively see?" is a
graph walk, not an index seek. We absorb that with the per-user LRU
cache documented in ADR `0010`.

---

## Consequences

**Positive**

- One table per concept (`layers`, `layer_visibility_edges`,
  `layer_user_members`, `layer_group_members`, `layer_locales`,
  `layer_attachments`, `layer_dashboard_widgets`). The shape is
  obvious to a reader; the CHECK constraints make the per-type rules
  enforceable at the storage layer.
- Project layers are user-creatable without an admin gate, so any
  authenticated user can start collaborating without admin
  intervention (§11.3). The creator is inserted into
  `layer_user_members` with `role = 'owner'` in the same
  transaction — never a window where the creator is not the owner.
- Future direction lifts (`top_down`, `both`) and future layer types
  are additive: a CHECK relaxation + a payload field, no migration
  of existing rows.

**Negative / accepted**

- Visibility traversal is O(edges) per cache miss. Acceptable: the
  per-user LRU + bus invalidation in ADR `0010` keeps the steady-
  state cost a hash lookup.
- The four types share a table, so a `WHERE type = 'project'` filter
  shows up in most layer queries. We index `idx_layers_type` to
  cover it.
- Cycle prevention at insert is non-trivial — see
  `wouldCreateCycle` in `apps/server/src/http/routes/layers.ts`
  (BFS upward from the proposed parent before INSERT). Required
  defensive code, but bounded and unit-tested.

---

## Alternatives considered

1. **Four separate tables** (`personal_layers`, `project_layers`,
   `group_layers`, `everyone_layer`). Cleaner per-type schema, but
   every cross-type query (the layer switcher, `GET /me/layers`, the
   resolver) becomes a `UNION ALL` and the membership tables
   multiply. Rejected: one table + CHECK is the smaller surface.
2. **Nested-set (`lft`/`rgt`) encoding.** Fast subtree reads, but
   forces one canonical path per layer. Rejected on the diamond
   inheritance argument above.
3. **Path-encoded (`/everyone/group-eng/personal-alice`).** Same
   downside as nested-set plus brittle on rename. Rejected.
4. **No layers, scope via group membership.** Was the v0 sketch.
   Doesn't model the "personal scratch space + shared group + global
   broadcast" distinction the user explicitly wants (`overall.md`
   §5.4). Rejected.
5. **Project layers are admin-only.** Considered for "fewer surprise
   layers". Rejected per §11.3 — would gate every team's collaboration
   on a global admin and reintroduce the bottleneck phase 2 just
   removed.

---

## Follow-ups

- `docs/dev/follow-ups/group-layer-admin-role.md` — until per-group
  admin role lands, group-layer edits fall back to "site-admin only".
  ADR `0010` cross-references the same gap.
- A slug-history + 301-redirect path will land alongside personal-
  layer rename. Tracked as a risk row in the phase-3 plan §10.
- Phase 4+ may relax the v1 `direction = 'bottom_up'` restriction.
  When it does, the corresponding "parent owner accepts" handshake
  needs an ADR of its own.
