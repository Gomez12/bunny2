/**
 * Phase 8.2 — pure auto-activation gate function.
 *
 * Consumes the audit-trail columns + settings shipped in 8.1 and
 * returns the decision JSON that the auto-activate job (lands in
 * 8.3) will persist via
 * `improvementProposalsRepo.recordAutoActivationDecision(...)`.
 *
 * The function is intentionally pure (no clock, no I/O, no DB, no
 * LLM): the caller resolves the proposal row, the per-variant
 * sandbox metrics, and the resolved layer settings, then injects
 * `now` for determinism. Cheapest-first gate ordering (ADR 0026
 * decision 1) lets the hourly job skip ineligible proposals without
 * ever reading the artifact rows.
 *
 * Data-shape note: the runner writes per-variant `VariantMetrics`
 * (no delta fields) in pairs — one `current` + one `proposed` per
 * proposal. This function takes both already-parsed metrics objects
 * and derives the thumbs / tokens deltas via `computeDelta(...)`
 * from `./sandbox/metrics` so the storage shape stays untouched and
 * the existing delta math is the single source of truth. A missing
 * `current` (or `proposed`) signals corruption rather than "no
 * baseline" — the runner always writes them together — so gate 4
 * rejects with `no-sandbox-evidence` regardless of which side is
 * null.
 */

import type {
  AutoActivationDecision,
  AutoActivationGateRecord,
  AutoActivationRejection,
} from '@bunny2/shared';
import type { ImprovementProposalRow } from './repos/improvement-proposals-repo';
import type { LayerProposalSettings } from './repos/layer-proposal-settings-repo';
import { computeDelta, type VariantMetrics } from './sandbox/metrics';

export interface EvaluateAutoActivationInput {
  readonly proposal: ImprovementProposalRow;
  /**
   * Already-parsed `VariantMetrics` from the `proposed` artifact's
   * `metrics_json`. `null` when the row is missing — the caller in
   * 8.3 looks the artifact up and parses the JSON; this function
   * stays I/O-free.
   */
  readonly proposedMetrics: VariantMetrics | null;
  /**
   * Already-parsed `VariantMetrics` from the `current` artifact's
   * `metrics_json`. `null` is treated as a corruption signal — the
   * runner always writes the pair together (see header note).
   */
  readonly currentMetrics: VariantMetrics | null;
  readonly settings: LayerProposalSettings;
  /**
   * Injected for determinism — the gate never reads the process
   * clock. The caller in 8.3 passes `ctx.now()` from the
   * scheduled-task harness; tests pass a fixed `Date`.
   */
  readonly now: Date;
}

/**
 * Gate names mirror the `AutoActivationRejection` enum verbatim
 * (ADR 0026 §1). The closed enum is the public contract surface —
 * tests + telemetry depend on these exact strings.
 */
type GateName = AutoActivationRejection;

const GATE_NAMES: readonly GateName[] = [
  'auto-activation-disabled',
  'cooldown-not-elapsed',
  'threshold-below-cutoff',
  'no-sandbox-evidence',
  'sandbox-outcome-not-ok',
  'thumbs-up-delta-non-positive',
  'tokens-delta-over-cap',
] as const;

const MS_PER_HOUR = 60 * 60 * 1000;

