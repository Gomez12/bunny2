import type { Database } from 'bun:sqlite';

/**
 * Per-layer chat settings.
 *
 * One row per layer when the admin has chosen overrides; absent row
 * means "inherit the system default for every field". `model` is the
 * chat LLM to use for router / resolver / answerer steps; the
 * embedding caps are enforced by the embedding subscriber before
 * encode.
 *
 * NULL on any individual field means "inherit the system default for
 * THAT field" — a layer may pin the model without picking caps and
 * vice versa.
 */

export interface LayerChatSettings {
  readonly layerId: string;
  readonly model: string | null;
  readonly embeddingDailyCap: number | null;
  readonly embeddingMonthlyCap: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface UpsertLayerChatSettingsInput {
  readonly layerId: string;
  readonly model: string | null;
  readonly embeddingDailyCap: number | null;
  readonly embeddingMonthlyCap: number | null;
  readonly now: string;
}

interface SqlRow {
  layer_id: string;
  model: string | null;
  embedding_daily_cap: number | null;
  embedding_monthly_cap: number | null;
  created_at: string;
  updated_at: string;
}

const COLS = 'layer_id, model, embedding_daily_cap, embedding_monthly_cap, created_at, updated_at';

function rowToSettings(row: SqlRow): LayerChatSettings {
  return {
    layerId: row.layer_id,
    model: row.model,
    embeddingDailyCap: row.embedding_daily_cap,
    embeddingMonthlyCap: row.embedding_monthly_cap,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface LayerChatSettingsRepo {
  find(layerId: string): LayerChatSettings | null;
  upsert(input: UpsertLayerChatSettingsInput): LayerChatSettings;
}

export function createLayerChatSettingsRepo(db: Database): LayerChatSettingsRepo {
  const findStmt = db.query<SqlRow, [string]>(
    `SELECT ${COLS} FROM layer_chat_settings WHERE layer_id = ?`,
  );

  const upsertStmt = db.query<
    unknown,
    [string, string | null, number | null, number | null, string, string]
  >(
    `INSERT INTO layer_chat_settings
       (layer_id, model, embedding_daily_cap, embedding_monthly_cap, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(layer_id) DO UPDATE
       SET model                 = excluded.model,
           embedding_daily_cap   = excluded.embedding_daily_cap,
           embedding_monthly_cap = excluded.embedding_monthly_cap,
           updated_at            = excluded.updated_at`,
  );

  return {
    find(layerId: string): LayerChatSettings | null {
      const row = findStmt.get(layerId);
      return row === null ? null : rowToSettings(row);
    },

    upsert(input: UpsertLayerChatSettingsInput): LayerChatSettings {
      upsertStmt.run(
        input.layerId,
        input.model,
        input.embeddingDailyCap,
        input.embeddingMonthlyCap,
        input.now,
        input.now,
      );
      const row = findStmt.get(input.layerId);
      if (row === null) {
        throw new Error(
          `layer-chat-settings-repo: failed to read back settings for layer ${input.layerId} after upsert`,
        );
      }
      return rowToSettings(row);
    },
  };
}
