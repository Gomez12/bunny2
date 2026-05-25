# Follow-up — `GET /layers/:slug/visibility` (list current edges)

- Status: open
- Created: 2026-05-23 (phase 3.6 close-out — discovered during 3.5)
- Phases referencing it: 3.5 (UI gap), 3.6 (close-out)

## What remains

The phase-3.5 `LayerSettingsPage` ships a **Visibility** tab that
lets an owner / site-admin add (`POST /layers/:slug/visibility`)
and remove (`DELETE /layers/:slug/visibility/:parentSlug`) parent
edges from a layer. Both routes are in place and tested in
`apps/server/tests/http-layers-visibility.test.ts`.

The gap: there is no `GET /layers/:slug/visibility` endpoint that
returns the **current** edges for a layer. The UI today shows a
"no edges loaded yet" placeholder and only knows about edges the
user added in the current session (kept in component state). After
a reload, the list looks empty even when edges exist on the server.

Concrete next pieces of work:

1. Add `GET /layers/:slug/visibility` returning
   `{ edges: [{ parentLayerId, parentSlug, parentName, direction,
createdAt }] }`. Walk both directions
   (`listEdgesForChild(layer.id)` plus a sibling
   `listEdgesForParent(layer.id)`) so the UI can show "this layer
   inherits FROM" and "this layer is inherited BY" in two
   sub-sections.
2. Decide what the route returns for parents the caller cannot see
   (visibility leak question, same shape as ADR `0010`'s
   404-on-non-visible). Recommendation: omit the row entirely
   rather than returning a redacted entry — the caller cannot edit
   what they cannot see, so the row would be useless either way.
3. Wire the GET into `apps/web/src/pages/LayerSettingsPage.tsx`
   Visibility tab on mount + after every add / remove.
4. Per-route HTTP test covering hit + miss + visibility-redaction
   shape.

## Why not done now

Same as `layer-members-picker.md`: phase 3.6 §K instructs no new
server endpoints during close-out. The "what does the route return
for a parent the caller cannot see?" decision needs an explicit
write-up so we stay consistent with the ADR `0010` 404-is-the-only-
answer policy on `/layers/:slug` itself.

## Next step

Schedule against phase 4 (entity reads will face the same
"visibility-redacted row" question for cross-layer references). Open
a tasklist row pointing at this follow-up.

## Related files / docs

- `apps/web/src/pages/LayerSettingsPage.tsx` — the Visibility tab
  consumer.
- `apps/server/src/http/routes/layers.ts` — the existing
  add / remove edge routes.
- `apps/server/src/repos/layer-visibility-repo.ts` — the existing
  `listEdgesForChild` (a sibling `listEdgesForParent` is the small
  repo addition this follow-up needs).
- `docs/dev/decisions/0010-layer-resolver-and-invalidation.md` —
  the 404-vs-403 policy whose extension this follow-up has to
  respect.
- `docs/dev/plans/done/phase-03-layers.md` §14 — close-out reference.