export function evaluateAutoActivation(input: EvaluateAutoActivationInput): AutoActivationDecision {
  const { proposal, proposedMetrics, currentMetrics, settings, now } = input;
  const gates: AutoActivationGateRecord[] = [];

  // Gate 1 — auto-activation-disabled. Cheapest possible check;
  // disables the entire layer in one boolean read.
  const enabled = settings.autoActivationEnabled;
  if (!enabled) {
    gates.push({
      name: 'auto-activation-disabled',
      passed: false,
      detail: { autoActivationEnabled: false },
    });
    return rejected('auto-activation-disabled', gates);
  }
  gates.push({
    name: 'auto-activation-disabled',
    passed: true,
    detail: { autoActivationEnabled: true },
  });

  // Gate 2 — cooldown-not-elapsed. ISO-timestamp parse via
  // `Date.parse`; the boundary is `>=` so equal-to-the-millisecond
  // passes (pinned by tests against the §11 risk row).
  const mintedAtMs = Date.parse(proposal.mintedAt);
  const nowMs = now.getTime();
  const deltaMs = nowMs - mintedAtMs;
  const requiredMs = settings.cooldownHours * MS_PER_HOUR;
  const deltaHours = deltaMs / MS_PER_HOUR;
  if (deltaMs < requiredMs) {
    gates.push({
      name: 'cooldown-not-elapsed',
      passed: false,
      detail: {
        cooldownHours: settings.cooldownHours,
        mintedAt: proposal.mintedAt,
        nowIso: now.toISOString(),
        deltaHours,
      },
    });
    return rejected('cooldown-not-elapsed', gates);
  }
  gates.push({
    name: 'cooldown-not-elapsed',
    passed: true,
    detail: {
      cooldownHours: settings.cooldownHours,
      mintedAt: proposal.mintedAt,
      nowIso: now.toISOString(),
      deltaHours,
    },
  });

  // Gate 3 — threshold-below-cutoff. Boundary `>=` (equal passes).
  if (proposal.threshold < settings.thresholdCutoff) {
    gates.push({
      name: 'threshold-below-cutoff',
      passed: false,
      detail: { threshold: proposal.threshold, cutoff: settings.thresholdCutoff },
    });
    return rejected('threshold-below-cutoff', gates);
  }
  gates.push({
    name: 'threshold-below-cutoff',
    passed: true,
    detail: { threshold: proposal.threshold, cutoff: settings.thresholdCutoff },
  });

  // Gate 4 — no-sandbox-evidence. The runner writes the
  // `current` + `proposed` pair together; either being null is a
  // corruption signal that the gate refuses to interpret as a
  // "no baseline" pass (see header note).
  if (proposedMetrics === null || currentMetrics === null) {
    gates.push({
      name: 'no-sandbox-evidence',
      passed: false,
      detail: {
        proposedPresent: proposedMetrics !== null,
        currentPresent: currentMetrics !== null,
      },
    });
    return rejected('no-sandbox-evidence', gates);
  }
  gates.push({
    name: 'no-sandbox-evidence',
    passed: true,
    detail: { proposedPresent: true, currentPresent: true },
  });

  // Gate 5 — sandbox-outcome-not-ok. The proposed variant is what's
  // being activated; per ADR 0026 §1 we do NOT also fail on the
  // current variant's outcome (it's only a baseline).
  if (proposedMetrics.sandboxOutcome !== 'ok') {
    gates.push({
      name: 'sandbox-outcome-not-ok',
      passed: false,
      detail: { sandboxOutcome: proposedMetrics.sandboxOutcome },
    });
    return rejected('sandbox-outcome-not-ok', gates);
  }
  gates.push({
    name: 'sandbox-outcome-not-ok',
    passed: true,
    detail: { sandboxOutcome: proposedMetrics.sandboxOutcome },
  });

  // Compute the delta once for the two remaining gates. The math
  // lives in `./sandbox/metrics` and is already pinned by
  // `proposals-sandbox-metrics.test.ts`.
  const delta = computeDelta(currentMetrics, proposedMetrics);

  // Gate 6 — thumbs-up-delta-non-positive. Skipped when the setting
  // is off; the gate still emits a `passed: true` record carrying
  // `skipped: true` so the UI can render "this gate was inactive
  // for this proposal".
  if (!settings.requireThumbsUpDeltaPositive) {
    gates.push({
      name: 'thumbs-up-delta-non-positive',
      passed: true,
      detail: { skipped: true, reason: 'setting-disabled' },
    });
  } else if (delta.thumbsUpDelta > 0) {
    gates.push({
      name: 'thumbs-up-delta-non-positive',
      passed: true,
      detail: { thumbsUpDelta: delta.thumbsUpDelta },
    });
  } else {
    gates.push({
      name: 'thumbs-up-delta-non-positive',
      passed: false,
      detail: { thumbsUpDelta: delta.thumbsUpDelta },
    });
    return rejected('thumbs-up-delta-non-positive', gates);
  }

  // Gate 7 — tokens-delta-over-cap. Skipped when the cap is null.
  if (settings.maxTokensDelta === null) {
    gates.push({
      name: 'tokens-delta-over-cap',
      passed: true,
      detail: { skipped: true, reason: 'setting-disabled' },
    });
  } else if (delta.tokensDelta <= settings.maxTokensDelta) {
    gates.push({
      name: 'tokens-delta-over-cap',
      passed: true,
      detail: { tokensDelta: delta.tokensDelta, cap: settings.maxTokensDelta },
    });
  } else {
    gates.push({
      name: 'tokens-delta-over-cap',
      passed: false,
      detail: { tokensDelta: delta.tokensDelta, cap: settings.maxTokensDelta },
    });
    return rejected('tokens-delta-over-cap', gates);
  }

  // All seven passed.
  return { outcome: 'eligible', gates };
}

function rejected(
  reason: AutoActivationRejection,
  gates: AutoActivationGateRecord[],
): AutoActivationDecision {
  return { outcome: 'rejected', reason, gates };
}

/** Public for tests / 8.3 wiring; mirrors the closed enum order. */
export const AUTO_ACTIVATION_GATE_NAMES = GATE_NAMES;

/**
 * Phase 8.3 — the fixed literal string the auto-activate path passes
 * as `approvedBy` to `replanOnApproval(...)`. The replan path branches
 * on `actorKind: 'system'` and never writes this value to the
 * `users(id)`-backed `approved_by` column; it lands in
 * `improvement_proposals.auto_activated_by` instead via
 * `proposalsRepo.recordAutoActivation(...)`. See ADR 0026 decision 3.
 */
export const SYSTEM_ACTOR = 'system' as const;
