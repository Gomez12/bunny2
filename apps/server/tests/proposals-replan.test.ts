/**
 * Phase 7.4 — re-plan on approval integration tests.
 *
 * Covers the four outcomes from ADR 0025 §1:
 *  - activated-asis           : empty diff → capability row written,
 *                               proposal.activated published.
 *  - superseded               : drift covers gap → no activation,
 *                               proposal.superseded published.
 *  - activated-replanned      : drift but gap persists; sandbox of
 *                               replanned spec returns positive delta;
 *                               replanned artifact row exists;
 *                               capability row written.
 *  - superseded-after-replan  : drift but gap persists; sandbox of
 *                               replanned spec returns non-positive
 *                               delta; no capability row.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { CapabilitySnapshot, LayerCapability, ProposalSpec } from '@bunny2/shared';
import { openDatabase } from '../src/storage/sqlite';
import { createChatConversationsRepo } from '../src/chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../src/chat/repos/chat-messages-repo';
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';
import { createImprovementProposalArtifactsRepo } from '../src/proposals/repos/improvement-proposal-artifacts-repo';
import { createImprovementProposalEvidenceRepo } from '../src/proposals/repos/improvement-proposal-evidence-repo';
import { createImprovementProposalsRepo } from '../src/proposals/repos/improvement-proposals-repo';
import {
  createCapabilityRegistry,
  PROPOSAL_ACTIVATED_EVENT_TYPE,
  PROPOSAL_SUPERSEDED_EVENT_TYPE,
  replanOnApproval,
} from '../src/proposals';
import { createProgrammableLlm } from './_helpers/programmable-llm';

const LAYER_X = '11111111-1111-1111-1111-111111111111';
const USER_ID = '33333333-3333-3333-3333-333333333333';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
}

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-replan-'));
}

function newFixture(): Fixture {
  const dir = mkTmp();
  const db = openDatabase(dir, { journalMode: 'DELETE' });
  const nowIso = new Date().toISOString();
  db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO users (id, username, display_name, password_hash, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(USER_ID, 'alice', 'Alice', 'h', nowIso, nowIso);
  db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
     VALUES (?, 'everyone', ?, ?, ?, ?)`,
  ).run(LAYER_X, 'layer-x', 'Layer X', nowIso, nowIso);
  return { dir, db, bus: new InMemoryMessageBus() };
}

function closeFixture(fx: Fixture): void {
  fx.db.close();
  try {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function skillSpec(
  name: string,
  tags: ('zero-hit-retrieval' | 'thumbs-down')[] = ['zero-hit-retrieval'],
): ProposalSpec {
  return {
    artifactKind: 'skill',
    name,
    description: 'desc',
    intent: 'question.entity_lookup',
    promptFragment: 'frag',
    addressesTags: tags,
  };
}

function seedEvidenceMessage(fx: Fixture): { messageId: string; conversationId: string } {
  const convRepo = createChatConversationsRepo(fx.db);
  const msgRepo = createChatMessagesRepo(fx.db);
  const conv = convRepo.insertConversation({
    id: crypto.randomUUID(),
    layerId: LAYER_X,
    userId: USER_ID,
    title: 't',
    locale: 'en',
    now: new Date().toISOString(),
  });
  const msg = msgRepo.insertMessage({
    id: crypto.randomUUID(),
    conversationId: conv.id,
    role: 'user',
    content: 'when do I meet Acmé?',
    status: 'done',
    correlationId: crypto.randomUUID(),
    flowId: conv.id,
    now: new Date().toISOString(),
  });
  return { messageId: msg.id, conversationId: conv.id };
}

function buildRepos(fx: Fixture) {
  return {
    proposalsRepo: createImprovementProposalsRepo(fx.db),
    evidenceRepo: createImprovementProposalEvidenceRepo(fx.db),
    artifactsRepo: createImprovementProposalArtifactsRepo(fx.db),
    layerCapabilitiesRepo: createLayerCapabilitiesRepo(fx.db),
    conversationsRepo: createChatConversationsRepo(fx.db),
    messagesRepo: createChatMessagesRepo(fx.db),
  };
}

function insertProposal(opts: {
  fx: Fixture;
  spec: ProposalSpec;
  capabilitySnapshot: CapabilitySnapshot;
}): string {
  const proposalsRepo = createImprovementProposalsRepo(opts.fx.db);
  const id = crypto.randomUUID();
  proposalsRepo.insertProposal({
    id,
    layerId: LAYER_X,
    status: 'new',
    artifactKind: opts.spec.artifactKind,
    problemSummary: 'cluster',
    proposedSpecJson: JSON.stringify(opts.spec),
    expectedImpactJson: JSON.stringify({
      thumbsUpDelta: 0.1,
      tokensDelta: 0,
      latencyDeltaMs: 0,
    }),
    threshold: 0.7,
    capabilitySnapshotJson: JSON.stringify(opts.capabilitySnapshot),
    mintedByRunId: 'run-1',
    mintedAt: new Date().toISOString(),
  });
  return id;
}

/** Enqueue intent/entities/answer for a single replay. */
function enqueueOneReplay(llm: ReturnType<typeof createProgrammableLlm>): void {
  llm.enqueue('intent', { content: JSON.stringify({ intent: 'question.entity_lookup' }) });
  llm.enqueue('entities', {
    content: JSON.stringify({ kinds: [], queryHints: [{ term: 'acme' }] }),
  });
  llm.enqueue('answer', { content: 'answer' });
}

