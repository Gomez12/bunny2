# Follow-up — Shared / team conversations

- Status: open
- Created: 2026-05-24 (phase 6 close-out, plan §10)
- Phases referencing it: 6.1 (storage), 6.4 (HTTP scoping), 7

## What remains

Phase-6 conversations are scoped to `(layer_id, user_id)`: only
the user who started the conversation sees it. The same layer can
hold many independent threads.

Plan §10 records "a shared toggle is a phase-7 follow-up
candidate". The follow-up is: add a per-conversation
`visibility` (e.g. `private` / `layer`) that lets a layer's
members see (and reply to?) one another's threads.

Open design questions:

- Read-only sharing vs read-write?
- Who can flip `visibility` — the conversation owner only?
- How do thumbs ratings aggregate across users on a shared
  conversation?
- Do shared threads change the auth-boundary for retrieval?
  (They shouldn't — retrieval still filters by the **viewer's**
  effective layer set, but the conversation history is shared
  view.)

## Why not done now

A real product question that wants user signal before it gets
chosen. v1 is personal-by-default precisely because that's the
shape every user understands and the storage / repos already
support a per-row `user_id`.

## Next step

1. Decide visibility model with a real user request.
2. Add `chat_conversations.visibility` column (default
   `'private'`).
3. Update `chat-conversations-repo.ts` `listForLayerUser` to
   include shared rows when the caller is in the layer.
4. Add the toggle to the conversation list UI; analytics event
   `chat_conversation_shared`.

## Related files / docs

- `apps/server/src/chat/repos/chat-conversations-repo.ts` — the
  scoping lives in `listConversationSummaries(layerId, userId)`.
- `docs/dev/plans/done/phase-06-super-chat.md` §10 — security
  scoping notes.
