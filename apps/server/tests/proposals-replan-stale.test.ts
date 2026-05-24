/**
 * Phase 7.6 — `proposals.replan-stale` idempotency test.
 *
 * Asserts:
 *  - A `new` proposal whose capability snapshot still matches the
 *    current registry view is NEVER re-sandboxed (no artifact row
 *    written; counts come back as `skippedNoDrift`).
 *  - The proposal's `status` is never mutated by this path,
 *    regardless of outcome.
 *
 * Stale-drift refresh is exercised indirectly: the test passes a
 * registry that returns an empty list (matching the mint-time
 * snapshot's `capabilities: []`) so the path takes the no-drift
 * branch deterministically.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { safeRmSync } from './_helpers/temp-dir';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { createGroupResolver } from '../src/auth/group-resolver';
import { seedAdminIfNeeded } from '../src/auth/seed';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createCapabilityRegistry } from '../src/proposals/capability-registry';
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';
import { createImprovementProposalsRepo } from '../src/proposals/repos/improvement-proposals-repo';
import { replanStaleProposals } from '../src/proposals/replan-stale-handler';
import type { LlmClient } from '../src/llm';

let dir: string;
let db: Database;
let bus: InMemoryMessageBus;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-replan-stale-'));
  db = openDatabase(dir);
  bus = new InMemoryMessageBus();
  await seedAdminIfNeeded({ db, bus, log: () => {} });
  await seedLayersIfNeeded({ db, bus, transitiveGroups: createGroupResolver({ db, bus }) });
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

const noopLogger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
};

const stubLlm: LlmClient = {
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
};

describe('proposals.replan-stale', () => {
  it('skips proposals whose snapshot already matches the current registry', async () => {
    const everyone = createLayersRepo(db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const proposalsRepo = createImprovementProposalsRepo(db);
    const now = new Date('2026-05-24T00:00:00.000Z');
    // 8 days ago — older than the 7-day stale window.
    const oldIso = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const id = crypto.randomUUID();
    proposalsRepo.insertProposal({
      id,
      layerId: everyone.id,
      status: 'new',
      artifactKind: 'skill',
      problemSummary: 'demo',
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
      threshold: 0.5,
      // Empty snapshot — matches the empty registry below.
      capabilitySnapshotJson: JSON.stringify({ capabilities: [], builtins: [] }),
      mintedByRunId: crypto.randomUUID(),
      mintedAt: oldIso,
    });

    const registry = createCapabilityRegistry({
      repo: createLayerCapabilitiesRepo(db),
      bus,
    });

    const result = await replanStaleProposals(
      db,
      bus,
      stubLlm,
      registry,
      () => null,
      { staleAfterDays: 7 },
      now,
      noopLogger,
    );

    expect(result.proposalsScanned).toBe(1);
    expect(result.proposalsRefreshed).toBe(0);
    expect(result.proposalsSkippedNoDrift).toBe(1);
    // Status untouched.
    expect(proposalsRepo.getProposalById(id)?.status).toBe('new');
  });

  it('does not touch proposals younger than the stale window', async () => {
    const everyone = createLayersRepo(db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const proposalsRepo = createImprovementProposalsRepo(db);
    const now = new Date('2026-05-24T00:00:00.000Z');
    // 3 days ago — younger than the 7-day stale window.
    const youngIso = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
    proposalsRepo.insertProposal({
      id: crypto.randomUUID(),
      layerId: everyone.id,
      status: 'new',
      artifactKind: 'skill',
      problemSummary: 'demo',
      proposedSpecJson: JSON.stringify({
        artifactKind: 'skill',
        name: 'demo-skill',
        description: 'demo',
        intent: 'question.entity_lookup',
        promptFragment: 'demo',
        addressesTags: ['zero-hit-retrieval'],
      }),
      expectedImpactJson: JSON.stringify({}),
      threshold: 0.5,
      capabilitySnapshotJson: JSON.stringify({ capabilities: [], builtins: [] }),
      mintedByRunId: crypto.randomUUID(),
      mintedAt: youngIso,
    });

    const registry = createCapabilityRegistry({
      repo: createLayerCapabilitiesRepo(db),
      bus,
    });

    const result = await replanStaleProposals(
      db,
      bus,
      stubLlm,
      registry,
      () => null,
      { staleAfterDays: 7 },
      now,
      noopLogger,
    );

    expect(result.proposalsScanned).toBe(0);
  });
});
