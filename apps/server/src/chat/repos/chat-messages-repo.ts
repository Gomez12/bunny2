import type { Database } from 'bun:sqlite';
import type { ChatMessageRole, ChatMessageStatus } from '@bunny2/shared';

/**
 * Phase 6.1 — repository over `chat_messages`.
 *
 * Messages are ordered turns inside a conversation. They are NOT
 * soft-deleted; a failed answer stays in the thread so the user
 * sees what happened. The conversation row is the deletion
 * boundary.
 *
 * `status` mirrors the lifecycle the orchestrator (phase 6.3)
 * drives: `queued → running → done | failed`. `model`, `tokens_in`,
 * `tokens_out` and `finished_at` are filled on terminal transition.
 */

export interface ChatMessage {
  readonly id: string;
  readonly conversationId: string;
  readonly role: ChatMessageRole;
  readonly content: string;
  readonly status: ChatMessageStatus;
  readonly model: string | null;
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly correlationId: string;
  readonly flowId: string;
  readonly createdAt: string;
  readonly finishedAt: string | null;
}

interface ChatMessageRow {
  id: string;
  conversation_id: string;
  role: ChatMessageRole;
  content: string;
  status: ChatMessageStatus;
  model: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  correlation_id: string;
  flow_id: string;
  created_at: string;
  finished_at: string | null;
}

export interface InsertChatMessageInput {
  readonly id: string;
  readonly conversationId: string;
  readonly role: ChatMessageRole;
  readonly content: string;
  readonly status: ChatMessageStatus;
  readonly correlationId: string;
  readonly flowId: string;
  readonly model?: string | null;
  readonly tokensIn?: number | null;
  readonly tokensOut?: number | null;
  readonly now: string;
}

export interface UpdateChatMessagePatch {
  readonly status?: ChatMessageStatus;
  readonly content?: string;
  readonly model?: string | null;
  readonly tokensIn?: number | null;
  readonly tokensOut?: number | null;
  readonly finishedAt?: string | null;
}

export interface ChatMessagesRepo {
  insertMessage(input: InsertChatMessageInput): ChatMessage;
  getMessageById(id: string): ChatMessage | null;
  /** Load every message in a conversation, oldest-first. */
  listByConversation(conversationId: string): ChatMessage[];
  updateMessage(id: string, patch: UpdateChatMessagePatch): ChatMessage;
}

const COLS =
  'id, conversation_id, role, content, status, model, ' +
  'tokens_in, tokens_out, correlation_id, flow_id, created_at, finished_at';

function rowToMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    status: row.status,
    model: row.model,
    tokensIn: row.tokens_in,
    tokensOut: row.tokens_out,
    correlationId: row.correlation_id,
    flowId: row.flow_id,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
  };
}

export function createChatMessagesRepo(db: Database): ChatMessagesRepo {
  const insert = db.query<
    unknown,
    [
      string,
      string,
      ChatMessageRole,
      string,
      ChatMessageStatus,
      string | null,
      number | null,
      number | null,
      string,
      string,
      string,
    ]
  >(
    `INSERT INTO chat_messages
       (id, conversation_id, role, content, status,
        model, tokens_in, tokens_out,
        correlation_id, flow_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<ChatMessageRow, [string]>(
    `SELECT ${COLS} FROM chat_messages WHERE id = ?`,
  );

  const listByConv = db.query<ChatMessageRow, [string]>(
    `SELECT ${COLS} FROM chat_messages
       WHERE conversation_id = ?
       ORDER BY created_at ASC`,
  );

  return {
    insertMessage(input) {
      insert.run(
        input.id,
        input.conversationId,
        input.role,
        input.content,
        input.status,
        input.model ?? null,
        input.tokensIn ?? null,
        input.tokensOut ?? null,
        input.correlationId,
        input.flowId,
        input.now,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(`chat-messages-repo: failed to read back message ${input.id} after insert`);
      }
      return rowToMessage(row);
    },

    getMessageById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToMessage(row);
    },

    listByConversation(conversationId) {
      return listByConv.all(conversationId).map(rowToMessage);
    },

    updateMessage(id, patch) {
      const sets: string[] = [];
      const params: (string | number | null)[] = [];
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.content !== undefined) {
        sets.push('content = ?');
        params.push(patch.content);
      }
      if (patch.model !== undefined) {
        sets.push('model = ?');
        params.push(patch.model);
      }
      if (patch.tokensIn !== undefined) {
        sets.push('tokens_in = ?');
        params.push(patch.tokensIn);
      }
      if (patch.tokensOut !== undefined) {
        sets.push('tokens_out = ?');
        params.push(patch.tokensOut);
      }
      if (patch.finishedAt !== undefined) {
        sets.push('finished_at = ?');
        params.push(patch.finishedAt);
      }
      if (sets.length === 0) {
        const existing = findById.get(id);
        if (existing === null) {
          throw new Error(`chat-messages-repo: message ${id} not found`);
        }
        return rowToMessage(existing);
      }
      const sql = `UPDATE chat_messages SET ${sets.join(', ')} WHERE id = ?`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`chat-messages-repo: message ${id} not found after update`);
      }
      return rowToMessage(row);
    },
  };
}
