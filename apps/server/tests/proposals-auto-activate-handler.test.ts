/**
 * Phase 8.3 — `proposals.auto-activate` handler integration tests.
 *
 * Drives `runAutoActivate(...)` directly with an in-memory DB, scripted
 * `replan` closure, and a deterministic `ctx.now()`. The scripted closure
 * lets us exercise:
 *
 *  1. All four `replanOnApproval` outcomes — `activated-asis`,
 *     `activated-replanned`, `superseded`, `superseded-after-replan` —
 *     and assert that each lands on the bus event payload's
 *     `outcome` field unchanged + that `recordAutoActivation` is
 *     called regardless of which outcome the replan returned
 *     (ADR 0026 §4).
 *  2. All seven `Rejection` reasons from the 8.2 gate — for each,
 *     seed the matching condition, assert the proposal stays
 *     `status='new'`, the decision JSON is written, no bus event
 *     fires, and the replan closure is NOT invoked.
 *  3. The cooldown boundary in milliseconds.
 *  4. The replan-throws path — decision JSON is written, but
 *     `auto_activated_at` is NOT set, and the handler moves on
 *     to the next proposal.
 *  5. Multi-layer iteration — only `auto_activation_enabled = true`
 *     layers are processed.
 *
 * The DB is seeded with one user, two layers (`layer-x` enabled,
 * `layer-y` disabled), and per-test proposals + artifact pairs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { openDatabase } from '../src/storage/sqlite';
import { safeRmSync } from './_helpers/temp-dir';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createImprovementProposalsRepo } from '../src/proposals/repos/improvement-proposals-repo';
import { createImprovementProposalArtifactsRepo } from '../src/proposals/repos/improvement-proposal-artifacts-repo';
import { LayerProposalSettingsRepo } from '../src/proposals/repos/layer-proposal-settings-repo';
import {
  PROPOSALS_AUTO_ACTIVATE_KIND,
  runAutoActivate,
  type ProposalsAutoActivateDeps,
} from '../src/proposals/auto-activate-handler';
import {
  PROPOSAL_AUTO_ACTIVATED_EVENT_TYPE,
  type ProposalAutoActivatedPayload,
} from '../src/proposals/events';
import type { ScheduledTaskHandlerLogger, ScheduledTaskRunContext } from '../src/scheduled';
import type { ReplanOutcome } from '../src/proposals/replan';
import type { ScheduledTask, ScheduledTaskRun } from '../src/scheduled/repo';
import type { VariantMetrics } from '../src/proposals/sandbox/metrics';

const USER_ID = '33333333-3333-3333-3333-333333333333';
const LAYER_X = '11111111-1111-1111-1111-111111111111';
const LAYER_Y = '22222222-2222-2222-2222-222222222222';
const TASK_ID = 'task-auto-activate-id';

let dir: string;
let db: Database;
let bus: InMemoryMessageBus;

const noopLogger: ScheduledTaskHandlerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-auto-activate-handler-'));
  db = openDatabase(dir);
  bus = new InMemoryMessageBus();
  const nowIso = new Date('2026-05-24T00:00:00.000Z').toISOString();
  db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO users
       (id, username, display_name, password_hash, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(USER_ID, 'alice', 'Alice', 'h', nowIso, nowIso);
  db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
     VALUES (?, 'everyone', ?, ?, ?, ?)`,
  ).run(LAYER_X, 'layer-x', 'Layer X', nowIso, nowIso);
  db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
     VALUES (?, 'everyone', ?, ?, ?, ?)`,
  ).run(LAYER_Y, 'layer-y', 'Layer Y', nowIso, nowIso);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already */
  }
  try {
    safeRmSync(dir);
  } catch {
    /* best-effort */
  }
});

function variantMetrics(overrides: Partial<VariantMetrics> = {}): VariantMetrics {
  return {
    tokensIn: 100,
    tokensOut: 50,
    latencyMs: 200,
    thumbsScore: 0,
    sandboxOutcome: 'ok',
    ...overrides,
  };
}

