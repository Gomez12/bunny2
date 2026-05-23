# Follow-up — Members tab needs a non-admin user/group picker

- Status: open
- Created: 2026-05-23 (phase 3.6 close-out — discovered during 3.5)
- Phases referencing it: 3.5 (UI gap), 3.6 (close-out)

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
