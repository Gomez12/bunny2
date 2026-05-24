import type { Database } from 'bun:sqlite';
import type { ChatFeedbackValue } from '@bunny2/shared';

/**
 * Phase 6.1 — repository over `chat_message_feedback`.
 *
 * One feedback row per assistant message. The SQL UNIQUE constraint
 * on `message_id` (single column, not `(message_id, user_id)`) is
 * intentional: v1 conversations are personal-scoped, so only the
 * owning user can post feedback. A re-submission overwrites; the
 * `upsertFeedback` method exposes that contract explicitly via
 * `INSERT ... ON CONFLICT(message_id) DO UPDATE`.
 *
 * `reason` is free text and is only meaningful when `value = 'down'`.
 * The HTTP boundary in phase 6.4 enforces that; this repo accepts
 * either to keep the storage layer dumb.
 */

export interface ChatMessageFeedback {
  readonly id: string;
  readonly messageId: string;
  readonly userId: string;
  readonly value: ChatFeedbackValue;
  readonly reason: string | null;
  readonly createdAt: string;
}

interface ChatMessageFeedbackRow {
  id: string;
  message_id: string;
  user_id: string;
  value: ChatFeedbackValue;
  reason: string | null;
  created_at: string;
}

export interface UpsertChatMessageFeedbackInput {
  readonly id: string;
  readonly messageId: string;
  readonly userId: string;
  readonly value: ChatFeedbackValue;
  readonly reason?: string | null;
  readonly now: string;
}

export interface ChatMessageFeedbackRepo {
  /**
   * Insert or overwrite the feedback row for a message. The `id`
   * on the input is only used when a brand-new row is inserted —
   * on conflict the existing row's `id` is preserved.
   */
  upsertFeedback(input: UpsertChatMessageFeedbackInput): ChatMessageFeedback;
  getFeedbackByMessageId(messageId: string): ChatMessageFeedback | null;
}

const COLS = 'id, message_id, user_id, value, reason, created_at';

function rowToFeedback(row: ChatMessageFeedbackRow): ChatMessageFeedback {
  return {
    id: row.id,
    messageId: row.message_id,
    userId: row.user_id,
    value: row.value,
    reason: row.reason,
    createdAt: row.created_at,
  };
}

export function createChatMessageFeedbackRepo(db: Database): ChatMessageFeedbackRepo {
  // ON CONFLICT(message_id) is permitted because the column has a
  // UNIQUE constraint. The existing row keeps its `id`; we only
  // overwrite the mutable fields. `created_at` updates so the
  // timestamp reflects the latest submission.
  const upsert = db.query<
    unknown,
    [string, string, string, ChatFeedbackValue, string | null, string]
  >(
    `INSERT INTO chat_message_feedback
       (id, message_id, user_id, value, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE
        SET user_id    = excluded.user_id,
            value      = excluded.value,
            reason     = excluded.reason,
            created_at = excluded.created_at`,
  );

  const findByMessage = db.query<ChatMessageFeedbackRow, [string]>(
    `SELECT ${COLS} FROM chat_message_feedback WHERE message_id = ?`,
  );

  return {
    upsertFeedback(input) {
      upsert.run(
        input.id,
        input.messageId,
        input.userId,
        input.value,
        input.reason ?? null,
        input.now,
      );
      const row = findByMessage.get(input.messageId);
      if (row === null) {
        throw new Error(
          `chat-message-feedback-repo: failed to read back feedback for message ${input.messageId} after upsert`,
        );
      }
      return rowToFeedback(row);
    },

    getFeedbackByMessageId(messageId) {
      const row = findByMessage.get(messageId);
      return row === null ? null : rowToFeedback(row);
    },
  };
}
