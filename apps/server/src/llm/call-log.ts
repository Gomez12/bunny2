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
}

export interface LlmCallLog {
  write(row: LlmCallRow): void;
  count(): number;
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
    ]
  >(
    `INSERT INTO llm_calls
       (id, started_at, ended_at, model, endpoint, request, response,
        tokens_in, tokens_out, cost_usd, latency_ms,
        correlation_id, flow_id, layer_id, user_id, error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const countStmt = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM llm_calls');

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
      );
    },
    count(): number {
      return countStmt.get()?.n ?? 0;
    },
    pruneOlderThan(cutoff: Date): number {
      const before = countStmt.get()?.n ?? 0;
      deleteOld.run(cutoff.toISOString());
      const after = countStmt.get()?.n ?? 0;
      return Math.max(0, before - after);
    },
  };
}
