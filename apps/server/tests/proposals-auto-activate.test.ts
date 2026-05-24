import { describe, expect, it } from 'bun:test';
import { AutoActivationDecisionSchema } from '@bunny2/shared';
import {
  evaluateAutoActivation,
  type EvaluateAutoActivationInput,
} from '../src/proposals/auto-activate';
import type { ImprovementProposalRow } from '../src/proposals/repos/improvement-proposals-repo';
import type { LayerProposalSettings } from '../src/proposals/repos/layer-proposal-settings-repo';
import type { VariantMetrics } from '../src/proposals/sandbox/metrics';

/**
 * Phase 8.2 — fixture-driven tests for the pure
 * `evaluateAutoActivation` gate function.
 *
 * Each test reaches into `makeFixture(overrides)` and tweaks the
 * single field the gate under test depends on; the helper produces
 * a baseline where every gate would otherwise pass so the test
 * focuses solely on the rejection (or pass) under exam.
 *
 * Cooldown is fixed at 1 hour and `now` is fixed at minted_at + 1h
 * so the cooldown gate sits exactly on the boundary by default.
 * Tests that want pre-cooldown shift `now` backwards.
 */

const LAYER_ID = '11111111-1111-1111-1111-111111111111';
const PROPOSAL_ID = '22222222-2222-2222-2222-222222222222';
const USER_ID = '33333333-3333-3333-3333-333333333333';
const MINTED_AT_ISO = '2026-05-01T00:00:00.000Z';
const NOW_AT_BOUNDARY = new Date('2026-05-01T01:00:00.000Z'); // mintedAt + 1h
const MS_PER_HOUR = 60 * 60 * 1000;

interface FixtureOverrides {
  readonly proposal?: Partial<ImprovementProposalRow>;
  readonly proposedMetrics?: VariantMetrics | null;
  readonly currentMetrics?: VariantMetrics | null;
  readonly settings?: Partial<LayerProposalSettings>;
  readonly now?: Date;
}

function baseProposal(): ImprovementProposalRow {
  return {
    id: PROPOSAL_ID,
    layerId: LAYER_ID,
    status: 'new',
    artifactKind: 'skill',
    problemSummary: 'fixture',
    proposedSpecJson: '{}',
    expectedImpactJson: '{}',
    threshold: 0.9,
    capabilitySnapshotJson: '{}',
    mintedByRunId: 'run-1',
    mintedAt: MINTED_AT_ISO,
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectedReason: null,
    activatedAt: null,
    deletedAt: null,
    deletedBy: null,
    autoActivatedBy: null,
    autoActivatedAt: null,
    autoActivationDecisionJson: null,
    rolledBackAt: null,
    rolledBackBy: null,
    rolledBackReason: null,
  };
}

function baseSettings(): LayerProposalSettings {
  return {
    layerId: LAYER_ID,
    autoActivationEnabled: true,
    thresholdCutoff: 0.5,
    cooldownHours: 1,
    requireThumbsUpDeltaPositive: true,
    maxTokensDelta: 200,
    updatedAt: '2026-05-01T00:00:00.000Z',
    updatedBy: USER_ID,
  };
}

function baseProposedMetrics(): VariantMetrics {
  return {
    tokensIn: 110,
    tokensOut: 50,
    latencyMs: 200,
    thumbsScore: 5,
    sandboxOutcome: 'ok',
  };
}

function baseCurrentMetrics(): VariantMetrics {
  return {
    tokensIn: 100,
    tokensOut: 50,
    latencyMs: 200,
    thumbsScore: 4, // proposed - current = +1 thumbs delta
    sandboxOutcome: 'ok',
  };
}

function makeFixture(overrides: FixtureOverrides = {}): EvaluateAutoActivationInput {
  return {
    proposal: { ...baseProposal(), ...overrides.proposal },
    proposedMetrics:
      overrides.proposedMetrics === undefined ? baseProposedMetrics() : overrides.proposedMetrics,
    currentMetrics:
      overrides.currentMetrics === undefined ? baseCurrentMetrics() : overrides.currentMetrics,
    settings: { ...baseSettings(), ...overrides.settings },
    now: overrides.now ?? NOW_AT_BOUNDARY,
  };
}

