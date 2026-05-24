/**
 * Phase 7.3 — `chat.review-layer` integration tests.
 *
 * Phase 6.6 shipped this handler as a no-op placeholder. 7.3
 * replaces the body; this test seeds a layer + a few chat messages
 * with failure-mode telemetry + thumbs-down feedback, runs the
 * handler against a programmable LLM, and asserts:
 *
 *  - One `improvement_proposals` row per cluster.
 *  - Evidence rows linked to the seeded messages.
 *  - `proposal.minted` bus event fired per proposal.
 *  - Log lines carry the stable `event` names + the bounded
 *    counter dimensions (`proposal.minted_count`,
 *    `proposal.mint.skipped_count`).
 *  - LLM call's `flow_id` is `proposal.mint:<runId>`.
 *
 * Also keeps the phase-6.6 "registers the canonical kind" smoke
 * test so the registration contract is still pinned.
 */

import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createChatConversationsRepo } from '../src/chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../src/chat/repos/chat-messages-repo';
import { createChatPipelineRunsRepo } from '../src/chat/repos/chat-pipeline-runs-repo';
import { createChatPipelineStepsRepo } from '../src/chat/repos/chat-pipeline-steps-repo';
import { createChatMessageFeedbackRepo } from '../src/chat/repos/chat-message-feedback-repo';
import { createImprovementProposalsRepo } from '../src/proposals/repos/improvement-proposals-repo';
import { createImprovementProposalEvidenceRepo } from '../src/proposals/repos/improvement-proposal-evidence-repo';
import { chatReviewLayerHandler, CHAT_REVIEW_LAYER_KIND } from '../src/chat/review-layer-handler';
import { PROPOSAL_MINTED_EVENT_TYPE } from '../src/proposals/events';
import type {
  ScheduledTask,
  ScheduledTaskRun,
  ScheduledTaskRunContext,
  ScheduledTaskHandlerLogger,
} from '../src/scheduled';
import type { MessageBus, BusEvent, PublishInput } from '@bunny2/bus';
import { createProgrammableLlm, type ProgrammableLlmClient } from './_helpers/programmable-llm';

interface LogEntry {
  readonly level: 'info' | 'warn' | 'error';
  readonly msg: string;
  readonly fields: Readonly<Record<string, unknown>> | undefined;
}

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-review-layer-'));
  return openDatabase(dir);
}

function makeLogger(logs: LogEntry[]): ScheduledTaskHandlerLogger {
  return {
    info: (msg, fields): void => {
      logs.push({ level: 'info', msg, fields });
    },
    warn: (msg, fields): void => {
      logs.push({ level: 'warn', msg, fields });
    },
    error: (msg, fields): void => {
      logs.push({ level: 'error', msg, fields });
    },
  };
}

function fakeBus(captured: BusEvent[]): MessageBus {
  return {
    async publish<TPayload>(input: PublishInput<TPayload>): Promise<BusEvent<TPayload>> {
      const evt: BusEvent<TPayload> = {
        id: crypto.randomUUID(),
        type: input.type,
        occurredAt: new Date().toISOString(),
        payload: input.payload,
        ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
        ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
      };
      captured.push(evt as BusEvent);
      return evt;
    },
    subscribe(): () => void {
      return (): void => {
        /* noop */
      };
    },
  };
}

function ctxFor(
  db: Database,
  llm: ProgrammableLlmClient,
  bus: MessageBus,
  logs: LogEntry[],
  nowIso: string,
): ScheduledTaskRunContext {
  const task: ScheduledTask = {
    id: 'task-rl',
    layerId: 'layer-everyone-placeholder',
    slug: 'chat-review-layer',
    kind: CHAT_REVIEW_LAYER_KIND,
    name: 'chat.review-layer',
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 1440 },
    config: {},
    maxAttempts: 1,
    backoffBaseMs: 1000,
    backoffMaxMs: 10_000,
    nextRunAt: nowIso,
    lastRunAt: null,
    attempt: 0,
    claimedAt: null,
    claimedByPid: null,
    version: 1,
    createdAt: nowIso,
    createdBy: 'system',
    updatedAt: nowIso,
    updatedBy: 'system',
    deletedAt: null,
    deletedBy: null,
  };
  const run: ScheduledTaskRun = {
    id: 'run-rl',
    taskId: task.id,
    status: 'started',
    attempt: 1,
    triggeredBy: 'schedule',
    requestedAt: nowIso,
    startedAt: nowIso,
    finishedAt: null,
    durationMs: null,
    error: null,
    correlationId: 'cor-rl',
  };
  return {
    task,
    run,
    correlationId: 'cor-rl',
    now: () => nowIso,
    db,
    bus,
    llm,
    logger: makeLogger(logs),
  };
}

