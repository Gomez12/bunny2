# Plan — chat conversation auto-summary

> Closes `docs/dev/follow-ups/chat-conversation-auto-summary.md`.

## Goal

Replace the "first 60 characters of the first message" title with
an LLM-generated short title once a thread has enough turns, and
keep the title stable as the conversation grows. Idempotent — the
same `messageCount` is never re-summarized twice.

## Scope

- Migration `0019_chat_conversation_auto_summary.sql` adds
  `chat_conversations.last_summarized_message_count`.
- New core function `summarizeConversation(conversationId, deps, opts)`.
- Scheduled-task handler `chat.summarize-conversation` (daily sweep).
- Subscriber on `chat.message.answered` (per-message trigger).
- `POST /l/:slug/chat/conversations/:id/regenerate-title` (manual).
- UI: "regenerate title" button on the conversation list.
- i18n + telemetry doc + analytics event.

## Non-goals

- Multi-paragraph summaries. Titles only.
- Per-locale titles in v1.
- LLM model selection — the existing chat client default is used.

## Approach (bullets)

- `last_summarized_message_count` is the only idempotency state we
  need; the event path and the daily sweep both check it.
- The gate `messageCount >= 6 AND messageCount % 6 === 0 AND
  last_summarized_message_count < messageCount` lives in pure code
  (`shouldEnqueueSummarize`) and is re-checked inside the handler.
- The handler builds a short prompt from the last 10 messages, asks
  for ≤60 chars no-quote no-period output, and `sanitizeTitle`
  defensively trims the reply.
- Failure handling: empty reply / LLM error logs + counters; the
  title stays as-is. No in-handler retry — the next 6-message gate
  or the daily sweep retries.
- The manual route calls the same core with `force: true`.

## Affected modules

- `apps/server/src/storage/migrations/0019_chat_conversation_auto_summary.sql`
- `apps/server/src/chat/repos/chat-conversations-repo.ts`
- `apps/server/src/chat/summarize-conversation.ts`
- `apps/server/src/chat/summarize-conversation-handler.ts`
- `apps/server/src/chat/summarize-conversation-subscriber.ts`
- `apps/server/src/chat/index.ts`
- `apps/server/src/index.ts`
- `apps/server/src/http/routes/layer-chat.ts`
- `packages/shared/src/chat.ts`
- `apps/web/src/pages/LayerChatPage.tsx`
- `apps/web/src/lib/api.ts`
- `apps/web/src/i18n/locales/{en,nl}.json`
- `docs/dev/architecture/job-inventory.md`
- `docs/dev/observability/telemetry.md`
- `docs/dev/architecture/chat-pipeline.md`

## Phases

- Migration + repo column + zod schema.
- Core `summarizeConversation` function + handler + subscriber.
- Job-inventory row + scheduled-task registration.
- Manual route + UI + analytics + i18n.
- Tests (handler unit, subscriber integration, manual endpoint, migrations).

## Tests

- `apps/server/tests/chat-summarize-conversation.test.ts` —
  `sanitizeTitle` + `shouldEnqueueSummarize` + handler happy-path,
  empty-reply, LLM-error, idempotent re-run + subscriber gate fires
  at 6 / 12 not at 1-5 / 7-11.
- `apps/server/tests/chat-routes/regenerate-title.test.ts` —
  manual endpoint happy path + cross-user 404.

## Observability

- `chat.summarize.completed` counter + `chat.summarize.duration_ms`
  observation on success.
- `chat.summarize.failed` counter with `reason ∈ {empty-title,
  llm-error}` dimension.
- Structured logs `chat.summarize.*` and `chat.regenerate-title`.
- Analytics event `chat_conversation_title_regenerated`
  (`{ layerSlug }`) on the manual path.
- All updates documented in
  `docs/dev/observability/telemetry.md` §7.

## Risks

- LLM cost — one call per 6 messages per conversation. Mitigated by
  the gate (no calls in short threads) and the existing
  `llm_calls.cost_usd` accounting.
- Title churn on long threads — the gate fires every 6 messages, so
  the title can shift in user-perceptible ways. Acceptable in v1;
  the manual button lets users pin one.
