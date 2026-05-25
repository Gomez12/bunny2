# Follow-up — `LayerChatPage` honors `?conversation=` query param

- Status: done
- Created: 2026-05-25 (discovered while implementing
  `chat-page-message-deep-link.md`)
- Resolved: 2026-05-25
- Phases referencing it: 6.5 (page), 6.6 (board card links)

## What was wrong

The chat board cards (`apps/web/src/pages/LayerChatBoardPage.tsx`)
emit deep links of the form
`/l/<slug>/chat?conversation=<id>&message=<id>`. The 6.6 follow-up
that wired the `?message=` scroll-into-view behaviour landed in commit
`dfa78cc`, but the page never actually read the `?conversation=`
query parameter — `LayerChatPage` imported `useSearchParams` solely
for the `message` deep link and let `refreshConversations()` default
the active thread to `list[0]` (the most-recently-updated
conversation). As a result, clicking a card on the board sent the
user to whichever thread happened to be at the top of the list, and
the `?message=` scroll only ever fired when the linked message
happened to live in that thread.

## Resolution

`apps/web/src/pages/layer-chat-page-state.ts` now exposes the
`?conversation=` parameter on `ChatDeepLinkParams` and adds a pure
selector, `resolveActiveConversationId(conversations, deepLinkId)`,
that prefers the deep-linked conversation when present in the loaded
list and falls back to `list[0]` (the historical default) when the
param is absent or names a conversation the caller cannot see.

`apps/web/src/pages/LayerChatPage.tsx` reads both params, calls the
selector inside `refreshConversations`, and threads the resolved id
into `setActiveId`. The existing `?message=` effect is unchanged —
it now fires reliably because the right thread is loaded first.

Test coverage lives in `apps/web/tests/layer-chat-page.test.ts`:

- `parseChatDeepLink` returns both `conversationId` and `messageId`.
- `resolveActiveConversationId` returns the deep-linked id when it
  matches, falls back to `list[0]` when the param is absent or
  unknown, and returns `null` on an empty list.

## Related files / docs

- `apps/web/src/pages/LayerChatPage.tsx` — consumer.
- `apps/web/src/pages/layer-chat-page-state.ts` — pure helpers.
- `apps/web/tests/layer-chat-page.test.ts` — regression coverage.
- `apps/web/src/pages/LayerChatBoardPage.tsx` — emits the
  `?conversation=&message=` links the page now honors.