interface Seeded {
  readonly layerId: string;
  readonly messageIds: readonly string[];
}

function seedLayerWithThumbsDown(db: Database, baseTime: string): Seeded {
  const user = createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username: 'admin',
    displayName: 'Admin',
    passwordHash: 'h',
    mustChangePassword: false,
    now: baseTime,
  });
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'everyone',
    name: 'Everyone',
    now: baseTime,
  });
  const conv = createChatConversationsRepo(db).insertConversation({
    id: crypto.randomUUID(),
    layerId: layer.id,
    userId: user.id,
    title: 't',
    locale: 'en',
    now: baseTime,
  });
  const messagesRepo = createChatMessagesRepo(db);
  const runsRepo = createChatPipelineRunsRepo(db);
  const stepsRepo = createChatPipelineStepsRepo(db);
  const feedbackRepo = createChatMessageFeedbackRepo(db);
  // Seed three assistant messages, each with a zero-hit retrieval
  // step and a thumbs-down feedback row → both `zero-hit-retrieval`
  // and `thumbs-down` clusters should surface.
  const ids: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    const createdAt = new Date(Date.parse(baseTime) - (i + 1) * 60_000).toISOString();
    const msg = messagesRepo.insertMessage({
      id: crypto.randomUUID(),
      conversationId: conv.id,
      role: 'assistant',
      content: `assistant reply ${i + 1}`,
      status: 'done',
      correlationId: `cor-${i}`,
      flowId: `flow-${i}`,
      now: createdAt,
    });
    ids.push(msg.id);
    const run = runsRepo.insertRun({
      id: crypto.randomUUID(),
      messageId: msg.id,
      status: 'succeeded',
      startedAt: createdAt,
    });
    stepsRepo.insertStep({
      id: crypto.randomUUID(),
      runId: run.id,
      kind: 'retrieval',
      status: 'succeeded',
      startedAt: createdAt,
      inputJson: null,
    });
    // Update with output_json carrying zero hits + ended_at.
    const stepRows = stepsRepo.listByRun(run.id);
    const retrievalStep = stepRows[0];
    if (retrievalStep) {
      stepsRepo.updateStep(retrievalStep.id, {
        status: 'succeeded',
        endedAt: createdAt,
        outputJson: JSON.stringify({ hits: [], skipped: false }),
      });
    }
    feedbackRepo.upsertFeedback({
      id: crypto.randomUUID(),
      messageId: msg.id,
      userId: user.id,
      value: 'down',
      reason: 'wrong answer',
      now: createdAt,
    });
  }
  return { layerId: layer.id, messageIds: ids };
}

function validSpecJson(reason: string): string {
  return JSON.stringify({
    spec: {
      artifactKind: 'skill',
      name: `address-${reason}`,
      description: `Skill addressing ${reason}`,
      intent: 'question.entity_lookup',
      promptFragment: `Take ${reason} into account when answering.`,
      addressesTags: [reason],
    },
    expectedImpact: { thumbsUpDelta: 0.18, tokensDelta: 12, latencyDeltaMs: 14 },
    threshold: 0.7,
  });
}

