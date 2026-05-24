/**
 * Phase 7.4 — sandbox runner tests.
 *
 * Fixtures cover:
 *  - Happy path: two evidence messages, a skill spec, both replays
 *    produce transcripts, two artifact rows written, metrics delta
 *    non-zero (positive because the spec covers the cluster reason).
 *  - Timeout: mock the LLM to delay > 10 s → `sandboxOutcome: 'timeout'`,
 *    NO extra artifact rows beyond the expected two.
 *  - Closed-enum guard: spec with unknown handler kind → sandbox
 *    refuses to run, returns `{ err }`, no artifact rows written.
 *  - Cap-at-5: 7 evidence messages → only 5 replayed.
 *  - Cross-layer evidence guard (the brief's "soft-delete"): layer-X
 *    proposal + layer-Y conversation message → error, no rows.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { ImprovementProposal, ProposalSpec } from '@bunny2/shared';
import { openDatabase } from '../src/storage/sqlite';
import { createChatConversationsRepo } from '../src/chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../src/chat/repos/chat-messages-repo';
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';
import { createImprovementProposalArtifactsRepo } from '../src/proposals/repos/improvement-proposal-artifacts-repo';
import { createImprovementProposalsRepo } from '../src/proposals/repos/improvement-proposals-repo';
import { createImprovementProposalEvidenceRepo } from '../src/proposals/repos/improvement-proposal-evidence-repo';
import { createCapabilityRegistry, runSandbox } from '../src/proposals';
import { createProgrammableLlm } from './_helpers/programmable-llm';

const LAYER_X = '11111111-1111-1111-1111-111111111111';
const LAYER_Y = '22222222-2222-2222-2222-222222222222';
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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sandbox-'));
}

function newFixture(): Fixture {
  const dir = mkTmp();
  const db = openDatabase(dir, { journalMode: 'DELETE' });
  const nowIso = new Date().toISOString();
  db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO users (id, username, display_name, password_hash, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(USER_ID, 'alice', 'Alice', 'h', nowIso, nowIso);
  for (const [id, slug] of [
    [LAYER_X, 'layer-x'],
    [LAYER_Y, 'layer-y'],
  ] as const) {
    db.query<unknown, [string, string, string, string, string]>(
      `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
       VALUES (?, 'everyone', ?, ?, ?, ?)`,
    ).run(id, slug, slug, nowIso, nowIso);
  }
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

function skillSpec(name: string): ProposalSpec {
  return {
    artifactKind: 'skill',
    name,
    description: 'expand acme alias',
    intent: 'question.entity_lookup',
    promptFragment: 'If user writes Acmé, also search for Acme.',
    addressesTags: ['zero-hit-retrieval'],
  };
}

function buildProposal(opts: { layerId: string; spec: ProposalSpec }): ImprovementProposal {
  return {
    id: crypto.randomUUID(),
    layerId: opts.layerId,
    status: 'new',
    artifactKind: opts.spec.artifactKind,
    problemSummary: 'test cluster',
    proposedSpec: opts.spec,
    expectedImpact: { thumbsUpDelta: 0.18, tokensDelta: 12, latencyDeltaMs: 14 },
    threshold: 0.7,
    capabilitySnapshot: { capabilities: [], builtins: [] },
    mintedByRunId: 'run-1',
    mintedAt: new Date().toISOString(),
    approvedBy: null,
    approvedAt: null,
    rejectedBy: null,
    rejectedAt: null,
    rejectedReason: null,
    activatedAt: null,
    deletedAt: null,
    deletedBy: null,
  };
}

function seedEvidenceMessage(
  fx: Fixture,
  opts: { layerId: string; userContent: string; conversationId?: string },
): { messageId: string; conversationId: string } {
  const convRepo = createChatConversationsRepo(fx.db);
  const msgRepo = createChatMessagesRepo(fx.db);
  const conv =
    opts.conversationId !== undefined
      ? (convRepo.getConversationById(opts.conversationId) ??
        convRepo.insertConversation({
          id: opts.conversationId,
          layerId: opts.layerId,
          userId: USER_ID,
          title: opts.userContent.slice(0, 40),
          locale: 'en',
          now: new Date().toISOString(),
        }))
      : convRepo.insertConversation({
          id: crypto.randomUUID(),
          layerId: opts.layerId,
          userId: USER_ID,
          title: opts.userContent.slice(0, 40),
          locale: 'en',
          now: new Date().toISOString(),
        });
  const msg = msgRepo.insertMessage({
    id: crypto.randomUUID(),
    conversationId: conv.id,
    role: 'user',
    content: opts.userContent,
    status: 'done',
    correlationId: crypto.randomUUID(),
    flowId: conv.id,
    now: new Date().toISOString(),
  });
  return { messageId: msg.id, conversationId: conv.id };
}

function buildSandboxDeps(fx: Fixture) {
  const layerCapabilitiesRepo = createLayerCapabilitiesRepo(fx.db);
  const capabilityRegistry = createCapabilityRegistry({
    repo: layerCapabilitiesRepo,
    bus: fx.bus,
  });
  const artifactsRepo = createImprovementProposalArtifactsRepo(fx.db);
  const conversationsRepo = createChatConversationsRepo(fx.db);
  const messagesRepo = createChatMessagesRepo(fx.db);
  return {
    layerCapabilitiesRepo,
    capabilityRegistry,
    artifactsRepo,
    conversationsRepo,
    messagesRepo,
  };
}

/**
 * Enqueue 2× (intent + entities + answer) per replay (current + proposed).
 */
