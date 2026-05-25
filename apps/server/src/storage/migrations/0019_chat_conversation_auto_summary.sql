-- Conversation auto-summary follow-up.
--
-- Adds `last_summarized_message_count` to `chat_conversations` so
-- the summarize handler is idempotent: the per-message subscriber
-- and the daily sweep both check it before re-summarizing. The
-- gate is "messageCount >= 6 AND messageCount % 6 === 0 AND
-- last_summarized_message_count < messageCount".
--
-- NULL = "never summarized" — the column starts NULL on existing
-- rows so the first eligible thread runs through the handler.
--
-- Forward-only; no data backfill needed (NULL is the correct
-- starting state for every existing thread).

ALTER TABLE chat_conversations
  ADD COLUMN last_summarized_message_count INTEGER;
