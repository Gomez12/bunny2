# Follow-up — `GET /layers/:slug` should include attachments (or a sibling endpoint)

- Status: open
- Created: 2026-05-23 (phase 3.6 close-out — discovered during 3.5)
- Phases referencing it: 3.5 (UI gap), 3.6 (close-out)

## What remains

The phase-3.5 `LayerSettingsPage` ships an **Attachments** tab that
lets an owner / site-admin register and remove attachments
(`POST /layers/:slug/attachments`,
`DELETE /layers/:slug/attachments/:id`) for `agent | skill |
mcp_server`. Both routes work, are tested in
`apps/server/tests/http-layers-attachments.test.ts`, and write to
the `layer_attachments` table.

The gap: there is no read endpoint that returns the attachments for
a layer. `GET /layers/:slug` returns the `Layer` row only — no
attachments, no members, no edges, no locales. The UI today only
sees attachments the user added in the current session
(component-local state). After a reload, the list looks empty even
when attachments exist.

Two possible shapes:

1. **Extend `GET /layers/:slug`** to include a nested
   `attachments: LayerAttachment[]` array. Trivial; consistent with
   how phase-2 admin endpoints sometimes nest related rows.
2. **Add `GET /layers/:slug/attachments`** as a sibling endpoint
   returning `{ attachments: LayerAttachment[] }`. Cleaner under a
   future REST-purist pivot; cheaper to cache independently;
   matches the shape this follow-up's siblings
   (`layer-visibility-list.md`) recommend.

Recommendation: **option 2** for consistency with the sibling
read-endpoint follow-ups. The detail route stays light; each tab
fetches what it needs.

Concrete next pieces of work:

1. Add `GET /layers/:slug/attachments` (authz: any member of the
   layer — `requireLayer` is enough).
2. Wire it into `apps/web/src/pages/LayerSettingsPage.tsx`
   Attachments tab on mount + after every register / remove.
3. Per-route HTTP test covering hit + 404-on-non-visible (the route
   inherits `requireLayer`, so the test only needs to assert the
   happy path + 404 leak shape).
4. Optional: also add `GET /layers/:slug/members` and
   `GET /layers/:slug/locales` for symmetry. Out of scope for this
   single follow-up; capture as a sibling follow-up if needed.

## Why not done now

Phase 3.6 §K instructs no new server endpoints during close-out.
The "which read shape is right" question (extend the detail route
vs sibling) deserves an explicit decision; punting until phase 4
(when entity reads define the shape we want to settle on) keeps the
question in one place.

## Next step

Pick option 1 vs 2 (recommendation: option 2), open a tasklist row,
implement during phase 4 entity read alignment. The UI consumer is
already there waiting; the work is a one-route + one-fetch change.

## Related files / docs

- `apps/web/src/pages/LayerSettingsPage.tsx` — the Attachments tab
  consumer.
- `apps/server/src/http/routes/layers.ts` — existing register /
  remove routes.
- `apps/server/src/repos/layer-attachments-repo.ts` — already
  exposes `listAttachments(layerId)` (used by the delete route's
  membership check). The new endpoint is a thin wrapper.
- `docs/dev/architecture/layers-and-auth.md` §0 — the surface map
  this follow-up will extend.
- `docs/dev/plans/done/phase-03-layers.md` §14 — close-out reference.
