# Follow-up — `LayerChatPage` should read `?message=:id` from URL

- Status: open
- Created: 2026-05-24 (phase 6 close-out, 6.6 handoff)
- Phases referencing it: 6.5 (page), 6.6 (board card links)

## What remains

Phase 6.6 wired the chat board: each card carries a "Jump to
conversation" link of the form
`/l/<slug>/chat?conversation=<id>&message=<id>`. The page picks up
the `conversation` param and opens the right thread — but it
**ignores the `message` param** today. A user who clicks a board
card lands at the bottom of the thread, not at the message the
card represented.

The follow-up is: have `LayerChatPage` read `?message=:id` and
scroll the corresponding message into view, optionally with a
brief highlight so the user knows which one it is.

## Why not done now

Phase 6.6 closed without time to wire the scroll-into-view
behavior; the page-open with the right thread is already the
biggest UX win. The deep link works; the polish doesn't.

## Next step

1. In `apps/web/src/pages/LayerChatPage.tsx`, read
   `searchParams.get('message')`.
2. After the thread renders, scroll the
   `[data-message-id="<id>"]` element into view (smooth scroll).
3. Add a 2-second `ring-2 ring-primary` highlight via a CSS class
   driven from React state.
4. Test: simulate a `?message=` param in
   `apps/web/tests/layer-chat-page.test.tsx`; assert scroll +
   highlight.
5. Verify keyboard focus lands on the message for screen-reader
   announcement (a `tabindex="-1"` + `.focus()` is enough).

## Related files / docs

- `apps/web/src/pages/LayerChatPage.tsx` — the page that needs
  the new behavior.
- `apps/web/src/pages/LayerChatBoardPage.tsx` — already emits
  `?message=` on the card link; no change.
- `docs/user/guides/working-with-chat.md` §5 — describes the
  board-to-thread jump; reads better once this lands.
