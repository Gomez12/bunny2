/**
 * Phase 6.3 — pipeline orchestrator integration tests.
 *
 * Pins the headline contract from the plan §6:
 *   - 1 `chat_pipeline_runs` row per message.
 *   - 4 `chat_pipeline_steps` rows in (intent, entities, retrieval, answer) order.
 *   - 3 `llm_calls` rows (router + resolver + answerer); retrieval has none.
 *   - 1 assistant `chat_messages` row with `tokens_in` / `tokens_out` set.
 *   - The auth-boundary contract (`overall.md` §5 invariant 8): a question
 *     that would match an entity in another layer is never surfaced.
 *   - The §11 zod-retry policy: intent parse failure → retry once → on
 *     the second failure mark step `failed` + answer = graceful fallback.
 *   - The §4.1 `command.*` short-circuit: answer step `skipped`,
 *     assistant message contains the canned "not yet supported" line.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createSqliteLlmCallLog } from '../../src/llm/call-log';
import { createChatConversationsRepo } from '../../src/chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../../src/chat/repos/chat-messages-repo';
import { createChatPipelineRunsRepo } from '../../src/chat/repos/chat-pipeline-runs-repo';
import { createChatPipelineStepsRepo } from '../../src/chat/repos/chat-pipeline-steps-repo';
import {
  runPipeline,
  COMMAND_NOT_SUPPORTED_MESSAGE,
  type EntityKind,
  type EntityStoreForRetrieval,
} from '../../src/chat/pipeline';
import { createProgrammableLlm } from '../_helpers/programmable-llm';

const now = () => new Date().toISOString();

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly userId: string;
  readonly layerAId: string;
  readonly layerBId: string;
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-chat-pipeline-'));
}

function newFixture(): Fixture {
  const dir = mkTmp();
  const db = openDatabase(dir);
  const usersRepo = createUsersRepo(db);
  const layersRepo = createLayersRepo(db);
  const user = usersRepo.createUser({
    id: crypto.randomUUID(),
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'h',
    mustChangePassword: false,
    now: now(),
  });
  const layerA = layersRepo.insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'team-a',
    name: 'Team A',
    now: now(),
  });
  const layerB = layersRepo.insertLayer({
    id: crypto.randomUUID(),
    type: 'project',
    slug: 'team-b',
    name: 'Team B',
    now: now(),
  });
  return {
    dir,
    db,
    bus: new InMemoryMessageBus(),
    userId: user.id,
    layerAId: layerA.id,
    layerBId: layerB.id,
  };
}

function closeFixture(fx: Fixture): void {
  fx.db.close();
  // Tempdir cleanup is best-effort on every OS; ignore failures.
  try {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

interface SeededEntity {
  readonly id: string;
  readonly layerId: string;
  readonly slug: string;
  readonly title: string;
  readonly searchableText: string;
}

/**
 * In-memory entity store stub. Holds rows for one kind; matches the
 * narrow `EntityStoreForRetrieval` interface so the orchestrator
 * doesn't need the full phase-4 store factory.
 */
function createStubEntityStore(kind: EntityKind, rows: SeededEntity[]): EntityStoreForRetrieval {
  return {
    searchSummaries(layerIds, query, opts) {
      const limit = opts?.limit ?? 50;
      const needle = query.toLowerCase();
      return rows
        .filter((r) => layerIds.includes(r.layerId))
        .filter(
          (r) =>
            r.title.toLowerCase().includes(needle) ||
            r.searchableText.toLowerCase().includes(needle),
        )
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          kind,
          layerId: r.layerId,
          slug: r.slug,
          title: r.title,
          searchableText: r.searchableText,
        }));
    },
  };
}

function seedConversationAndUserMessage(
  fx: Fixture,
  layerId: string,
  content: string,
): {
  readonly conversationId: string;
  readonly userMessageId: string;
} {
  const convRepo = createChatConversationsRepo(fx.db);
  const msgRepo = createChatMessagesRepo(fx.db);
  const conv = convRepo.insertConversation({
    id: crypto.randomUUID(),
    layerId,
    userId: fx.userId,
    title: content.slice(0, 60),
    locale: 'en',
    now: now(),
  });
  const userMsg = msgRepo.insertMessage({
    id: crypto.randomUUID(),
    conversationId: conv.id,
    role: 'user',
    content,
    status: 'done',
    correlationId: crypto.randomUUID(),
    flowId: conv.id,
    now: now(),
  });
  return { conversationId: conv.id, userMessageId: userMsg.id };
}