interface SeedProposalOpts {
  readonly layerId?: string;
  readonly threshold?: number;
  readonly mintedAt?: string;
  readonly status?: 'new' | 'rejected' | 'superseded' | 'activated';
  readonly proposedMetrics?: VariantMetrics | null;
  readonly currentMetrics?: VariantMetrics | null;
}

function seedProposal(opts: SeedProposalOpts = {}): string {
  const proposalsRepo = createImprovementProposalsRepo(db);
  const artifactsRepo = createImprovementProposalArtifactsRepo(db);
  const id = crypto.randomUUID();
  const mintedAt = opts.mintedAt ?? '2026-05-23T00:00:00.000Z';
  proposalsRepo.insertProposal({
    id,
    layerId: opts.layerId ?? LAYER_X,
    status: opts.status ?? 'new',
    artifactKind: 'skill',
    problemSummary: 'demo cluster',
    proposedSpecJson: JSON.stringify({
      artifactKind: 'skill',
      name: 'demo-skill',
      description: 'demo',
      intent: 'question.entity_lookup',
      promptFragment: 'demo',
      addressesTags: ['zero-hit-retrieval'],
    }),
    expectedImpactJson: JSON.stringify({
      thumbsUpDelta: 0.1,
      tokensDelta: 0,
      latencyDeltaMs: 0,
    }),
    threshold: opts.threshold ?? 0.9,
    capabilitySnapshotJson: JSON.stringify({ capabilities: [], builtins: [] }),
    mintedByRunId: crypto.randomUUID(),
    mintedAt,
  });
  if (opts.proposedMetrics !== null && opts.proposedMetrics !== undefined) {
    artifactsRepo.insertArtifact({
      id: crypto.randomUUID(),
      proposalId: id,
      variant: 'proposed',
      transcriptJson: '{"messages":[]}',
      metricsJson: JSON.stringify(opts.proposedMetrics),
      ranAt: mintedAt,
    });
  }
  if (opts.currentMetrics !== null && opts.currentMetrics !== undefined) {
    artifactsRepo.insertArtifact({
      id: crypto.randomUUID(),
      proposalId: id,
      variant: 'current',
      transcriptJson: '{"messages":[]}',
      metricsJson: JSON.stringify(opts.currentMetrics),
      ranAt: mintedAt,
    });
  }
  return id;
}

function enableLayer(
  layerId: string,
  overrides: Partial<{
    thresholdCutoff: number;
    cooldownHours: number;
    requireThumbsUpDeltaPositive: boolean;
    maxTokensDelta: number | null;
  }> = {},
): void {
  const settingsRepo = new LayerProposalSettingsRepo(db);
  settingsRepo.upsert({
    layerId,
    autoActivationEnabled: true,
    thresholdCutoff: overrides.thresholdCutoff ?? 0.5,
    cooldownHours: overrides.cooldownHours ?? 1,
    requireThumbsUpDeltaPositive: overrides.requireThumbsUpDeltaPositive ?? true,
    maxTokensDelta: overrides.maxTokensDelta ?? null,
    updatedBy: USER_ID,
    now: '2026-05-23T00:00:00.000Z',
  });
}

