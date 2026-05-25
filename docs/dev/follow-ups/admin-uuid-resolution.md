# Admin observability — UUID → display-name resolution

Status: open.
Filed: 2026-05-25 (close-out of `docs/dev/plans/done/admin-observability-viewer.md`).

## What remains

The admin observability viewers (Events, LLM calls, Chat pipeline
runs, Analytics) render `layer_id` and `user_id` as raw UUIDs. The
wireframes hinted at resolving them to layer slug / user
display-name (email / username). Phase 2 deferred this, Phase 3
and Phase 4 each re-noted it explicitly in their outcomes
sections.

## Why not done now

The redaction audit
(`docs/dev/audits/admin-observability-redaction-2026-05-25.md`)
does not force inline display of the resolved names. Resolving
them requires either:

- A JOIN per list query (extra cost on the hot path), or
- A second batch fetch keyed off the page's distinct ids (extra
  round-trip + a new endpoint), or
- A client-side cache populated lazily as drawers open.

Each option is a real piece of work. The phase 7 close-out kept
scope to "ship complete, document, archive". Adding the resolver
would have been scope creep.

## Next step

Pick the strategy. Recommended: a small `/admin/observability/resolve`
endpoint that takes `{ layerIds, userIds }` and returns
`{ layers: { id: slug }, users: { id: displayName } }`. The web
pages call it once per page-load with the distinct ids surfaced
in the visible rows and merge the result into the existing
columns.

## Related files

- `apps/web/src/pages/admin/AdminEventsPage.tsx`
- `apps/web/src/pages/admin/AdminLlmCallsPage.tsx`
- `apps/web/src/pages/admin/AdminChatRunsPage.tsx`
- `apps/web/src/pages/admin/AdminAnalyticsPage.tsx`
- `apps/server/src/http/routes/admin-observability.ts`