describe('phase 6.3 — chat pipeline orchestrator', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = newFixture();
  });

  afterEach(() => {
    closeFixture(fx);
  });

  it('happy path: 1 run + 4 steps + 3 llm_calls + assistant message tokens', async () => {
    const llm = createProgrammableLlm();
    llm.enqueue('intent', {
      content: JSON.stringify({ intent: 'question.entity_lookup', confidence: 0.9 }),
    });
    llm.enqueue('entities', {
      content: JSON.stringify({
        kinds: ['calendar_event'],
        queryHints: [{ term: 'acme', kind: 'calendar_event' }],
      }),
    });
    llm.enqueue('answer', {
      content: 'Your Acme strategy meeting is on 2026-06-01 at 10:00.',
    });

    const calendarStore = createStubEntityStore('calendar_event', [
      {
        id: crypto.randomUUID(),
        layerId: fx.layerAId,
        slug: 'acme-strategy',
        title: 'Acme strategy',
        searchableText: 'acme strategy meeting on 2026-06-01 at 10:00 acme corp',
      },
    ]);

    const seed = seedConversationAndUserMessage(fx, fx.layerAId, 'When do I meet Acme?');

    const result = await runPipeline(
      {
        conversationId: seed.conversationId,
        userMessageId: seed.userMessageId,
        userContent: 'When do I meet Acme?',
        layerId: fx.layerAId,
        effectiveLayerIds: [fx.layerAId],
        userId: fx.userId,
      },
      {
        db: fx.db,
        bus: fx.bus,
        llm,
        llmCallLog: createSqliteLlmCallLog(fx.db),
        conversationsRepo: createChatConversationsRepo(fx.db),
        messagesRepo: createChatMessagesRepo(fx.db),
        runsRepo: createChatPipelineRunsRepo(fx.db),
        stepsRepo: createChatPipelineStepsRepo(fx.db),
        getEntityStore: (kind) => (kind === 'calendar_event' ? calendarStore : null),
      },
    );

    expect(result.status).toBe('done');
    expect(result.assistantContent).toContain('Acme strategy meeting');

    // 1 run row, 4 step rows, 3 llm_calls rows.
    const runRows = fx.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM chat_pipeline_runs')
      .get();
    expect(runRows?.n).toBe(1);
    const stepRows = fx.db
      .query<
        { kind: string; status: string; attempt: number; llm_call_id: string | null },
        []
      >('SELECT kind, status, attempt, llm_call_id FROM chat_pipeline_steps ORDER BY started_at ASC')
      .all();
    expect(stepRows.map((r) => r.kind)).toEqual(['intent', 'entities', 'retrieval', 'answer']);
    expect(stepRows.every((r) => r.status === 'succeeded')).toBe(true);
    expect(stepRows.every((r) => r.attempt === 1)).toBe(true);
    // intent / entities / answer have llm_call_id; retrieval doesn't.
    expect(stepRows[0]?.llm_call_id).not.toBeNull();
    expect(stepRows[1]?.llm_call_id).not.toBeNull();
    expect(stepRows[2]?.llm_call_id).toBeNull();
    expect(stepRows[3]?.llm_call_id).not.toBeNull();

    const llmCallsCount = fx.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM llm_calls')
      .get();
    expect(llmCallsCount?.n).toBe(3);

    const assistant = fx.db
      .query<
        { content: string; status: string; tokens_in: number | null; tokens_out: number | null },
        [string]
      >('SELECT content, status, tokens_in, tokens_out FROM chat_messages WHERE id = ?')
      .get(result.assistantMessageId);
    expect(assistant?.status).toBe('done');
    expect(assistant?.tokens_in).not.toBeNull();
    expect(assistant?.tokens_out).not.toBeNull();
    expect(typeof assistant?.tokens_in).toBe('number');
    expect(typeof assistant?.tokens_out).toBe('number');
  });

  it('auth boundary: layer-B rows never reach retrieval or the answerer (overall §5 invariant 8)', async () => {
    const llm = createProgrammableLlm();
    llm.enqueue('intent', {
      content: JSON.stringify({ intent: 'question.entity_lookup' }),
    });
    llm.enqueue('entities', {
      content: JSON.stringify({
        kinds: ['company'],
        queryHints: [{ term: 'secret', kind: 'company' }],
      }),
    });
    llm.enqueue('answer', {
      content: "I don't know — I have no records matching that.",
    });

    // Same kind, two different layers. Alice's effective layers are
    // [layer-A] only; the layer-B row must never surface.
    const companyStore = createStubEntityStore('company', [
      {
        id: 'company-A-1',
        layerId: fx.layerAId,
        slug: 'visible-corp',
        title: 'Visible Corp',
        searchableText: 'visible nothing matching',
      },
      {
        id: 'company-B-secret',
        layerId: fx.layerBId,
        slug: 'secret-corp',
        title: 'Secret Corp',
        searchableText: 'secret cross-layer leak target',
      },
    ]);

    const seed = seedConversationAndUserMessage(fx, fx.layerAId, 'find the secret company');

    await runPipeline(
      {
        conversationId: seed.conversationId,
        userMessageId: seed.userMessageId,
        userContent: 'find the secret company',
        layerId: fx.layerAId,
        effectiveLayerIds: [fx.layerAId],
        userId: fx.userId,
      },
      {
        db: fx.db,
        bus: fx.bus,
        llm,
        llmCallLog: createSqliteLlmCallLog(fx.db),
        conversationsRepo: createChatConversationsRepo(fx.db),
        messagesRepo: createChatMessagesRepo(fx.db),
        runsRepo: createChatPipelineRunsRepo(fx.db),
        stepsRepo: createChatPipelineStepsRepo(fx.db),
        getEntityStore: (kind) => (kind === 'company' ? companyStore : null),
      },
    );

    const retrievalRow = fx.db
      .query<
        { output_json: string | null },
        []
      >("SELECT output_json FROM chat_pipeline_steps WHERE kind = 'retrieval'")
      .get();
    expect(retrievalRow?.output_json).not.toBeNull();
    expect(retrievalRow!.output_json!).not.toContain('Secret Corp');
    expect(retrievalRow!.output_json!).not.toContain('company-B-secret');
    expect(retrievalRow!.output_json!).not.toContain('cross-layer leak');

    // The answerer's prompt is the LAST llm_calls.request row.
    const answerCall = fx.db
      .query<
        { request: string },
        []
      >('SELECT request FROM llm_calls ORDER BY started_at DESC LIMIT 1')
      .get();
    expect(answerCall?.request).not.toBeNull();
    expect(answerCall!.request).not.toContain('Secret Corp');
    expect(answerCall!.request).not.toContain('company-B-secret');
    expect(answerCall!.request).not.toContain('cross-layer leak');
  });

  it('intent parse failure: retries once, marks step failed, message ends gracefully', async () => {
    const llm = createProgrammableLlm();
    // Both attempts return invalid JSON.
    llm.enqueue('intent', { content: 'this is not json at all' });
    llm.enqueue('intent', { content: 'still not { json' });

    const seed = seedConversationAndUserMessage(fx, fx.layerAId, 'hello');

    const failedEvents: string[] = [];
    fx.bus.subscribe('chat.step.failed', (event) => {
      const payload = event.payload as { errorCode: string };
      failedEvents.push(payload.errorCode);
    });

    const result = await runPipeline(
      {
        conversationId: seed.conversationId,
        userMessageId: seed.userMessageId,
        userContent: 'hello',
        layerId: fx.layerAId,
        effectiveLayerIds: [fx.layerAId],
        userId: fx.userId,
      },
      {
        db: fx.db,
        bus: fx.bus,
        llm,
        llmCallLog: createSqliteLlmCallLog(fx.db),
        conversationsRepo: createChatConversationsRepo(fx.db),
        messagesRepo: createChatMessagesRepo(fx.db),
        runsRepo: createChatPipelineRunsRepo(fx.db),
        stepsRepo: createChatPipelineStepsRepo(fx.db),
        getEntityStore: () => null,
      },
    );

    expect(result.status).toBe('failed');
    // Two intent step rows (attempt 1 + attempt 2), both failed.
    const intentRows = fx.db
      .query<
        { status: string; attempt: number; error_code: string | null },
        []
      >("SELECT status, attempt, error_code FROM chat_pipeline_steps WHERE kind = 'intent' ORDER BY attempt ASC")
      .all();
    expect(intentRows).toHaveLength(2);
    expect(intentRows[0]?.status).toBe('failed');
    expect(intentRows[1]?.status).toBe('failed');
    expect(intentRows[0]?.error_code).toBe('invalid_step_output');
    expect(intentRows[1]?.error_code).toBe('invalid_step_output');

    // Bus surfaced at least one chat.step.failed.
    expect(failedEvents).toContain('invalid_step_output');

    // Assistant message ended `failed` with the graceful fallback.
    const assistant = fx.db
      .query<
        { status: string; content: string },
        [string]
      >('SELECT status, content FROM chat_messages WHERE id = ?')
      .get(result.assistantMessageId);
    expect(assistant?.status).toBe('failed');
    expect(assistant?.content).toContain("I couldn't process that");
  });

  it('command.* short-circuit: answer step is skipped, assistant message is the canned reply', async () => {
    const llm = createProgrammableLlm();
    llm.enqueue('intent', {
      content: JSON.stringify({ intent: 'command.create' }),
    });
    llm.enqueue('entities', {
      content: JSON.stringify({ kinds: [], queryHints: [] }),
    });
    // No 'answer' reply enqueued — the step must NOT call the LLM.

    const seed = seedConversationAndUserMessage(fx, fx.layerAId, 'please create a new contact');

    const result = await runPipeline(
      {
        conversationId: seed.conversationId,
        userMessageId: seed.userMessageId,
        userContent: 'please create a new contact',
        layerId: fx.layerAId,
        effectiveLayerIds: [fx.layerAId],
        userId: fx.userId,
      },
      {
        db: fx.db,
        bus: fx.bus,
        llm,
        llmCallLog: createSqliteLlmCallLog(fx.db),
        conversationsRepo: createChatConversationsRepo(fx.db),
        messagesRepo: createChatMessagesRepo(fx.db),
        runsRepo: createChatPipelineRunsRepo(fx.db),
        stepsRepo: createChatPipelineStepsRepo(fx.db),
        getEntityStore: () => null,
      },
    );

    expect(result.status).toBe('done');
    expect(result.assistantContent).toBe(COMMAND_NOT_SUPPORTED_MESSAGE);

    // Four step rows; the answer row is `skipped`.
    const stepRows = fx.db
      .query<
        { kind: string; status: string },
        []
      >('SELECT kind, status FROM chat_pipeline_steps ORDER BY started_at ASC')
      .all();
    expect(stepRows.map((r) => r.kind)).toEqual(['intent', 'entities', 'retrieval', 'answer']);
    const answer = stepRows.find((r) => r.kind === 'answer');
    expect(answer?.status).toBe('skipped');
    // Retrieval is skipped for command.* too.
    const retrieval = stepRows.find((r) => r.kind === 'retrieval');
    expect(retrieval?.status).toBe('skipped');

    // Exactly two llm_calls (router + resolver). No answerer call.
    const calls = fx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM llm_calls').get();
    expect(calls?.n).toBe(2);
  });

  it('publishes chat.message.received + chat.message.answered on success', async () => {
    const llm = createProgrammableLlm();
    llm.enqueue('intent', {
      content: JSON.stringify({ intent: 'smalltalk' }),
    });
    llm.enqueue('entities', {
      content: JSON.stringify({ kinds: [], queryHints: [] }),
    });
    llm.enqueue('answer', { content: 'Hi there!' });

    const seen: string[] = [];
    for (const t of [
      'chat.message.received',
      'chat.message.answered',
      'chat.message.failed',
      'chat.step.started',
      'chat.step.succeeded',
      'chat.step.failed',
    ]) {
      fx.bus.subscribe(t, () => {
        seen.push(t);
      });
    }

    const seed = seedConversationAndUserMessage(fx, fx.layerAId, 'hi');

    await runPipeline(
      {
        conversationId: seed.conversationId,
        userMessageId: seed.userMessageId,
        userContent: 'hi',
        layerId: fx.layerAId,
        effectiveLayerIds: [fx.layerAId],
        userId: fx.userId,
      },
      {
        db: fx.db,
        bus: fx.bus,
        llm,
        llmCallLog: createSqliteLlmCallLog(fx.db),
        conversationsRepo: createChatConversationsRepo(fx.db),
        messagesRepo: createChatMessagesRepo(fx.db),
        runsRepo: createChatPipelineRunsRepo(fx.db),
        stepsRepo: createChatPipelineStepsRepo(fx.db),
        getEntityStore: () => null,
      },
    );

    expect(seen).toContain('chat.message.received');
    expect(seen).toContain('chat.message.answered');
    expect(seen).not.toContain('chat.message.failed');
    // 4 started + 4 succeeded (retrieval is `chat.step.succeeded` with status='skipped').
    expect(seen.filter((t) => t === 'chat.step.started')).toHaveLength(4);
    expect(seen.filter((t) => t === 'chat.step.succeeded')).toHaveLength(4);
  });
});
