# Follow-up — Replace web `console.log` analytics placeholders

- Status: open
- Created: 2026-05-24 (phase 6 close-out, 6.5 handoff)
- Phases referencing it: 6.5 (chat UI), every web page that emits analytics

## What remains

Phase 6.5 sprinkled analytics call sites through the web app
(chat page composer, feedback buttons, board card click). The
calls go through a placeholder helper that does
`console.log('[chat.analytics] …')` — the real event name +
properties are correct, but they're not wired to any real sink.

The follow-up is: introduce a real analytics primitive in
`apps/web/src/lib/analytics.ts` (one module, one
`trackEvent(name, props)` export) and replace every
`console.log('[chat.analytics] ...')` call site with it.

## Why not done now

The analytics destination is a product decision (PostHog?
Plausible? a server-side `analytics_events` table?) that wasn't
ready in phase 6. The placeholders were deliberately structured
so a single search-and-replace finishes the migration.

## Next step

1. Decide the analytics sink. The data-minimization rules in
   `AGENTS.md §Analytics` apply.
2. Create `apps/web/src/lib/analytics.ts` exporting
   `trackEvent(name, props)` (no-op when no sink is configured;
   never log raw user input).
3. Search the web sources for
   `console.log('[chat.analytics]'` and replace each one with a
   `trackEvent(...)` call (the strings already use stable names).
4. Add a test that the analytics events fire on the expected
   user actions (composer submit, thumbs up/down, board card
   click).
5. Update `docs/dev/observability/analytics.md` with the new
   sink + the chat event catalogue.

## Related files / docs

- `apps/web/src/pages/LayerChatPage.tsx`,
  `apps/web/src/pages/LayerChatBoardPage.tsx`,
  `apps/web/src/dashboard/RecentChatsWidget.tsx` — placeholder
  call sites.
- `AGENTS.md §Analytics` — the rules the new primitive must
  honor.
- `docs/dev/observability/analytics.md` — the catalogue this
  feeds into.