describe('evaluateAutoActivation', () => {
  it('rejects with auto-activation-disabled when the setting is off (short-circuits before any other gate)', () => {
    const decision = evaluateAutoActivation(
      makeFixture({ settings: { autoActivationEnabled: false } }),
    );

    expect(decision.outcome).toBe('rejected');
    if (decision.outcome !== 'rejected') throw new Error('unreachable');
    expect(decision.reason).toBe('auto-activation-disabled');
    expect(decision.gates).toHaveLength(1);
    expect(decision.gates[0]?.name).toBe('auto-activation-disabled');
    expect(decision.gates[0]?.passed).toBe(false);
  });

  it('rejects with cooldown-not-elapsed when now is before mintedAt + cooldownHours', () => {
    // 23 hours after minted_at, with cooldown = 24 hours.
    const decision = evaluateAutoActivation(
      makeFixture({
        settings: { cooldownHours: 24 },
        now: new Date(Date.parse(MINTED_AT_ISO) + 23 * MS_PER_HOUR),
      }),
    );

    expect(decision.outcome).toBe('rejected');
    if (decision.outcome !== 'rejected') throw new Error('unreachable');
    expect(decision.reason).toBe('cooldown-not-elapsed');
    expect(decision.gates).toHaveLength(2);
    expect(decision.gates.map((g) => g.name)).toEqual([
      'auto-activation-disabled',
      'cooldown-not-elapsed',
    ]);
    expect(decision.gates[1]?.passed).toBe(false);
  });

  it('rejects with threshold-below-cutoff when proposal.threshold < settings.thresholdCutoff', () => {
    const decision = evaluateAutoActivation(
      makeFixture({ proposal: { threshold: 0.4 }, settings: { thresholdCutoff: 0.5 } }),
    );

    expect(decision.outcome).toBe('rejected');
    if (decision.outcome !== 'rejected') throw new Error('unreachable');
    expect(decision.reason).toBe('threshold-below-cutoff');
    expect(decision.gates).toHaveLength(3);
    expect(decision.gates[2]?.detail).toEqual({ threshold: 0.4, cutoff: 0.5 });
  });

  it('rejects with no-sandbox-evidence when proposedMetrics is null', () => {
    const decision = evaluateAutoActivation(makeFixture({ proposedMetrics: null }));

    expect(decision.outcome).toBe('rejected');
    if (decision.outcome !== 'rejected') throw new Error('unreachable');
    expect(decision.reason).toBe('no-sandbox-evidence');
    expect(decision.gates).toHaveLength(4);
    expect(decision.gates[3]?.detail).toEqual({ proposedPresent: false, currentPresent: true });
  });

  it('rejects with no-sandbox-evidence when currentMetrics is null (runner corruption signal)', () => {
    const decision = evaluateAutoActivation(makeFixture({ currentMetrics: null }));

    expect(decision.outcome).toBe('rejected');
    if (decision.outcome !== 'rejected') throw new Error('unreachable');
    expect(decision.reason).toBe('no-sandbox-evidence');
    expect(decision.gates).toHaveLength(4);
    expect(decision.gates[3]?.detail).toEqual({ proposedPresent: true, currentPresent: false });
  });

  it('rejects with sandbox-outcome-not-ok when proposedMetrics.sandboxOutcome is timeout', () => {
    const decision = evaluateAutoActivation(
      makeFixture({
        proposedMetrics: { ...baseProposedMetrics(), sandboxOutcome: 'timeout' },
      }),
    );

    expect(decision.outcome).toBe('rejected');
    if (decision.outcome !== 'rejected') throw new Error('unreachable');
    expect(decision.reason).toBe('sandbox-outcome-not-ok');
    expect(decision.gates).toHaveLength(5);
    expect(decision.gates[4]?.detail).toEqual({ sandboxOutcome: 'timeout' });
  });

  it('rejects with thumbs-up-delta-non-positive when delta is zero and the setting is on', () => {
    // proposed.thumbsScore == current.thumbsScore → delta = 0.
    const decision = evaluateAutoActivation(
      makeFixture({
        proposedMetrics: { ...baseProposedMetrics(), thumbsScore: 4 },
        currentMetrics: { ...baseCurrentMetrics(), thumbsScore: 4 },
      }),
    );

    expect(decision.outcome).toBe('rejected');
    if (decision.outcome !== 'rejected') throw new Error('unreachable');
    expect(decision.reason).toBe('thumbs-up-delta-non-positive');
    expect(decision.gates).toHaveLength(6);
    expect(decision.gates[5]?.detail).toEqual({ thumbsUpDelta: 0 });
  });

  it('skips the thumbs-up-delta gate (passes with skipped: true) when the setting is disabled', () => {
    const decision = evaluateAutoActivation(
      makeFixture({
        settings: { requireThumbsUpDeltaPositive: false },
        proposedMetrics: { ...baseProposedMetrics(), thumbsScore: 4 },
        currentMetrics: { ...baseCurrentMetrics(), thumbsScore: 4 },
        // Keep tokens-delta gate happy: max tokens delta is 200, base
        // tokens-delta is +10, so the eligible path lands here.
      }),
    );

    expect(decision.outcome).toBe('eligible');
    const gate6 = decision.gates[5];
    expect(gate6?.name).toBe('thumbs-up-delta-non-positive');
    expect(gate6?.passed).toBe(true);
    expect(gate6?.detail).toEqual({ skipped: true, reason: 'setting-disabled' });
  });

  it('rejects with tokens-delta-over-cap when proposed tokens delta exceeds settings.maxTokensDelta', () => {
    // proposed.tokensIn - current.tokensIn = 150 + tokensOut delta 0,
    // total tokens delta = 150 > cap 100.
    const decision = evaluateAutoActivation(
      makeFixture({
        settings: { maxTokensDelta: 100 },
        proposedMetrics: { ...baseProposedMetrics(), tokensIn: 250 },
        currentMetrics: { ...baseCurrentMetrics(), tokensIn: 100 },
      }),
    );

    expect(decision.outcome).toBe('rejected');
    if (decision.outcome !== 'rejected') throw new Error('unreachable');
    expect(decision.reason).toBe('tokens-delta-over-cap');
    expect(decision.gates).toHaveLength(7);
    expect(decision.gates[6]?.detail).toEqual({ tokensDelta: 150, cap: 100 });
  });

  it('skips the tokens-delta gate (passes with skipped: true) when maxTokensDelta is null', () => {
    const decision = evaluateAutoActivation(
      makeFixture({
        settings: { maxTokensDelta: null },
        // Even an arbitrarily large tokens delta would pass when the
        // cap is null — pin that behavior.
        proposedMetrics: { ...baseProposedMetrics(), tokensIn: 10_000 },
        currentMetrics: { ...baseCurrentMetrics(), tokensIn: 100 },
      }),
    );

    expect(decision.outcome).toBe('eligible');
    const gate7 = decision.gates[6];
    expect(gate7?.name).toBe('tokens-delta-over-cap');
    expect(gate7?.passed).toBe(true);
    expect(gate7?.detail).toEqual({ skipped: true, reason: 'setting-disabled' });
  });

  it('returns eligible with all seven gates passing and no skipped markers when every gate fires', () => {
    const decision = evaluateAutoActivation(makeFixture());

    expect(decision.outcome).toBe('eligible');
    expect(decision.gates).toHaveLength(7);
    for (const gate of decision.gates) {
      expect(gate.passed).toBe(true);
      expect(gate.detail?.skipped).toBeUndefined();
    }
    expect(decision.gates.map((g) => g.name)).toEqual([
      'auto-activation-disabled',
      'cooldown-not-elapsed',
      'threshold-below-cutoff',
      'no-sandbox-evidence',
      'sandbox-outcome-not-ok',
      'thumbs-up-delta-non-positive',
      'tokens-delta-over-cap',
    ]);

    // Boundary — cooldown exactly elapsed (delta = 0 ms) passes.
    const exact = evaluateAutoActivation(
      makeFixture({ now: new Date(Date.parse(MINTED_AT_ISO) + 1 * MS_PER_HOUR) }),
    );
    expect(exact.outcome).toBe('eligible');

    // Boundary — cooldown elapsed minus 1 ms fails.
    const oneMsShort = evaluateAutoActivation(
      makeFixture({ now: new Date(Date.parse(MINTED_AT_ISO) + 1 * MS_PER_HOUR - 1) }),
    );
    expect(oneMsShort.outcome).toBe('rejected');
    if (oneMsShort.outcome !== 'rejected') throw new Error('unreachable');
    expect(oneMsShort.reason).toBe('cooldown-not-elapsed');

    // Boundary — threshold exactly equal to cutoff passes.
    const eqThreshold = evaluateAutoActivation(
      makeFixture({ proposal: { threshold: 0.5 }, settings: { thresholdCutoff: 0.5 } }),
    );
    expect(eqThreshold.outcome).toBe('eligible');

    // Boundary — threshold below cutoff by a hair fails.
    const justBelow = evaluateAutoActivation(
      makeFixture({ proposal: { threshold: 0.4999 }, settings: { thresholdCutoff: 0.5 } }),
    );
    expect(justBelow.outcome).toBe('rejected');
    if (justBelow.outcome !== 'rejected') throw new Error('unreachable');
    expect(justBelow.reason).toBe('threshold-below-cutoff');

    // Final assertion: the decision JSON round-trips through the
    // shared zod schema cleanly.
    expect(() => AutoActivationDecisionSchema.parse(decision)).not.toThrow();
  });
});
