import type { Database } from 'bun:sqlite';

/**
 * Daily embedding-token counters per layer.
 *
 * One row per `(layer_id, day)` where `day = YYYY-MM-DD` UTC.
 * `tokens_spent` is monotonically increasing within a day — the
 * embedding subscriber upserts after each successful encode using
 * the embedder's reported token count or a `chars/4` estimate.
 *
 * Read patterns:
 *  - daily cap: `getDayTokens(layerId, day)` — exact match on the
 *    PRIMARY KEY.
 *  - monthly cap: `sumLastDays(layerId, days)` — `SUM(tokens_spent)`
 *    over the last N rows for the layer.
 */

export interface LayerEmbeddingSpendRepo {
  /** Tokens spent for the given (layerId, day). 0 when no row exists. */
  getDayTokens(layerId: string, day: string): number;
  /** Sum of tokens_spent over the last `days` calendar days, inclusive of today. */
  sumLastDays(layerId: string, today: string, days: number): number;
  /** Adds `delta` tokens to today's bucket. Inserts a row when none exists. */
  addTokens(layerId: string, day: string, delta: number): void;
}

export function createLayerEmbeddingSpendRepo(db: Database): LayerEmbeddingSpendRepo {
  const getStmt = db.query<{ tokens_spent: number }, [string, string]>(
    `SELECT tokens_spent FROM layer_embedding_spend WHERE layer_id = ? AND day = ?`,
  );

  // ON CONFLICT incrementally adds to the existing counter.
  const upsertStmt = db.query<unknown, [string, string, number, number]>(
    `INSERT INTO layer_embedding_spend (layer_id, day, tokens_spent)
     VALUES (?, ?, ?)
     ON CONFLICT(layer_id, day) DO UPDATE
       SET tokens_spent = tokens_spent + ?`,
  );

  const sumStmt = db.query<{ total: number | null }, [string, string]>(
    `SELECT SUM(tokens_spent) AS total FROM layer_embedding_spend
       WHERE layer_id = ? AND day >= ?`,
  );

  return {
    getDayTokens(layerId, day) {
      const row = getStmt.get(layerId, day);
      return row === null ? 0 : Number(row.tokens_spent);
    },

    sumLastDays(layerId, today, days) {
      if (days <= 0) return 0;
      const todayMs = Date.parse(`${today}T00:00:00.000Z`);
      if (!Number.isFinite(todayMs)) return 0;
      const fromMs = todayMs - (days - 1) * 24 * 60 * 60 * 1000;
      const fromDay = new Date(fromMs).toISOString().slice(0, 10);
      const row = sumStmt.get(layerId, fromDay);
      return row === null ? 0 : Number(row.total ?? 0);
    },

    addTokens(layerId, day, delta) {
      if (delta <= 0) return;
      upsertStmt.run(layerId, day, delta, delta);
    },
  };
}

/** UTC `YYYY-MM-DD` from a Date. Pure helper, exported for reuse. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
