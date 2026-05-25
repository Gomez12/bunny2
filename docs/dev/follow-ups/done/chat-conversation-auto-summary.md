# Follow-up — Conversation auto-summary scheduled task

- Status: open
- Created: 2026-05-24 (phase 6 close-out, plan §12 question 2)
- Phases referencing it: 6.1 (titles use first 60 chars), 6.7

## What remains

Phase-6 conversations get a title from the first 60 characters of
the user's first message. That works while threads stay short.
Longer threads need a real title; the plan reserves the
scheduled-task kind `chat.summarize-conversation` for an
LLM-summary job that rewrites the title (and writes a short
description) after N messages.

## Why not done now

The summary job needs:

- A prompt that produces a stable, useful title (vs the current
  trivial "first 60 chars" rule).
- A trigger policy (every N messages? on first idle? on demand?).
- An LLM-cost line item that didn't exist before.

Phase 6 ships the per-layer chat headline without it; the title
fallback is good enough until users actually have multi-turn
threads in the wild.

## Next step

1. Implement `chatSummarizeConversationHandler` in
   `apps/server/src/chat/` with kind
   `chat.summarize-conversation`.
2. Add the row to `docs/dev/architecture/job-inventory.md`.
3. Decide trigger: probably "messageCount % N === 0" inside the
   `chat.message.answered` subscriber, falling back to a scheduled
   sweep for stragglers.
4. Surface "regenerate title" in the conversation list UI for the
   manual path.

## Related files / docs

- `apps/server/src/chat/repos/chat-conversations-repo.ts` —
  `title` column already nullable for the update path.
- `apps/server/src/chat/pipeline/orchestrator.ts` —
  `chat.message.answered` publish point is the natural
  subscription seam.
- `docs/dev/plans/done/phase-06-super-chat.md` §12 — records the
  reservation.
