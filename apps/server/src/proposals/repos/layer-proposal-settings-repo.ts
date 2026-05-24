import type { Database } from 'bun:sqlite';

/**
 * Phase 8.1 — repository over `layer_proposal_settings`.
 *
 * One row per layer holds the four tunable knobs the auto-activate
 * gate ([ADR 0026](../../../../../docs/dev/decisions/0026-auto-activation-gating.md))
 * consumes, plus audit (`updated_at`, `updated_by`). Plan §4.1 says
 * absent row = "auto-activation disabled, cutoff 1.0, cooldown 24h,
 * thumbs-up-delta required, no token cap"; `getOrDefault` resolves
 * those defaults so callers never need to branch on NULL.
 *
 * The defaults constant is exported beside the repo so the gate
 * function (lands in 8.2) and the integration tests can reuse the
 * same baseline.
 */

export interface LayerProposalSettings {
  readonly layerId: string;
  readonly autoActivationEnabled: boolean;
  /** [0, 1] — CHECK-constrained at the DB; zod mirrors it. */
  readonly thresholdCutoff: number;
  /** [0, 720] hours — CHECK-constrained at the DB; zod mirrors it. */
  readonly cooldownHours: number;
  readonly requireThumbsUpDeltaPositive: boolean;
  /** null = no cap; non-null is `>= 0` (CHECK-constrained at the DB). */
  readonly maxTokensDelta: number | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface UpsertLayerProposalSettingsInput {
  readonly layerId: string;
  readonly autoActivationEnabled: boolean;
  readonly thresholdCutoff: number;
  readonly cooldownHours: number;
  readonly requireThumbsUpDeltaPositive: boolean;
  readonly maxTokensDelta: number | null;
  readonly updatedBy: string;
  /** Injected ISO timestamp — keeps the repo clock-free for tests. */
  readonly now: string;
}

interface SqlRow {
  layer_id: string;
  auto_activation_enabled: number;
  threshold_cutoff: number;
  cooldown_hours: number;
  require_thumbs_up_delta_positive: number;
  max_tokens_delta: number | null;
  updated_at: string;
  updated_by: string;
}

/**
 * Defaults exposed both for `getOrDefault` and for downstream
 * consumers (8.2 gate, integration tests). The `layerId`,
 * `updatedAt`, and `updatedBy` are filled in per-call; only the
 * tunable knobs sit here.
 */
export const LAYER_PROPOSAL_SETTINGS_DEFAULTS: Readonly<{
  autoActivationEnabled: boolean;
  thresholdCutoff: number;
  cooldownHours: number;
  requireThumbsUpDeltaPositive: boolean;
  maxTokensDelta: number | null;
}> = Object.freeze({
  autoActivationEnabled: false,
  thresholdCutoff: 1.0,
  cooldownHours: 24,
  requireThumbsUpDeltaPositive: true,
  maxTokensDelta: null,
});

const COLS =
  'layer_id, auto_activation_enabled, threshold_cutoff, cooldown_hours, ' +
  'require_thumbs_up_delta_positive, max_tokens_delta, updated_at, updated_by';

function rowToSettings(row: SqlRow): LayerProposalSettings {
  return {
    layerId: row.layer_id,
    autoActivationEnabled: row.auto_activation_enabled === 1,
    thresholdCutoff: row.threshold_cutoff,
    cooldownHours: row.cooldown_hours,
    requireThumbsUpDeltaPositive: row.require_thumbs_up_delta_positive === 1,
    maxTokensDelta: row.max_tokens_delta,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

export class LayerProposalSettingsRepo {
  private readonly db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  /**
   * Returns the row if present, otherwise the resolved defaults
   * (per plan §4.1). Callers — including the gate function (8.2)
   * and the GET settings route (8.4) — never see NULL.
   *
   * `updatedAt` / `updatedBy` of the default object are empty
   * strings; the GET handler tells "never set" vs "explicitly
   * default" apart via {@link find}, not this method.
   */
  getOrDefault(layerId: string): LayerProposalSettings {
    const row = this.db
      .query<SqlRow, [string]>(`SELECT ${COLS} FROM layer_proposal_settings WHERE layer_id = ?`)
      .get(layerId);
    if (row !== null) {
      return rowToSettings(row);
    }
    return {
      layerId,
      autoActivationEnabled: LAYER_PROPOSAL_SETTINGS_DEFAULTS.autoActivationEnabled,
      thresholdCutoff: LAYER_PROPOSAL_SETTINGS_DEFAULTS.thresholdCutoff,
      cooldownHours: LAYER_PROPOSAL_SETTINGS_DEFAULTS.cooldownHours,
      requireThumbsUpDeltaPositive: LAYER_PROPOSAL_SETTINGS_DEFAULTS.requireThumbsUpDeltaPositive,
      maxTokensDelta: LAYER_PROPOSAL_SETTINGS_DEFAULTS.maxTokensDelta,
      updatedAt: '',
      updatedBy: '',
    };
  }

  /**
   * Returns the row, or `null` when none exists. The GET settings
   * handler uses this to distinguish "admin has never opened the
   * page" from "admin saved the defaults explicitly" — both yield
   * the same effective values, but only the latter has a real
   * `updatedAt`.
   */
  find(layerId: string): LayerProposalSettings | null {
    const row = this.db
      .query<SqlRow, [string]>(`SELECT ${COLS} FROM layer_proposal_settings WHERE layer_id = ?`)
      .get(layerId);
    return row === null ? null : rowToSettings(row);
  }

  /**
   * Single-statement upsert via `INSERT … ON CONFLICT(layer_id) DO
   * UPDATE`. Returns the resulting row. SQL CHECK constraints
   * (cutoff in [0, 1], cooldown in [0, 720], tokens cap ≥ 0 when
   * not null) trip a thrown error here — the route layer surfaces
   * the failure as a 400 after zod has already validated the
   * input shape.
   */
  upsert(input: UpsertLayerProposalSettingsInput): LayerProposalSettings {
    const upsertStmt = this.db.query<
      unknown,
      [string, number, number, number, number, number | null, string, string]
    >(
      `INSERT INTO layer_proposal_settings
         (layer_id, auto_activation_enabled, threshold_cutoff,
          cooldown_hours, require_thumbs_up_delta_positive,
          max_tokens_delta, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(layer_id) DO UPDATE
          SET auto_activation_enabled          = excluded.auto_activation_enabled,
              threshold_cutoff                 = excluded.threshold_cutoff,
              cooldown_hours                   = excluded.cooldown_hours,
              require_thumbs_up_delta_positive = excluded.require_thumbs_up_delta_positive,
              max_tokens_delta                 = excluded.max_tokens_delta,
              updated_at                       = excluded.updated_at,
              updated_by                       = excluded.updated_by`,
    );
    upsertStmt.run(
      input.layerId,
      input.autoActivationEnabled ? 1 : 0,
      input.thresholdCutoff,
      input.cooldownHours,
      input.requireThumbsUpDeltaPositive ? 1 : 0,
      input.maxTokensDelta,
      input.now,
      input.updatedBy,
    );
    const row = this.db
      .query<SqlRow, [string]>(`SELECT ${COLS} FROM layer_proposal_settings WHERE layer_id = ?`)
      .get(input.layerId);
    if (row === null) {
      throw new Error(
        `layer-proposal-settings-repo: failed to read back settings for layer ${input.layerId} after upsert`,
      );
    }
    return rowToSettings(row);
  }
}
