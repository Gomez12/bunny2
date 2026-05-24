import type { Database } from 'bun:sqlite';

/**
 * Phase 6.1 — repository over `chat_conversations`.
 *
 * Pure persistence. Soft-deletable, audit-stamped per `overall.md`
 * §5. Scoping (`layer_id`, `user_id`) is the v1 personal-conversation
 * boundary — a "shared conversation" toggle is a phase-7+ follow-up
 * candidate and is not modelled here.
 *
 * The orchestrator (phase 6.3) and the HTTP routes (phase 6.4)
 * compose this repo with the messages / pipeline-run / step repos;
 * we keep each table behind its own repo so the call sites stay
 * self-documenting.
 */

export interface ChatConversation {
  readonly id: string;
  readonly layerId: string;
  readonly userId: string;
  readonly title: string;
  readonly locale: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly deletedBy: string | null;
}

interface ChatConversationRow {
  id: string;
  layer_id: string;
  user_id: string;
  title: string;
  locale: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  deleted_by: string | null;
}

export interface InsertChatConversationInput {
  readonly id: string;
  readonly layerId: string;
  readonly userId: string;
  readonly title: string;
  readonly locale: string;
  readonly now: string;
}

export interface UpdateChatConversationPatch {
  readonly title?: string;
  readonly locale?: string;
}

export interface ListChatConversationsFilter {
  readonly layerId: string;
  readonly userId: string;
  readonly includeDeleted?: boolean;
}

export interface ChatConversationsRepo {
  insertConversation(input: InsertChatConversationInput): ChatConversation;
  getConversationById(id: string): ChatConversation | null;
  /** List the caller's conversations in one layer, newest first. */
  listConversations(filter: ListChatConversationsFilter): ChatConversation[];
  /**
   * Same set as `listConversations` plus aggregated thumbs-up /
   * thumbs-down counts joined from `chat_message_feedback`. Phase 6.6
   * — used by the conversation list endpoint and the
   * `RecentChatsWidget` to render a feedback ratio without N+1
   * fetches.
   */
  listConversationSummaries(filter: ListChatConversationsFilter): ChatConversationSummary[];
  updateConversation(id: string, patch: UpdateChatConversationPatch, now: string): ChatConversation;
  /** Bumps `updated_at` only. Used after a new message lands. */
  touchConversation(id: string, now: string): void;
  softDeleteConversation(id: string, deletedBy: string, now: string): void;
}

export interface ChatConversationSummary extends ChatConversation {
  readonly feedbackUpCount: number;
  readonly feedbackDownCount: number;
}

const COLS =
  'id, layer_id, user_id, title, locale, ' + 'created_at, updated_at, deleted_at, deleted_by';

function rowToConversation(row: ChatConversationRow): ChatConversation {
  return {
    id: row.id,
    layerId: row.layer_id,
    userId: row.user_id,
    title: row.title,
    locale: row.locale,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    deletedBy: row.deleted_by,
  };
}

export function createChatConversationsRepo(db: Database): ChatConversationsRepo {
  const insert = db.query<unknown, [string, string, string, string, string, string, string]>(
    `INSERT INTO chat_conversations
       (id, layer_id, user_id, title, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<ChatConversationRow, [string]>(
    `SELECT ${COLS} FROM chat_conversations WHERE id = ?`,
  );

  const listActive = db.query<ChatConversationRow, [string, string]>(
    `SELECT ${COLS} FROM chat_conversations
       WHERE layer_id = ? AND user_id = ? AND deleted_at IS NULL
       ORDER BY updated_at DESC`,
  );

  const listAll = db.query<ChatConversationRow, [string, string]>(
    `SELECT ${COLS} FROM chat_conversations
       WHERE layer_id = ? AND user_id = ?
       ORDER BY updated_at DESC`,
  );

  const softDelete = db.query<unknown, [string, string, string, string]>(
    `UPDATE chat_conversations
        SET deleted_at = ?, deleted_by = ?, updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  );

  const touch = db.query<unknown, [string, string]>(
    `UPDATE chat_conversations
        SET updated_at = ?
      WHERE id = ? AND deleted_at IS NULL`,
  );

  return {
    insertConversation(input) {
      insert.run(
        input.id,
        input.layerId,
        input.userId,
        input.title,
        input.locale,
        input.now,
        input.now,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(
          `chat-conversations-repo: failed to read back conversation ${input.id} after insert`,
        );
      }
      return rowToConversation(row);
    },

    getConversationById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToConversation(row);
    },

    listConversations(filter) {
      const stmt = filter.includeDeleted === true ? listAll : listActive;
      return stmt.all(filter.layerId, filter.userId).map(rowToConversation);
    },

    listConversationSummaries(filter) {
      // Aggregate feedback per conversation in a single grouped
      // subquery; LEFT JOIN so conversations with zero feedback rows
      // still come through (with both counts = 0).
      type SummaryRow = ChatConversationRow & {
        feedback_up_count: number;
        feedback_down_count: number;
      };
      const includeDeletedClause = filter.includeDeleted === true ? '' : 'AND c.deleted_at IS NULL';
      const sql = `
        SELECT
          c.id, c.layer_id, c.user_id, c.title, c.locale,
          c.created_at, c.updated_at, c.deleted_at, c.deleted_by,
          COALESCE(fb.up_count, 0) AS feedback_up_count,
          COALESCE(fb.down_count, 0) AS feedback_down_count
          FROM chat_conversations c
          LEFT JOIN (
            SELECT
              m.conversation_id AS conversation_id,
              SUM(CASE WHEN f.value = 'up' THEN 1 ELSE 0 END) AS up_count,
              SUM(CASE WHEN f.value = 'down' THEN 1 ELSE 0 END) AS down_count
              FROM chat_message_feedback f
              JOIN chat_messages m ON m.id = f.message_id
             GROUP BY m.conversation_id
          ) fb ON fb.conversation_id = c.id
         WHERE c.layer_id = ? AND c.user_id = ? ${includeDeletedClause}
         ORDER BY c.updated_at DESC
      `;
      const rows = db.query<SummaryRow, [string, string]>(sql).all(filter.layerId, filter.userId);
      return rows.map((row) => ({
        ...rowToConversation(row),
        feedbackUpCount: Number(row.feedback_up_count),
        feedbackDownCount: Number(row.feedback_down_count),
      }));
    },

    updateConversation(id, patch, now) {
      const sets: string[] = [];
      const params: (string | number)[] = [];
      if (patch.title !== undefined) {
        sets.push('title = ?');
        params.push(patch.title);
      }
      if (patch.locale !== undefined) {
        sets.push('locale = ?');
        params.push(patch.locale);
      }
      if (sets.length === 0) {
        const existing = findById.get(id);
        if (existing === null) {
          throw new Error(`chat-conversations-repo: conversation ${id} not found`);
        }
        return rowToConversation(existing);
      }
      sets.push('updated_at = ?');
      params.push(now);
      const sql = `UPDATE chat_conversations SET ${sets.join(', ')} WHERE id = ? AND deleted_at IS NULL`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`chat-conversations-repo: conversation ${id} not found after update`);
      }
      return rowToConversation(row);
    },

    touchConversation(id, now) {
      touch.run(now, id);
    },

    softDeleteConversation(id, deletedBy, now) {
      softDelete.run(now, deletedBy, now, id);
    },
  };
}