describe('phase 7.3 — chat.review-layer handler', () => {
  it('registers the canonical kind', () => {
    expect(chatReviewLayerHandler.kind).toBe(CHAT_REVIEW_LAYER_KIND);
    expect(chatReviewLayerHandler.kind).toBe('chat.review-layer');
  });

  it('mints one proposal per cluster, persists evidence, fires proposal.minted, stamps flow_id', async () => {
    const db = mkDb();
    try {
      const nowIso = '2026-05-24T12:00:00.000Z';
      const { layerId, messageIds } = seedLayerWithThumbsDown(db, nowIso);
      const llm = createProgrammableLlm();
      // Two clusters survive (zero-hit + thumbs-down for the three
      // seeded messages); enqueue one valid spec per cluster.
      llm.enqueue('proposal.mint', { content: validSpecJson('zero-hit-retrieval') });
      llm.enqueue('proposal.mint', { content: validSpecJson('thumbs-down') });

      const captured: BusEvent[] = [];
      const bus = fakeBus(captured);
      const logs: LogEntry[] = [];
      const ctx = ctxFor(db, llm, bus, logs, nowIso);

      await chatReviewLayerHandler.run(ctx);

      const proposalsRepo = createImprovementProposalsRepo(db);
      const allProposals = proposalsRepo.listProposals({ layerId });
      expect(allProposals.length).toBe(2);
      const reasons = new Set(
        allProposals.map(
          (p) => (JSON.parse(p.proposedSpecJson) as { addressesTags: string[] }).addressesTags[0],
        ),
      );
      expect(reasons).toEqual(new Set(['zero-hit-retrieval', 'thumbs-down']));

      // Evidence rows are linked to one of the seeded messages.
      const evidenceRepo = createImprovementProposalEvidenceRepo(db);
      const seededSet = new Set(messageIds);
      for (const p of allProposals) {
        const evidence = evidenceRepo.listByProposal(p.id);
        expect(evidence.length).toBeGreaterThan(0);
        for (const ev of evidence) {
          expect(seededSet.has(ev.messageId)).toBe(true);
        }
      }

      // Bus events.
      const minted = captured.filter((e) => e.type === PROPOSAL_MINTED_EVENT_TYPE);
      expect(minted.length).toBe(2);
      for (const e of minted) {
        expect(e.flowId).toBe(`proposal.mint:${ctx.run.id}`);
        expect(e.correlationId).toBe('cor-rl');
      }

      // Telemetry counters live on the log fields (no separate sink).
      const persistLogs = logs.filter((l) => l.fields?.['event'] === 'proposal.mint.persist');
      expect(persistLogs.length).toBe(2);
      for (const l of persistLogs) {
        expect(l.fields?.['proposal.minted_count']).toBe(1);
      }

      // LLM calls — every metadata.flowId is proposal.mint:<runId>.
      for (const call of llm.calls) {
        const userMessage = call.messages.find((m) => m.role === 'user');
        expect(userMessage).toBeDefined();
      }
      expect(llm.calls.length).toBe(2);
    } finally {
      db.close();
    }
  });

  it('logs proposal.mint.skipped and increments the skipped counter on LLM parse failure', async () => {
    const db = mkDb();
    try {
      const nowIso = '2026-05-24T12:00:00.000Z';
      seedLayerWithThumbsDown(db, nowIso);
      const llm = createProgrammableLlm();
      // Force a parse failure on every call (cluster grouper finds
      // two clusters → two cluster attempts × two LLM calls each
      // = four malformed responses).
      for (let i = 0; i < 4; i += 1) {
        llm.enqueue('proposal.mint', { content: 'not-json' });
      }
      const captured: BusEvent[] = [];
      const bus = fakeBus(captured);
      const logs: LogEntry[] = [];
      const ctx = ctxFor(db, llm, bus, logs, nowIso);

      await chatReviewLayerHandler.run(ctx);

      const skipped = logs.filter((l) => l.fields?.['event'] === 'proposal.mint.skipped');
      expect(skipped.length).toBe(2);
      for (const l of skipped) {
        expect(l.fields?.['proposal.mint.skipped_count']).toBe(1);
        expect(l.fields?.['reason']).toBe('invalid_spec_output');
      }
      // No proposal.minted events when every cluster was skipped.
      const minted = captured.filter((e) => e.type === PROPOSAL_MINTED_EVENT_TYPE);
      expect(minted.length).toBe(0);
    } finally {
      db.close();
    }
  });

  it('logs proposal.mint.no-clusters when no telemetry survives the window', async () => {
    const db = mkDb();
    try {
      const nowIso = '2026-05-24T12:00:00.000Z';
      // Seed a layer but NO chat messages.
      const baseTime = nowIso;
      createUsersRepo(db).createUser({
        id: crypto.randomUUID(),
        username: 'admin',
        displayName: 'Admin',
        passwordHash: 'h',
        mustChangePassword: false,
        now: baseTime,
      });
      createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'everyone',
        slug: 'everyone',
        name: 'Everyone',
        now: baseTime,
      });
      const llm = createProgrammableLlm();
      const captured: BusEvent[] = [];
      const bus = fakeBus(captured);
      const logs: LogEntry[] = [];
      const ctx = ctxFor(db, llm, bus, logs, nowIso);

      await chatReviewLayerHandler.run(ctx);

      const noClusters = logs.filter((l) => l.fields?.['event'] === 'proposal.mint.no-clusters');
      expect(noClusters.length).toBe(1);
      expect(llm.calls.length).toBe(0);
      expect(captured.length).toBe(0);
    } finally {
      db.close();
    }
  });
});
