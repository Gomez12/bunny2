import type { Database } from 'bun:sqlite';

/**
 * One persisted LLM-call row, matching `apps/server/src/storage/migrations/0001_init.sql`.
 *
 * Field naming on the write API uses camelCase; the writer maps to the
 * snake_case columns the schema declares.
 */
export interface LlmCallRow {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly model: string;
  readonly endpoint: string;
  readonly request: string; // already-stringified JSON
  readonly response: string | null; // already-stringified JSON
  readonly tokensIn: number | null;
  readonly tokensOut: number | null;
  readonly costUsd: number | null;
  readonly latencyMs: number | null;
  readonly correlationId: string | null;
  readonly flowId: string | null;
  readonly layerId: string | null;
  readonly userId: string | null;
  readonly error: string | null;
  /**
   * Per-layer chat model follow-up — records whether the model used
   * was the system default or a per-layer override. `null` for
   * historical rows + for callers that do not stamp
   * `metadata.modelSource`. The migration backfills existing rows
   * to `'system'` so downstream group-by queries are honest.
   */
  readonly modelSource: 'system' | 'layer' | null;
}

export interface LlmCallLog {
  write(row: LlmCallRow): void;
  count(): number;
  /** Returns the row for a given id, or null when no such row exists. */
  getById(id: string): LlmCallRow | null;
  /** Returns the number of rows deleted. */
  pruneOlderThan(cutoff: Date): number;
}

/**
 * SQLite-backed writer for the `llm_calls` table. Mirrors the shape of
 * `apps/server/src/bus/event-log.ts` so the two telemetry sinks stay
 * structurally consistent.
 */
export function createSqliteLlmCallLog(db: Database): LlmCallLog {
  const insert = db.query<
    unknown,
    [
      string,
      string,
      string | null,
      string,
      string,
      string,
      string | null,
      number | null,
      number | null,
      number | null,
      number | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ]
  >(
    `INSERT INTO llm_calls
       (id, started_at, ended_at, model, endpoint, request, response,
        tokens_in, tokens_out, cost_usd, latency_ms,
        correlation_id, flow_id, layer_id, user_id, error, model_source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const countStmt = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM llm_calls');

  interface LlmCallSqlRow {
    id: string;
    started_at: string;
    ended_at: string | null;
    model: string;
    endpoint: string;
    request: string;
    response: string | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_usd: number | null;
    latency_ms: number | null;
    correlation_id: string | null;
    flow_id: string | null;
    layer_id: string | null;
    user_id: string | null;
    error: string | null;
    model_source: 'system' | 'layer' | null;
  }

  const findById = db.query<LlmCallSqlRow, [string]>(
    `SELECT id, started_at, ended_at, model, endpoint, request, response,
            tokens_in, tokens_out, cost_usd, latency_ms,
            correlation_id, flow_id, layer_id, user_id, error, model_source
       FROM llm_calls
       WHERE id = ?`,
  );

  const deleteOld = db.query<unknown, [string]>('DELETE FROM llm_calls WHERE started_at < ?');

  return {
    write(row: LlmCallRow): void {
      insert.run(
        row.id,
        row.startedAt,
        row.endedAt,
        row.model,
        row.endpoint,
        row.request,
        row.response,
        row.tokensIn,
        row.tokensOut,
        row.costUsd,
        row.latencyMs,
        row.correlationId,
        row.flowId,
        row.layerId,
        row.userId,
        row.error,
        row.modelSource,
      );
    },
    count(): number {
      return countStmt.get()?.n ?? 0;
    },
    getById(id: string): LlmCallRow | null {
      const row = findById.get(id);
      if (row === null) return null;
      return {
        id: row.id,
        startedAt: row.started_at,
        endedAt: row.ended_at,
        model: row.model,
        endpoint: row.endpoint,
        request: row.request,
        response: row.response,
        tokensIn: row.tokens_in,
        tokensOut: row.tokens_out,
        costUsd: row.cost_usd,
        latencyMs: row.latency_ms,
        correlationId: row.correlation_id,
        flowId: row.flow_id,
        layerId: row.layer_id,
        userId: row.user_id,
        error: row.error,
        modelSource: row.model_source,
      };
    },
    pruneOlderThan(cutoff: Date): number {
      const before = countStmt.get()?.n ?? 0;
      deleteOld.run(cutoff.toISOString());
      const after = countStmt.get()?.n ?? 0;
      return Math.max(0, before - after);
    },
  };
}