function enqueueReplay(
  llm: ReturnType<typeof createProgrammableLlm>,
  count: number,
  opts: { intent?: string } = {},
): void {
  const intent = opts.intent ?? 'question.entity_lookup';
  for (let i = 0; i < count; i += 1) {
    llm.enqueue('intent', { content: JSON.stringify({ intent }) });
    llm.enqueue('entities', {
      content: JSON.stringify({ kinds: [], queryHints: [{ term: 'acme' }] }),
    });
    llm.enqueue('answer', { content: 'sandbox-answer' });
  }
}

describe('phase 7.4 — sandbox runner', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = newFixture();
  });
  afterEach(() => {
    closeFixture(fx);
  });

  it('happy path: 2 evidence messages, skill spec → 2 artifact rows + positive thumbs delta', async () => {
    const llm = createProgrammableLlm();
    // 2 evidence × 2 variants = 4 replays × 3 LLM steps = 12 calls.
    enqueueReplay(llm, 4);

    const ev1 = seedEvidenceMessage(fx, {
      layerId: LAYER_X,
      userContent: 'when do I meet Acmé?',
    });
    const ev2 = seedEvidenceMessage(fx, {
      layerId: LAYER_X,
      userContent: 'show me Acmé notes',
    });

    // Seed proposal + evidence rows so the row exists for FK.
    const proposalsRepo = createImprovementProposalsRepo(fx.db);
    const evidenceRepo = createImprovementProposalEvidenceRepo(fx.db);
    const proposal = buildProposal({ layerId: LAYER_X, spec: skillSpec('expand-acme') });
    proposalsRepo.insertProposal({
      id: proposal.id,
      layerId: proposal.layerId,
      status: 'new',
      artifactKind: proposal.artifactKind,
      problemSummary: proposal.problemSummary,
      proposedSpecJson: JSON.stringify(proposal.proposedSpec),
      expectedImpactJson: JSON.stringify(proposal.expectedImpact),
      threshold: proposal.threshold,
      capabilitySnapshotJson: JSON.stringify(proposal.capabilitySnapshot),
      mintedByRunId: proposal.mintedByRunId,
      mintedAt: proposal.mintedAt,
    });
    evidenceRepo.insertMany([
      {
        id: crypto.randomUUID(),
        proposalId: proposal.id,
        messageId: ev1.messageId,
        clusterReason: 'zero-hit-retrieval',
      },
      {
        id: crypto.randomUUID(),
        proposalId: proposal.id,
        messageId: ev2.messageId,
        clusterReason: 'zero-hit-retrieval',
      },
    ]);

    const deps = buildSandboxDeps(fx);
    const result = await runSandbox(
      proposal,
      [
        { id: crypto.randomUUID(), messageId: ev1.messageId, clusterReason: 'zero-hit-retrieval' },
        { id: crypto.randomUUID(), messageId: ev2.messageId, clusterReason: 'zero-hit-retrieval' },
      ],
      {
        llm,
        db: fx.db,
        bus: fx.bus,
        capabilityRegistry: deps.capabilityRegistry,
        artifactsRepo: deps.artifactsRepo,
        conversationsRepo: deps.conversationsRepo,
        messagesRepo: deps.messagesRepo,
        getEntityStore: () => null,
        logger: noopLogger,
      },
    );

    expect('ok' in result).toBe(true);
    if (!('ok' in result)) return;
    expect(result.ok.current.messages.length).toBe(2);
    expect(result.ok.proposed.messages.length).toBe(2);
    // Two artifact rows.
    const artifactRows = deps.artifactsRepo.listByProposal(proposal.id);
    expect(artifactRows.length).toBe(2);
    expect(artifactRows.map((r) => r.variant).sort()).toEqual(['current', 'proposed']);
    // The proposed spec covers `zero-hit-retrieval` for both evidence,
    // so thumbsUpDelta must be > 0 (coverage bonus per evidence = 1
    // each).
    expect(result.ok.metrics.thumbsUpDelta).toBeGreaterThan(0);
  });

  it('timeout: LLM delay > 10s aborts replay with sandboxOutcome=timeout, no extra artifact rows', async () => {
    // A custom LLM whose `chat()` hangs forever — the sandbox's per-
    // message 10 s timeout must abort the replay. Streaming path is
    // unused (no chunkSink in deps), so we don't implement chatStream.
    const llm = {
      endpoint: 'mock://hang',
      defaultModel: 'hang',
      async chat(): Promise<never> {
        // Block until the test's setTimeout-based 10 s wait elapses.
        await new Promise<void>((resolve) => setTimeout(resolve, 11_500));
        throw new Error('unreachable');
      },
    };

    const ev1 = seedEvidenceMessage(fx, {
      layerId: LAYER_X,
      userContent: 'timeout test',
    });
    const proposalsRepo = createImprovementProposalsRepo(fx.db);
    const proposal = buildProposal({ layerId: LAYER_X, spec: skillSpec('timeout') });
    proposalsRepo.insertProposal({
      id: proposal.id,
      layerId: proposal.layerId,
      status: 'new',
      artifactKind: proposal.artifactKind,
      problemSummary: proposal.problemSummary,
      proposedSpecJson: JSON.stringify(proposal.proposedSpec),
      expectedImpactJson: JSON.stringify(proposal.expectedImpact),
      threshold: proposal.threshold,
      capabilitySnapshotJson: JSON.stringify(proposal.capabilitySnapshot),
      mintedByRunId: proposal.mintedByRunId,
      mintedAt: proposal.mintedAt,
    });

    const deps = buildSandboxDeps(fx);
    const result = await runSandbox(
      proposal,
      [{ id: crypto.randomUUID(), messageId: ev1.messageId, clusterReason: 'zero-hit-retrieval' }],
      {
        llm,
        db: fx.db,
        bus: fx.bus,
        capabilityRegistry: deps.capabilityRegistry,
        artifactsRepo: deps.artifactsRepo,
        conversationsRepo: deps.conversationsRepo,
        messagesRepo: deps.messagesRepo,
        getEntityStore: () => null,
        logger: noopLogger,
      },
    );

    expect('ok' in result).toBe(true);
    if (!('ok' in result)) return;
    expect(result.ok.outcome).toBe('timeout');
    // Exactly two artifact rows (the timeout-path still writes them
    // so the UI can render the failed state).
    const artifactRows = deps.artifactsRepo.listByProposal(proposal.id);
    expect(artifactRows.length).toBe(2);
  }, 30_000);

  it('closed-enum guard: spec with unknown handler kind → err, no artifact rows', async () => {
    const ev1 = seedEvidenceMessage(fx, { layerId: LAYER_X, userContent: 'bad spec' });
    const proposalsRepo = createImprovementProposalsRepo(fx.db);
    // Manufacture a proposal carrying a malformed spec. The
    // proposalsRepo accepts opaque JSON; runSandbox is the guard.
    const proposal = buildProposal({ layerId: LAYER_X, spec: skillSpec('valid') });
    // Mutate the proposal's spec to an unknown handler kind at the
    // shared-type boundary — we cast through `unknown` because the
    // zod schema would reject it.
    const malformed = {
      artifactKind: 'tool',
      name: 'bad',
      description: 'unknown handler kind',
      jsonSchema: {},
      handler: { kind: 'definitely-not-allowed', config: {} },
      addressesTags: ['zero-hit-retrieval'],
    } as unknown as ProposalSpec;
    const malformedProposal: ImprovementProposal = {
      ...proposal,
      proposedSpec: malformed,
      artifactKind: 'tool',
    };
    proposalsRepo.insertProposal({
      id: malformedProposal.id,
      layerId: malformedProposal.layerId,
      status: 'new',
      artifactKind: malformedProposal.artifactKind,
      problemSummary: malformedProposal.problemSummary,
      proposedSpecJson: JSON.stringify(malformed),
      expectedImpactJson: JSON.stringify(malformedProposal.expectedImpact),
      threshold: malformedProposal.threshold,
      capabilitySnapshotJson: JSON.stringify(malformedProposal.capabilitySnapshot),
      mintedByRunId: malformedProposal.mintedByRunId,
      mintedAt: malformedProposal.mintedAt,
    });

    const llm = createProgrammableLlm(); // no replies enqueued — must not be called
    const deps = buildSandboxDeps(fx);
    const result = await runSandbox(
      malformedProposal,
      [{ id: crypto.randomUUID(), messageId: ev1.messageId, clusterReason: 'zero-hit-retrieval' }],
      {
        llm,
        db: fx.db,
        bus: fx.bus,
        capabilityRegistry: deps.capabilityRegistry,
        artifactsRepo: deps.artifactsRepo,
        conversationsRepo: deps.conversationsRepo,
        messagesRepo: deps.messagesRepo,
        getEntityStore: () => null,
        logger: noopLogger,
      },
    );

    expect('err' in result).toBe(true);
    if (!('err' in result)) return;
    expect(result.err.error).toBe('unknown_handler_kind');
    expect(deps.artifactsRepo.listByProposal(malformedProposal.id).length).toBe(0);
    expect(llm.calls.length).toBe(0);
  });

  it('cap-at-5: feeds 7 evidence messages, only 5 are replayed', async () => {
    const llm = createProgrammableLlm();
    // 5 evidence × 2 variants × 3 steps = 30 calls.
    enqueueReplay(llm, 10);

    const evidenceIds: string[] = [];
    for (let i = 0; i < 7; i += 1) {
      const ev = seedEvidenceMessage(fx, {
        layerId: LAYER_X,
        userContent: `evidence #${i}`,
      });
      evidenceIds.push(ev.messageId);
    }
    const proposalsRepo = createImprovementProposalsRepo(fx.db);
    const proposal = buildProposal({ layerId: LAYER_X, spec: skillSpec('cap-test') });
    proposalsRepo.insertProposal({
      id: proposal.id,
      layerId: proposal.layerId,
      status: 'new',
      artifactKind: proposal.artifactKind,
      problemSummary: proposal.problemSummary,
      proposedSpecJson: JSON.stringify(proposal.proposedSpec),
      expectedImpactJson: JSON.stringify(proposal.expectedImpact),
      threshold: proposal.threshold,
      capabilitySnapshotJson: JSON.stringify(proposal.capabilitySnapshot),
      mintedByRunId: proposal.mintedByRunId,
      mintedAt: proposal.mintedAt,
    });
    const deps = buildSandboxDeps(fx);
    const result = await runSandbox(
      proposal,
      evidenceIds.map((id) => ({
        id: crypto.randomUUID(),
        messageId: id,
        clusterReason: 'zero-hit-retrieval' as const,
      })),
      {
        llm,
        db: fx.db,
        bus: fx.bus,
        capabilityRegistry: deps.capabilityRegistry,
        artifactsRepo: deps.artifactsRepo,
        conversationsRepo: deps.conversationsRepo,
        messagesRepo: deps.messagesRepo,
        getEntityStore: () => null,
        logger: noopLogger,
      },
    );

    expect('ok' in result).toBe(true);
    if (!('ok' in result)) return;
    expect(result.ok.current.messages.length).toBe(5);
    expect(result.ok.proposed.messages.length).toBe(5);
  });

  it('phase 7.5: proposed-variant prompt contains the skill fragment (real delta)', async () => {
    // The orchestrator's answer-step now consults the registry's
    // overlay view and injects `promptFragment` as an extra system
    // message. The mock LLM captures every prompt, so we can assert
    // the proposed-variant answerer saw the fragment while the
    // current-variant didn't. This pins the "real delta" contract
    // that replaces the phase-7.4 synthetic thumbs-score heuristic.
    const llm = createProgrammableLlm();
    enqueueReplay(llm, 2); // 1 evidence × 2 variants × 3 steps = 6

    const ev = seedEvidenceMessage(fx, {
      layerId: LAYER_X,
      userContent: 'when do I meet Acmé?',
    });
    const proposalsRepo = createImprovementProposalsRepo(fx.db);
    const evidenceRepo = createImprovementProposalEvidenceRepo(fx.db);
    const distinctiveFragment = 'PHASE-7-5-MARKER: expand Acmé alias to Acme';
    const proposal = buildProposal({
      layerId: LAYER_X,
      spec: {
        artifactKind: 'skill',
        name: 'expand-acme-marker',
        description: 'expand acme alias',
        intent: 'question.entity_lookup',
        promptFragment: distinctiveFragment,
        addressesTags: ['zero-hit-retrieval'],
      },
    });
    proposalsRepo.insertProposal({
      id: proposal.id,
      layerId: proposal.layerId,
      status: 'new',
      artifactKind: proposal.artifactKind,
      problemSummary: proposal.problemSummary,
      proposedSpecJson: JSON.stringify(proposal.proposedSpec),
      expectedImpactJson: JSON.stringify(proposal.expectedImpact),
      threshold: proposal.threshold,
      capabilitySnapshotJson: JSON.stringify(proposal.capabilitySnapshot),
      mintedByRunId: proposal.mintedByRunId,
      mintedAt: proposal.mintedAt,
    });
    evidenceRepo.insertMany([
      {
        id: crypto.randomUUID(),
        proposalId: proposal.id,
        messageId: ev.messageId,
        clusterReason: 'zero-hit-retrieval',
      },
    ]);
    const deps = buildSandboxDeps(fx);
    const result = await runSandbox(
      proposal,
      [{ id: crypto.randomUUID(), messageId: ev.messageId, clusterReason: 'zero-hit-retrieval' }],
      {
        llm,
        db: fx.db,
        bus: fx.bus,
        capabilityRegistry: deps.capabilityRegistry,
        artifactsRepo: deps.artifactsRepo,
        conversationsRepo: deps.conversationsRepo,
        messagesRepo: deps.messagesRepo,
        getEntityStore: () => null,
        logger: noopLogger,
      },
    );

    expect('ok' in result).toBe(true);
    if (!('ok' in result)) return;

    // The orchestrator drove 3 LLM calls per replay × 2 variants.
    // Only the `answer` step receives the system-prompt fragment.
    // The proposed-variant `answer` calls are the second half (LLM
    // calls are FIFO; current runs first).
    const answerCalls = llm.calls.filter((c) => c.step === 'answer');
    expect(answerCalls.length).toBe(2);
    const [currentAnswer, proposedAnswer] = answerCalls;
    const currentPrompt = currentAnswer?.messages.map((m) => m.content).join('\n') ?? '';
    const proposedPrompt = proposedAnswer?.messages.map((m) => m.content).join('\n') ?? '';
    expect(currentPrompt).not.toContain(distinctiveFragment);
    expect(proposedPrompt).toContain(distinctiveFragment);

    // Metrics must derive from the real transcript (synthetic
    // thumbs-score heuristic removed in 7.5): the proposed variant's
    // `tokensIn` is strictly greater than the current variant's
    // because the answer step's prompt now carries an extra system
    // message. The runner's per-message comparison gives +1 per
    // grown message; here we have 1 message.
    expect(result.ok.metrics.proposed.tokensIn).toBeGreaterThan(result.ok.metrics.current.tokensIn);
    expect(result.ok.metrics.thumbsUpDelta).toBeGreaterThan(0);
  });

  it('cross-layer evidence guard: layer-X proposal + layer-Y evidence → err, no rows', async () => {
    const ev = seedEvidenceMessage(fx, {
      layerId: LAYER_Y, // belongs to layer Y
      userContent: 'wrong layer',
    });
    const proposalsRepo = createImprovementProposalsRepo(fx.db);
    const proposal = buildProposal({ layerId: LAYER_X, spec: skillSpec('cross-layer') });
    proposalsRepo.insertProposal({
      id: proposal.id,
      layerId: proposal.layerId,
      status: 'new',
      artifactKind: proposal.artifactKind,
      problemSummary: proposal.problemSummary,
      proposedSpecJson: JSON.stringify(proposal.proposedSpec),
      expectedImpactJson: JSON.stringify(proposal.expectedImpact),
      threshold: proposal.threshold,
      capabilitySnapshotJson: JSON.stringify(proposal.capabilitySnapshot),
      mintedByRunId: proposal.mintedByRunId,
      mintedAt: proposal.mintedAt,
    });

    const llm = createProgrammableLlm();
    const deps = buildSandboxDeps(fx);
    const result = await runSandbox(
      proposal,
      [{ id: crypto.randomUUID(), messageId: ev.messageId, clusterReason: 'zero-hit-retrieval' }],
      {
        llm,
        db: fx.db,
        bus: fx.bus,
        capabilityRegistry: deps.capabilityRegistry,
        artifactsRepo: deps.artifactsRepo,
        conversationsRepo: deps.conversationsRepo,
        messagesRepo: deps.messagesRepo,
        getEntityStore: () => null,
        logger: noopLogger,
      },
    );

    expect('err' in result).toBe(true);
    if (!('err' in result)) return;
    expect(result.err.error).toBe('cross_layer_evidence');
    expect(deps.artifactsRepo.listByProposal(proposal.id).length).toBe(0);
    expect(llm.calls.length).toBe(0);
  });
});