function makeCtx(nowIso: string): ScheduledTaskRunContext {
  const fakeTask: ScheduledTask = {
    id: TASK_ID,
    layerId: 'everyone-id',
    slug: 'proposals-auto-activate',
    kind: PROPOSALS_AUTO_ACTIVATE_KIND,
    name: 'Proposal auto-activation',
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 60 },
    config: {},
    maxAttempts: 3,
    backoffBaseMs: 1000,
    backoffMaxMs: 60_000,
    nextRunAt: nowIso,
    lastRunAt: null,
    attempt: 0,
    claimedAt: null,
    claimedByPid: null,
    version: 1,
    createdAt: nowIso,
    createdBy: USER_ID,
    updatedAt: nowIso,
    updatedBy: USER_ID,
    deletedAt: null,
    deletedBy: null,
  };
  const fakeRun: ScheduledTaskRun = {
    id: 'run-1',
    taskId: TASK_ID,
    triggeredBy: 'tick' as ScheduledTaskRun['triggeredBy'],
    status: 'started' as ScheduledTaskRun['status'],
    attempt: 1,
    correlationId: 'corr-1',
    requestedAt: nowIso,
    startedAt: nowIso,
    finishedAt: null,
    durationMs: null,
    error: null,
  };
  return {
    task: fakeTask,
    run: fakeRun,
    correlationId: 'corr-1',
    now: () => nowIso,
    db,
    bus,
    llm: {
      endpoint: 'mock://noop',
      defaultModel: 'noop',
      async chat() {
        return {
          id: crypto.randomUUID(),
          content: '',
          tokensIn: 0,
          tokensOut: 0,
          model: 'noop',
          raw: null,
        };
      },
    },
    logger: noopLogger,
  };
}

function makeDeps(opts: {
  readonly replan: (proposalId: string, approvedBy: string) => Promise<ReplanOutcome>;
}): ProposalsAutoActivateDeps {
  const layersRepo = createLayersRepo(db);
  return {
    layersRepo: {
      listAllNonDeleted: () => layersRepo.listLayers().map((l) => ({ id: l.id })),
    },
    settingsRepo: new LayerProposalSettingsRepo(db),
    proposalsRepo: createImprovementProposalsRepo(db),
    artifactsRepo: createImprovementProposalArtifactsRepo(db),
    replan: opts.replan,
    bus,
  };
}

function captureAutoActivatedEvents(): ProposalAutoActivatedPayload[] {
  const events: ProposalAutoActivatedPayload[] = [];
  bus.subscribe(PROPOSAL_AUTO_ACTIVATED_EVENT_TYPE, (e) => {
    events.push(e.payload as ProposalAutoActivatedPayload);
  });
  return events;
}

async function awaitBus(): Promise<void> {
  await new Promise<void>((r) => {
    setTimeout(r, 0);
  });
}

const ELIGIBLE_NOW = '2026-05-24T00:00:00.000Z'; // mintedAt + 24h ≫ 1h cooldown

