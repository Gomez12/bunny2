import type { Database } from 'bun:sqlite';
import type { PipelineStepKind, PipelineStepStatus } from '@bunny2/shared';

/**
 * Phase 6.1 — repository over `chat_pipeline_steps`.
 *
 * One row per (run, kind, attempt). The orchestrator (phase 6.3)
 * writes one row when a step starts and updates it on terminal
 * transition; retries (`attempt > 1`) are appended as new rows so
 * history is preserved.
 *
 * `inputJson` / `outputJson` are opaque to this repo. The
 * orchestrator owns the per-kind shape; this layer just stores the
 * serialised strings (matching the `..._json` convention used
 * elsewhere).
 */

export interface ChatPipelineStep {
  readonly id: string;
  readonly runId: string;
  readonly kind: PipelineStepKind;
  readonly status: PipelineStepStatus;
  readonly attempt: number;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly inputJson: string | null;
  readonly outputJson: string | null;
  readonly llmCallId: string | null;
  readonly errorCode: string | null;
}

interface ChatPipelineStepRow {
  id: string;
  run_id: string;
  kind: PipelineStepKind;
  status: PipelineStepStatus;
  attempt: number;
  started_at: string;
  ended_at: string | null;
  input_json: string | null;
  output_json: string | null;
  llm_call_id: string | null;
  error_code: string | null;
}

export interface InsertChatPipelineStepInput {
  readonly id: string;
  readonly runId: string;
  readonly kind: PipelineStepKind;
  readonly status: PipelineStepStatus;
  readonly attempt?: number;
  readonly startedAt: string;
  readonly inputJson?: string | null;
}

export interface UpdateChatPipelineStepPatch {
  readonly status?: PipelineStepStatus;
  readonly endedAt?: string | null;
  readonly outputJson?: string | null;
  readonly inputJson?: string | null;
  readonly llmCallId?: string | null;
  readonly errorCode?: string | null;
}

export interface ChatPipelineStepsRepo {
  insertStep(input: InsertChatPipelineStepInput): ChatPipelineStep;
  getStepById(id: string): ChatPipelineStep | null;
  /** Load every step for a run, oldest-first. */
  listByRun(runId: string): ChatPipelineStep[];
  updateStep(id: string, patch: UpdateChatPipelineStepPatch): ChatPipelineStep;
}

const COLS =
  'id, run_id, kind, status, attempt, started_at, ended_at, ' +
  'input_json, output_json, llm_call_id, error_code';

function rowToStep(row: ChatPipelineStepRow): ChatPipelineStep {
  return {
    id: row.id,
    runId: row.run_id,
    kind: row.kind,
    status: row.status,
    attempt: row.attempt,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    inputJson: row.input_json,
    outputJson: row.output_json,
    llmCallId: row.llm_call_id,
    errorCode: row.error_code,
  };
}

export function createChatPipelineStepsRepo(db: Database): ChatPipelineStepsRepo {
  const insert = db.query<
    unknown,
    [string, string, PipelineStepKind, PipelineStepStatus, number, string, string | null]
  >(
    `INSERT INTO chat_pipeline_steps
       (id, run_id, kind, status, attempt, started_at, input_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const findById = db.query<ChatPipelineStepRow, [string]>(
    `SELECT ${COLS} FROM chat_pipeline_steps WHERE id = ?`,
  );

  const listByRunStmt = db.query<ChatPipelineStepRow, [string]>(
    `SELECT ${COLS} FROM chat_pipeline_steps
       WHERE run_id = ?
       ORDER BY started_at ASC`,
  );

  return {
    insertStep(input) {
      insert.run(
        input.id,
        input.runId,
        input.kind,
        input.status,
        input.attempt ?? 1,
        input.startedAt,
        input.inputJson ?? null,
      );
      const row = findById.get(input.id);
      if (row === null) {
        throw new Error(
          `chat-pipeline-steps-repo: failed to read back step ${input.id} after insert`,
        );
      }
      return rowToStep(row);
    },

    getStepById(id) {
      const row = findById.get(id);
      return row === null ? null : rowToStep(row);
    },

    listByRun(runId) {
      return listByRunStmt.all(runId).map(rowToStep);
    },

    updateStep(id, patch) {
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
      if (patch.outputJson !== undefined) {
        sets.push('output_json = ?');
        params.push(patch.outputJson);
      }
      if (patch.inputJson !== undefined) {
        sets.push('input_json = ?');
        params.push(patch.inputJson);
      }
      if (patch.llmCallId !== undefined) {
        sets.push('llm_call_id = ?');
        params.push(patch.llmCallId);
      }
      if (patch.errorCode !== undefined) {
        sets.push('error_code = ?');
        params.push(patch.errorCode);
      }
      if (sets.length === 0) {
        const existing = findById.get(id);
        if (existing === null) {
          throw new Error(`chat-pipeline-steps-repo: step ${id} not found`);
        }
        return rowToStep(existing);
      }
      const sql = `UPDATE chat_pipeline_steps SET ${sets.join(', ')} WHERE id = ?`;
      params.push(id);
      db.query<unknown, typeof params>(sql).run(...params);
      const row = findById.get(id);
      if (row === null) {
        throw new Error(`chat-pipeline-steps-repo: step ${id} not found after update`);
      }
      return rowToStep(row);
    },
  };
}
