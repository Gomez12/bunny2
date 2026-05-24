import type { Database } from 'bun:sqlite';
import type { PipelineRunStatus } from '@bunny2/shared';

/**
 * Phase 6.1 — repository over `chat_pipeline_runs`.
 *
 * One row per assistant message attempting an answer. The
 * orchestrator (phase 6.3) creates the run when a message moves
 * from `queued` to `running`, then writes one
 * `chat_pipeline_steps` row per pipeline stage.
 *
 * v1 is 1:1 with the assistant `chat_messages` row; the separate
 * table keeps space open for a future "retry as new run" flow
 * without reshaping the messages table.
 */

export interface ChatPipelineRun {
  readonly id: string;
  readonly messageId: string;
  readonly status: PipelineRunStatus;
  readonly startedAt: string;
  readonly endedAt: string | null;
}

interface ChatPipelineRunRow {
  id: string;
  message_id: string;
  status: PipelineRunStatus;
  started_at: string;
  ended_at: string | null;
}

export interface InsertChatPipelineRunInput {
  readonly id: string;
  readonly messageId: string;
  readonly status: PipelineRunStatus;
  readonly startedAt: string;
}

export interface UpdateChatPipelineRunPatch {
  readonly status?: PipelineRunStatus;
  readonly endedAt?: string | null;
}

export interface ChatPipelineRunsRepo {
  insertRun(input: InsertChatPipelineRunInput): ChatPipelineRun;
  getRunById(id: string): ChatPipelineRun | null;
  /** Load every run for a message in `started_at` order. */
  listByMessage(messageId: string): ChatPipelineRun[];
  updateRun(id: string, patch: UpdateChatPipelineRunPatch): ChatPipelineRun;
}

const COLS = 'id, message_id, status, started_at, ended_at';

function rowToRun(row: ChatPipelineRunRow): ChatPipelineRun {
  return {
    id: row.id,
    messageId: row.message_id,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
  };
}

export function createChatPipelineRunsRepo(db: Database): ChatPipelineRunsRepo {
  const insert = db.query<unknown, [string, string, PipelineRunStatus, string]>(
    `INSERT INTO chat_pipeline_runs
       (id, message_id, status, started_at)
     VALUES (?, ?, ?, ?)`,
  );

  const findById = db.query<ChatPipelineRunRow, [string]>(
    `SELECT ${COLS} FROM chat_pipeline_runs WHERE id = ?`,
  );

  const listByMsg = db.query<ChatPipelineRunRow, [string]>(
    `SELECT ${COLS} FROM chat_pipeline_runs
       WHERE message_id = ?
       ORDER BY started_at ASC`,
  );

  return {
    insertRun(input) {
      insert.run(input.id, input.messageId, input.status, input.startedAt);
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(
          `chat-pipeline-runs-repo: failed to read back run ${input.id} after insert`,
        );
      }
      return rowToRun(row);
    },

    getRunById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToRun(row);
    },

    listByMessage(messageId) {
      return listByMsg.all(messageId).map(rowToRun);
    },

    updateRun(id, patch) {
      const sets: string[] = [];
      const params: (string | null)[] = [];
      if (patch.status !== undefined) {
        sets.push('status = ?');
        params.push(patch.status);
      }
      if (patch.endedAt !== undefined) {
        sets.push('ended_at = ?');
        params.push(patch.endedAt);
      }
      if (sets.length === 0) {
        const existing = findById.get(id);
        if (existing === null) {
          throw new Error(`chat-pipeline-runs-repo: run ${id} not found`);
        }
        return rowToRun(existing);
      }
      const sql = `UPDATE chat_pipeline_runs SET ${sets.join(', ')} WHERE id = ?`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`chat-pipeline-runs-repo: run ${id} not found after update`);
      }
      return rowToRun(row);
    },
  };
}