describe('phase 7.4 — replan on approval', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = newFixture();
  });
  afterEach(() => {
    closeFixture(fx);
  });

  it('activated-asis: empty diff → layer_capabilities row + proposal.activated', async () => {
    const ev = seedEvidenceMessage(fx);
    const llm = createProgrammableLlm();
    // 1 evidence × 2 variants × 3 steps = 6 calls.
    enqueueOneReplay(llm);
    enqueueOneReplay(llm);

    const proposalId = insertProposal({
      fx,
      spec: skillSpec('asis'),
      capabilitySnapshot: { capabilities: [], builtins: [] },
    });
    const repos = buildRepos(fx);
    repos.evidenceRepo.insertMany([
      {
        id: crypto.randomUUID(),
        proposalId,
        messageId: ev.messageId,
        clusterReason: 'zero-hit-retrieval',
      },
    ]);

    const activatedEvents: unknown[] = [];
    fx.bus.subscribe(PROPOSAL_ACTIVATED_EVENT_TYPE, (e) => {
      activatedEvents.push(e.payload);
    });

    const capabilityRegistry = createCapabilityRegistry({
      repo: repos.layerCapabilitiesRepo,
      bus: fx.bus,
    });

    const result = await replanOnApproval(proposalId, USER_ID, {
      llm,
      db: fx.db,
      bus: fx.bus,
      capabilityRegistry,
      artifactsRepo: repos.artifactsRepo,
      conversationsRepo: repos.conversationsRepo,
      messagesRepo: repos.messagesRepo,
      getEntityStore: () => null,
      logger: noopLogger,
      proposalsRepo: repos.proposalsRepo,
      evidenceRepo: repos.evidenceRepo,
      layerCapabilitiesRepo: repos.layerCapabilitiesRepo,
    });
    expect(result.outcome).toBe('activated-asis');

    const capRows = repos.layerCapabilitiesRepo.listActiveByLayer(LAYER_X);
    expect(capRows.length).toBe(1);
    expect(capRows[0]?.name).toBe('asis');
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
    expect(activatedEvents.length).toBe(1);
    const updated = repos.proposalsRepo.getProposalById(proposalId);
    expect(updated?.status).toBe('activated');
    expect(updated?.approvedBy).toBe(USER_ID);
    expect(updated?.activatedAt).not.toBeNull();
  });

  it('superseded: drift covers gap → no activation, proposal.superseded', async () => {
    const ev = seedEvidenceMessage(fx);
    const llm = createProgrammableLlm(); // sandbox not invoked
    const repos = buildRepos(fx);

    // Insert a live capability that addresses the cluster's tag —
    // this is what "covers the gap" tests.
    const liveCapId = crypto.randomUUID();
    repos.layerCapabilitiesRepo.insertCapability({
      id: liveCapId,
      layerId: LAYER_X,
      kind: 'skill',
      name: 'drift-cap',
      specJson: JSON.stringify(skillSpec('drift-cap')),
      origin: 'builtin',
      activatedAt: new Date().toISOString(),
    });
    const proposalId = insertProposal({
      fx,
      spec: skillSpec('would-have-helped'),
      // Mint-time snapshot is EMPTY → diff contains the live cap.
      capabilitySnapshot: { capabilities: [], builtins: [] },
    });
    repos.evidenceRepo.insertMany([
      {
        id: crypto.randomUUID(),
        proposalId,
        messageId: ev.messageId,
        clusterReason: 'zero-hit-retrieval',
      },
    ]);

    const supersededEvents: unknown[] = [];
    fx.bus.subscribe(PROPOSAL_SUPERSEDED_EVENT_TYPE, (e) => {
      supersededEvents.push(e.payload);
    });

    const capabilityRegistry = createCapabilityRegistry({
      repo: repos.layerCapabilitiesRepo,
      bus: fx.bus,
    });

    const result = await replanOnApproval(proposalId, USER_ID, {
      llm,
      db: fx.db,
      bus: fx.bus,
      capabilityRegistry,
      artifactsRepo: repos.artifactsRepo,
      conversationsRepo: repos.conversationsRepo,
      messagesRepo: repos.messagesRepo,
      getEntityStore: () => null,
      logger: noopLogger,
      proposalsRepo: repos.proposalsRepo,
      evidenceRepo: repos.evidenceRepo,
      layerCapabilitiesRepo: repos.layerCapabilitiesRepo,
    });
    expect(result.outcome).toBe('superseded');
    await new Promise<void>((r) => {
      setTimeout(r, 0);
    });
    expect(supersededEvents.length).toBe(1);
    // Only the live "drift-cap" remains; no new proposal cap.
    const capRows = repos.layerCapabilitiesRepo.listActiveByLayer(LAYER_X);
    expect(capRows.length).toBe(1);
    expect(capRows[0]?.id).toBe(liveCapId);
    expect(llm.calls.length).toBe(0);
  });

  it('activated-replanned: drift but gap persists; replanned spec helps → activate', async () => {
    const ev = seedEvidenceMessage(fx);
    const llm = createProgrammableLlm();
    // Drift exists (a different-tag live cap), gap persists (the cap
    // addresses thumbs-down, proposal addresses zero-hit-retrieval).
    // Then re-plan returns a spec that addresses the same tag, and
    // the sandbox of the replanned spec has positive delta (the
    // heuristic in metrics.ts gives +1 per evidence message whose
    // clusterReason is in the spec's addressesTags).
    enqueueOneReplay(llm); // current
    enqueueOneReplay(llm); // proposed

    const repos = buildRepos(fx);
    // Drift cap addresses a DIFFERENT tag → doesn't cover gap.
    const driftCapId = crypto.randomUUID();
    repos.layerCapabilitiesRepo.insertCapability({
      id: driftCapId,
      layerId: LAYER_X,
      kind: 'skill',
      name: 'drift-different-tag',
      specJson: JSON.stringify(skillSpec('drift-different-tag', ['thumbs-down'])),
      origin: 'builtin',
      activatedAt: new Date().toISOString(),
    });
    const proposalId = insertProposal({
      fx,
      spec: skillSpec('original'),
      capabilitySnapshot: { capabilities: [], builtins: [] },
    });
    repos.evidenceRepo.insertMany([
      {
        id: crypto.randomUUID(),
        proposalId,
        messageId: ev.messageId,
        clusterReason: 'zero-hit-retrieval',
      },
    ]);

    const capabilityRegistry = createCapabilityRegistry({
      repo: repos.layerCapabilitiesRepo,
      bus: fx.bus,
    });

    const replannedSpec: ProposalSpec = skillSpec('replanned-version');
    const result = await replanOnApproval(proposalId, USER_ID, {
      llm,
      db: fx.db,
      bus: fx.bus,
      capabilityRegistry,
      artifactsRepo: repos.artifactsRepo,
      conversationsRepo: repos.conversationsRepo,
      messagesRepo: repos.messagesRepo,
      getEntityStore: () => null,
      logger: noopLogger,
      proposalsRepo: repos.proposalsRepo,
      evidenceRepo: repos.evidenceRepo,
      layerCapabilitiesRepo: repos.layerCapabilitiesRepo,
      // Scripted re-plan LLM: returns a covering spec.
      replanProposalViaLlm: async () => replannedSpec,
    });
    expect(result.outcome).toBe('activated-replanned');
    const capRows = repos.layerCapabilitiesRepo.listActiveByLayer(LAYER_X);
    // drift cap + activated replanned cap.
    expect(capRows.map((c) => c.name).sort()).toEqual(['drift-different-tag', 'replanned-version']);
    // Replanned artifact row written.
    const artifacts = repos.artifactsRepo.listByProposal(proposalId);
    expect(artifacts.some((a) => a.variant === 'replanned')).toBe(true);
  });

  it('superseded-after-replan: drift, gap persists; replanned spec does NOT help → supersede', async () => {
    const ev = seedEvidenceMessage(fx);
    const llm = createProgrammableLlm();
    enqueueOneReplay(llm); // current
    enqueueOneReplay(llm); // proposed (sandbox of replanned spec)

    const repos = buildRepos(fx);
    const driftCapId = crypto.randomUUID();
    repos.layerCapabilitiesRepo.insertCapability({
      id: driftCapId,
      layerId: LAYER_X,
      kind: 'skill',
      name: 'drift-different-tag',
      specJson: JSON.stringify(skillSpec('drift-different-tag', ['thumbs-down'])),
      origin: 'builtin',
      activatedAt: new Date().toISOString(),
    });
    const proposalId = insertProposal({
      fx,
      spec: skillSpec('original'),
      capabilitySnapshot: { capabilities: [], builtins: [] },
    });
    repos.evidenceRepo.insertMany([
      {
        id: crypto.randomUUID(),
        proposalId,
        messageId: ev.messageId,
        clusterReason: 'zero-hit-retrieval',
      },
    ]);

    const capabilityRegistry = createCapabilityRegistry({
      repo: repos.layerCapabilitiesRepo,
      bus: fx.bus,
    });

    // Phase 7.5 — the metrics-rewrite derives `thumbsUpDelta` from
    // transcript prompt-growth instead of `addressesTags` coverage.
    // To trigger the non-positive-delta branch we hand back a spec
    // whose intent (`question.summary`) does NOT match the replay's
    // resolved intent (`question.entity_lookup` — see `enqueueOneReplay`).
    // The answerer therefore filters the overlay skill OUT for both
    // variants, so prompt growth is 0 and `thumbsUpDelta = 0`. This
    // exercises the real non-positive-delta branch, not the
    // null-mapped-to-supersede shortcut.
    const nonHelpfulSpec: ProposalSpec = {
      artifactKind: 'skill',
      name: 'wrong-intent',
      description: 'desc',
      intent: 'question.summary',
      promptFragment: 'frag',
      addressesTags: ['zero-hit-retrieval'],
    };
    const result = await replanOnApproval(proposalId, USER_ID, {
      llm,
      db: fx.db,
      bus: fx.bus,
      capabilityRegistry,
      artifactsRepo: repos.artifactsRepo,
      conversationsRepo: repos.conversationsRepo,
      messagesRepo: repos.messagesRepo,
      getEntityStore: () => null,
      logger: noopLogger,
      proposalsRepo: repos.proposalsRepo,
      evidenceRepo: repos.evidenceRepo,
      layerCapabilitiesRepo: repos.layerCapabilitiesRepo,
      replanProposalViaLlm: async () => nonHelpfulSpec,
    });
    expect(result.outcome).toBe('superseded-after-replan');
    const capRows = repos.layerCapabilitiesRepo.listActiveByLayer(LAYER_X);
    // Only the drift cap; no replanned activation.
    expect(capRows.length).toBe(1);
    expect(capRows[0]?.id).toBe(driftCapId);
  });

  // -----------------------------------------------------------------------
  // Phase 8.3 — actorKind: 'system' branch.
  //
  // Pins the §1 plumbing: when the auto-activate handler calls
  // `replanOnApproval(id, SYSTEM_ACTOR, { ...deps, actorKind: 'system' })`,
  // `activateProposal` must NOT write `approved_by` / `approved_at`,
  // even though the proposal lands `activated`. The audit columns
  // (`auto_activated_*`) are stamped by the handler post-call via
  // `recordAutoActivation(...)`; this test verifies the replan path's
  // own side of that contract.
  // -----------------------------------------------------------------------
  it("actorKind 'system' on activated-asis leaves approved_by NULL and stamps activated_at", async () => {
    const ev = seedEvidenceMessage(fx);
    const llm = createProgrammableLlm();
    enqueueOneReplay(llm);
    enqueueOneReplay(llm);

    const proposalId = insertProposal({
      fx,
      spec: skillSpec('asis-system'),
      capabilitySnapshot: { capabilities: [], builtins: [] },
    });
    const repos = buildRepos(fx);
    repos.evidenceRepo.insertMany([
      {
        id: crypto.randomUUID(),
        proposalId,
        messageId: ev.messageId,
        clusterReason: 'zero-hit-retrieval',
      },
    ]);

    const capabilityRegistry = createCapabilityRegistry({
      repo: repos.layerCapabilitiesRepo,
      bus: fx.bus,
    });

    const result = await replanOnApproval(proposalId, 'system', {
      llm,
      db: fx.db,
      bus: fx.bus,
      capabilityRegistry,
      artifactsRepo: repos.artifactsRepo,
      conversationsRepo: repos.conversationsRepo,
      messagesRepo: repos.messagesRepo,
      getEntityStore: () => null,
      logger: noopLogger,
      proposalsRepo: repos.proposalsRepo,
      evidenceRepo: repos.evidenceRepo,
      layerCapabilitiesRepo: repos.layerCapabilitiesRepo,
      // The discriminator under test.
      actorKind: 'system',
    });
    expect(result.outcome).toBe('activated-asis');

    const row = repos.proposalsRepo.getProposalById(proposalId);
    if (row === null) throw new Error('expected proposal to exist');
    expect(row.status).toBe('activated');
    // ADR 0026 §3 — `approved_by` stays NULL on the system path.
    expect(row.approvedBy).toBeNull();
    expect(row.approvedAt).toBeNull();
    // `activated_at` is still stamped — the capability is live.
    expect(row.activatedAt).not.toBeNull();
    // The auto_activated_* columns are stamped by the handler, not
    // by the replan path; the row should still carry them NULL here
    // because this test does not call `recordAutoActivation(...)`.
    expect(row.autoActivatedBy).toBeNull();
    expect(row.autoActivatedAt).toBeNull();
  });

  // Pin the `actorKind: 'user' | 'system'` union shape so a future
  // refactor that loses one of the literals trips this assertion at
  // compile time (plan §11 mitigation row).
  it('typechecks the actorKind discriminator union on ReplanDeps', () => {
    type CheckDeps = Pick<Parameters<typeof replanOnApproval>[2], 'actorKind'>;
    const userish: CheckDeps = { actorKind: 'user' };
    const systemish: CheckDeps = { actorKind: 'system' };
    // The default-undefined assignment must compile too (phase-7
    // callsites omit the field).
    const omit: CheckDeps = {};
    // Reference all three so TS doesn't elide them.
    void userish;
    void systemish;
    void omit;
    expect(true).toBe(true);
  });
});

// Sanity: prove the snapshot diff is pure (importable + deterministic).
import { diffSnapshots, coversGap } from '../src/proposals';

describe('phase 7.4 — diffSnapshots is pure', () => {
  it('empty diff when mint == current', () => {
    const cap: LayerCapability = {
      id: 'c1',
      layerId: LAYER_X,
      kind: 'skill',
      name: 'a',
      specJson: JSON.stringify(skillSpec('a')),
      origin: 'builtin',
      activatedAt: '2026-01-01T00:00:00.000Z',
      deactivatedAt: null,
    };
    const snap: CapabilitySnapshot = { capabilities: [cap], builtins: [] };
    expect(diffSnapshots(snap, snap).isEmpty).toBe(true);
  });

  it('coversGap returns false when proposal tags exceed added tags', () => {
    const addedTags = new Set<'zero-hit-retrieval'>(['zero-hit-retrieval']);
    expect(coversGap(['zero-hit-retrieval', 'thumbs-down'], addedTags)).toBe(false);
    expect(coversGap(['zero-hit-retrieval'], addedTags)).toBe(true);
    expect(coversGap([], addedTags)).toBe(false);
  });
});
