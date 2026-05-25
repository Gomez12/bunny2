# Follow-up — Members tab needs a non-admin user/group picker

- Status: done
- Created: 2026-05-23 (phase 3.6 close-out — discovered during 3.5)
- Resolved: 2026-05-25
- Phases referencing it: 3.5 (UI gap), 3.6 (close-out)

## Resolution

Picked option B from "Next step" — visibility via the existing
transitive group graph. Two new authenticated routes registered in
`apps/server/src/http/routes/me-visible.ts`:

- `GET /me/visible-users` — returns `{ users: [{id, displayName}] }`.
  Implementation walks `GroupResolver.expandUserGroups(caller)` for
  the caller's transitive group set, then `expandGroupMembers(g)`
  per group, unions the user ids, drops self, hydrates via
  `usersRepo.listUsers()` (excludes soft-deleted), sorts by
  `displayName`.
- `GET /me/visible-groups` — returns `{ groups: [{id, name, slug}] }`.
  Implementation returns the caller's own transitive group set
  (`expandUserGroups`) — the picker for "groups I can add to a
  layer" wants exactly this set (adding a group I'm not in would
  grant access to people I cannot see).

Both routes are the directory-disclosure boundary for non-admins —
documented in `docs/dev/architecture/layers-and-auth.md` §0 + §4.

`apps/web/src/pages/LayerSettingsPage.tsx` MembersTab now mounts a
two-step picker (kind: user / group → member → role) populated from
the two endpoints. Free-text id input replaced. Loading + empty +
error states i18n'd in en + nl.

Tests (`apps/server/tests/http-me-visible.test.ts`):
- Visible peers via a shared transitive group.
- Self excluded.
- Soft-deleted users excluded.
- Users in no shared group excluded.
- Empty-list response for a caller in no groups.
- `/me/visible-groups` returns the caller's transitive group set
  sorted by name.

## What remains

The phase-3.5 `LayerSettingsPage` ships a **Members** tab that lets
an owner / site-admin add and remove members from a project layer.
On the server side every route is in place
(`POST /layers/:slug/members`, `DELETE /layers/:slug/members/:memberId`,
both authz-gated by `canEditLayer`) and tested in
`apps/server/tests/http-layers-members.test.ts`.

The UI gap: there is no way for a non-site-admin owner to **pick**
a user or group to add. The admin pages
(`/admin/users`, `/admin/groups`) list every user / group in the
system, but they're admin-only. A regular project-layer owner has no
endpoint that lets them discover candidate members without leaking
the whole user directory.

Concrete next pieces of work:

1. Decide the scope of "candidate member directory" for a
   non-admin:
   - **Option A** — return only users / groups the caller already
     shares a layer with. Safe, simple, but a brand-new colleague
     would be unfindable.
   - **Option B** — a new `GET /me/group-members` (or
     `GET /me/visible-users`) that returns the set of users who
     share at least one transitive group with the caller. Wider
     than A but bounded by the existing group membership graph.
   - **Option C** — return every non-deleted user / group with a
     `displayName` + `id` shape only. Easiest, but exposes the
     directory. Probably acceptable for an internal tool;
     definitely needs an explicit decision recorded in an ADR or
     in `auth-and-sessions.md`.
2. Add the chosen endpoint(s) with explicit per-route authz tests.
3. Wire the picker UI in `apps/web/src/pages/LayerSettingsPage.tsx`
   (Members tab). Today the tab accepts a free-text userId / groupId
   for testing only; the picker replaces that.

## Why not done now

The phase-3 plan §K instructs the 3.6 close-out author to not add
new server endpoints. The three options above all involve picking a
disclosure-vs-discoverability trade-off that has security
implications for phase 4+ (entity rows referencing users / groups by
id), and that decision deserves more than a fly-by during
close-out.

## Next step

Pick option A / B / C — recommendation is **B** for the
"visible-via-group-graph" semantics that fit the layered scoping
model. Open a tasklist row that schedules the work; phase 4 is the
natural slot because entity ownership reads the same directory.

## Related files / docs

- `apps/web/src/pages/LayerSettingsPage.tsx` — the Members tab
  consumer.
- `apps/server/src/http/routes/layers.ts` — the write endpoints
  this UI calls today.
- `apps/server/tests/http-layers-members.test.ts` — the server-side
  contract that already covers the happy + edge paths.
- `docs/dev/architecture/layers-and-auth.md` §4 — per-layer authz
  table.
- `docs/dev/plans/done/phase-03-layers.md` §14 — close-out reference.