describe('phase 8.3 — proposals.auto-activate handler', () => {
  // -----------------------------------------------------------------------
  // 1. All four replan outcomes propagate to the bus event payload
  //    and to the audit columns.
  // -----------------------------------------------------------------------
  const outcomes: ReadonlyArray<ReplanOutcome['outcome']> = [
    'activated-asis',
    'activated-replanned',
    'superseded',
    'superseded-after-replan',
  ];

  for (const outcome of outcomes) {
    it(`propagates the '${outcome}' replan outcome to the bus event + stamps auto_activated_*`, async () => {
      enableLayer(LAYER_X);
      const proposalId = seedProposal({
        proposedMetrics: variantMetrics({ thumbsScore: 1 }),
        currentMetrics: variantMetrics({ thumbsScore: 0 }),
      });
      const events = captureAutoActivatedEvents();
      const replanCalls: Array<{ proposalId: string; approvedBy: string }> = [];
      const deps = makeDeps({
        async replan(id, approvedBy) {
          replanCalls.push({ proposalId: id, approvedBy });
          return { outcome } as ReplanOutcome;
        },
      });
      await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
      await awaitBus();

      // Closure was called with SYSTEM_ACTOR.
      expect(replanCalls.length).toBe(1);
      expect(replanCalls[0]?.approvedBy).toBe('system');
      // Bus event carries the same outcome label.
      expect(events.length).toBe(1);
      expect(events[0]?.outcome).toBe(outcome);
      expect(events[0]?.proposalId).toBe(proposalId);
      expect(events[0]?.layerId).toBe(LAYER_X);
      expect(events[0]?.artifactKind).toBe('skill');
      // Audit columns stamped regardless of outcome (ADR 0026 §4).
      const row = createImprovementProposalsRepo(db).getProposalById(proposalId);
      expect(row?.autoActivatedBy).toBe('system');
      expect(row?.autoActivatedAt).toBe(ELIGIBLE_NOW);
      // Decision JSON written too.
      expect(row?.autoActivationDecisionJson).not.toBeNull();
      const decision = JSON.parse(row!.autoActivationDecisionJson!);
      expect(decision.outcome).toBe('eligible');
    });
  }

  // -----------------------------------------------------------------------
  // 2. Each of the seven rejection reasons short-circuits the path.
  // -----------------------------------------------------------------------
  it('rejection: auto-activation-disabled — layer settings absent (default off)', async () => {
    // No settings row → default `autoActivationEnabled = false`.
    seedProposal({
      proposedMetrics: variantMetrics({ thumbsScore: 1 }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });
    const events = captureAutoActivatedEvents();
    let replanInvoked = false;
    const deps = makeDeps({
      async replan() {
        replanInvoked = true;
        return { outcome: 'activated-asis' };
      },
    });
    await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
    expect(replanInvoked).toBe(false);
    expect(events.length).toBe(0);
    // Decision JSON is NOT written either — the handler skipped the
    // layer entirely without ever looking at the proposal.
    // (The plan §4.3 sketch shows the gate runs per-proposal under an
    // enabled-layer branch; with the layer disabled there is no row.)
  });

  it('rejection: cooldown-not-elapsed — proposal too young', async () => {
    enableLayer(LAYER_X, { cooldownHours: 24 });
    // Minted 1 hour ago; cooldown is 24h.
    const proposalId = seedProposal({
      mintedAt: '2026-05-23T23:00:00.000Z',
      proposedMetrics: variantMetrics({ thumbsScore: 1 }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });
    const events = captureAutoActivatedEvents();
    let replanInvoked = false;
    const deps = makeDeps({
      async replan() {
        replanInvoked = true;
        return { outcome: 'activated-asis' };
      },
    });
    await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
    expect(replanInvoked).toBe(false);
    expect(events.length).toBe(0);
    const row = createImprovementProposalsRepo(db).getProposalById(proposalId);
    expect(row?.status).toBe('new');
    expect(row?.autoActivatedAt).toBeNull();
    const decision = JSON.parse(row!.autoActivationDecisionJson!);
    expect(decision.outcome).toBe('rejected');
    expect(decision.reason).toBe('cooldown-not-elapsed');
  });

  it('rejection: threshold-below-cutoff', async () => {
    enableLayer(LAYER_X, { thresholdCutoff: 0.9 });
    const proposalId = seedProposal({
      threshold: 0.5, // < 0.9 cutoff
      proposedMetrics: variantMetrics({ thumbsScore: 1 }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });
    const events = captureAutoActivatedEvents();
    let replanInvoked = false;
    const deps = makeDeps({
      async replan() {
        replanInvoked = true;
        return { outcome: 'activated-asis' };
      },
    });
    await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
    expect(replanInvoked).toBe(false);
    expect(events.length).toBe(0);
    const row = createImprovementProposalsRepo(db).getProposalById(proposalId);
    expect(row?.status).toBe('new');
    const decision = JSON.parse(row!.autoActivationDecisionJson!);
    expect(decision.reason).toBe('threshold-below-cutoff');
  });

  it('rejection: no-sandbox-evidence — proposed artifact missing', async () => {
    enableLayer(LAYER_X);
    const proposalId = seedProposal({
      proposedMetrics: null,
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });
    const events = captureAutoActivatedEvents();
    let replanInvoked = false;
    const deps = makeDeps({
      async replan() {
        replanInvoked = true;
        return { outcome: 'activated-asis' };
      },
    });
    await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
    expect(replanInvoked).toBe(false);
    expect(events.length).toBe(0);
    const row = createImprovementProposalsRepo(db).getProposalById(proposalId);
    const decision = JSON.parse(row!.autoActivationDecisionJson!);
    expect(decision.reason).toBe('no-sandbox-evidence');
  });

  it('rejection: sandbox-outcome-not-ok', async () => {
    enableLayer(LAYER_X);
    const proposalId = seedProposal({
      proposedMetrics: variantMetrics({ thumbsScore: 1, sandboxOutcome: 'timeout' }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });
    const events = captureAutoActivatedEvents();
    let replanInvoked = false;
    const deps = makeDeps({
      async replan() {
        replanInvoked = true;
        return { outcome: 'activated-asis' };
      },
    });
    await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
    expect(replanInvoked).toBe(false);
    expect(events.length).toBe(0);
    const row = createImprovementProposalsRepo(db).getProposalById(proposalId);
    const decision = JSON.parse(row!.autoActivationDecisionJson!);
    expect(decision.reason).toBe('sandbox-outcome-not-ok');
  });

  it('rejection: thumbs-up-delta-non-positive', async () => {
    enableLayer(LAYER_X, { requireThumbsUpDeltaPositive: true });
    const proposalId = seedProposal({
      proposedMetrics: variantMetrics({ thumbsScore: 0 }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });
    const events = captureAutoActivatedEvents();
    let replanInvoked = false;
    const deps = makeDeps({
      async replan() {
        replanInvoked = true;
        return { outcome: 'activated-asis' };
      },
    });
    await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
    expect(replanInvoked).toBe(false);
    expect(events.length).toBe(0);
    const row = createImprovementProposalsRepo(db).getProposalById(proposalId);
    const decision = JSON.parse(row!.autoActivationDecisionJson!);
    expect(decision.reason).toBe('thumbs-up-delta-non-positive');
  });

  it('rejection: tokens-delta-over-cap', async () => {
    enableLayer(LAYER_X, { maxTokensDelta: 10 });
    const proposalId = seedProposal({
      proposedMetrics: variantMetrics({ thumbsScore: 1, tokensIn: 500, tokensOut: 200 }),
      currentMetrics: variantMetrics({ thumbsScore: 0, tokensIn: 100, tokensOut: 50 }),
    });
    const events = captureAutoActivatedEvents();
    let replanInvoked = false;
    const deps = makeDeps({
      async replan() {
        replanInvoked = true;
        return { outcome: 'activated-asis' };
      },
    });
    await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
    expect(replanInvoked).toBe(false);
    expect(events.length).toBe(0);
    const row = createImprovementProposalsRepo(db).getProposalById(proposalId);
    const decision = JSON.parse(row!.autoActivationDecisionJson!);
    expect(decision.reason).toBe('tokens-delta-over-cap');
  });

  // -----------------------------------------------------------------------
  // 3. Cooldown boundary in milliseconds.
  // -----------------------------------------------------------------------
  it('cooldown boundary: 1ms before cooldown stays new, 1ms after activates', async () => {
    // Settings: cooldown = 1 hour exactly.
    enableLayer(LAYER_X, { cooldownHours: 1 });

    const mintedAtMs = Date.parse('2026-05-23T00:00:00.000Z');
    const beforeNowIso = new Date(mintedAtMs + 60 * 60 * 1000 - 1).toISOString();
    const afterNowIso = new Date(mintedAtMs + 60 * 60 * 1000 + 1).toISOString();

    const proposalIdBefore = seedProposal({
      mintedAt: '2026-05-23T00:00:00.000Z',
      proposedMetrics: variantMetrics({ thumbsScore: 1 }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });

    let replanInvocations = 0;
    const deps = makeDeps({
      async replan() {
        replanInvocations += 1;
        return { outcome: 'activated-asis' };
      },
    });

    await runAutoActivate(makeCtx(beforeNowIso), deps);
    expect(replanInvocations).toBe(0);
    let row = createImprovementProposalsRepo(db).getProposalById(proposalIdBefore);
    expect(row?.autoActivatedAt).toBeNull();

    // The before-run already recorded a decision; allow the after-run
    // to overwrite it with the eligible JSON. (The repo's
    // recordAutoActivationDecision uses bare UPDATE without a WHERE
    // clock predicate, mirroring ADR 0026 §4's "forensic trail of the
    // last evaluation" intent.)
    await runAutoActivate(makeCtx(afterNowIso), deps);
    expect(replanInvocations).toBe(1);
    row = createImprovementProposalsRepo(db).getProposalById(proposalIdBefore);
    expect(row?.autoActivatedAt).toBe(afterNowIso);
  });

  // -----------------------------------------------------------------------
  // 4. Race / replan-throws path.
  // -----------------------------------------------------------------------
  it('replan throws: decision JSON written, audit columns stay NULL, no bus event', async () => {
    enableLayer(LAYER_X);
    const proposalIdA = seedProposal({
      proposedMetrics: variantMetrics({ thumbsScore: 1 }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });
    // Second proposal — should still be processed after the first
    // one's throw.
    const proposalIdB = seedProposal({
      mintedAt: '2026-05-23T00:30:00.000Z',
      proposedMetrics: variantMetrics({ thumbsScore: 1 }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });
    const events = captureAutoActivatedEvents();
    const replanCalls: string[] = [];
    const deps = makeDeps({
      async replan(id) {
        replanCalls.push(id);
        if (id === proposalIdA) {
          throw new Error('synthetic replan failure');
        }
        return { outcome: 'activated-asis' };
      },
    });
    await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
    await awaitBus();

    // Both proposals were attempted.
    expect(replanCalls.sort()).toEqual([proposalIdA, proposalIdB].sort());

    const repo = createImprovementProposalsRepo(db);
    const rowA = repo.getProposalById(proposalIdA);
    // The decision JSON IS written (ADR 0026 §4 — forensic trail).
    expect(rowA?.autoActivationDecisionJson).not.toBeNull();
    // But the audit columns stay NULL because recordAutoActivation
    // never runs.
    expect(rowA?.autoActivatedBy).toBeNull();
    expect(rowA?.autoActivatedAt).toBeNull();

    const rowB = repo.getProposalById(proposalIdB);
    // Proposal B is unaffected by A's throw.
    expect(rowB?.autoActivatedBy).toBe('system');

    // Only proposal B emitted an event.
    expect(events.length).toBe(1);
    expect(events[0]?.proposalId).toBe(proposalIdB);
  });

  // -----------------------------------------------------------------------
  // 5. Multi-layer — disabled layer is skipped.
  // -----------------------------------------------------------------------
  it('multi-layer: only enabled layers are processed', async () => {
    // Layer X enabled, Layer Y disabled (no settings row).
    enableLayer(LAYER_X);

    const proposalInX = seedProposal({
      layerId: LAYER_X,
      proposedMetrics: variantMetrics({ thumbsScore: 1 }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });
    const proposalInY = seedProposal({
      layerId: LAYER_Y,
      proposedMetrics: variantMetrics({ thumbsScore: 1 }),
      currentMetrics: variantMetrics({ thumbsScore: 0 }),
    });

    const events = captureAutoActivatedEvents();
    const replanCalls: string[] = [];
    const deps = makeDeps({
      async replan(id) {
        replanCalls.push(id);
        return { outcome: 'activated-asis' };
      },
    });
    await runAutoActivate(makeCtx(ELIGIBLE_NOW), deps);
    await awaitBus();

    expect(replanCalls).toEqual([proposalInX]);
    expect(events.length).toBe(1);
    expect(events[0]?.layerId).toBe(LAYER_X);

    const repo = createImprovementProposalsRepo(db);
    const rowY = repo.getProposalById(proposalInY);
    // Layer Y proposal is untouched — no decision JSON either.
    expect(rowY?.autoActivationDecisionJson).toBeNull();
    expect(rowY?.autoActivatedBy).toBeNull();
  });
});
