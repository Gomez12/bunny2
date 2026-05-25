/**
 * Per-layer chat model — orchestrator wiring.
 *
 * Asserts that:
 *   1. `chatModelForLayer` returns the layer value when set, the
 *      system default otherwise (resolver unit).
 *   2. `runPipeline` stamps `llm_calls.model_source = 'layer' | 'system'`
 *      on every LLM-backed step row.
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
import { createLayerChatSettingsRepo } from '../../src/chat/repos/layer-chat-settings-repo';
import {
  createChatModelResolver,
  runPipeline,
  type EntityStoreForRetrieval,
} from '../../src/chat/pipeline';
import { createProgrammableLlm } from '../_helpers/programmable-llm';

const now = (): string => new Date().toISOString();

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly userId: string;
  readonly layerId: string;
}

function newFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-per-layer-model-'));
  const db = openDatabase(dir);
  const user = createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username: 'alice',
    displayName: 'Alice',
    passwordHash: 'h',
    mustChangePassword: false,
    now: now(),
  });
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'team-a',
    name: 'Team A',
    now: now(),
  });
  return { dir, db, bus: new InMemoryMessageBus(), userId: user.id, layerId: layer.id };
}

function closeFixture(fx: Fixture): void {
  fx.db.close();
  try {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function seedConversationAndUserMessage(fx: Fixture, userContent: string): {
  conversationId: string;
  userMessageId: string;
} {
  const convRepo = createChatConversationsRepo(fx.db);
  const msgRepo = createChatMessagesRepo(fx.db);
  const conv = convRepo.insertConversation({
    id: crypto.randomUUID(),
    layerId: fx.layerId,
    userId: fx.userId,
    title: 't',
    locale: 'en',
    now: now(),
  });
  const userMsg = msgRepo.insertMessage({
    id: crypto.randomUUID(),
    conversationId: conv.id,
    role: 'user',
    content: userContent,
    status: 'done',
    correlationId: crypto.randomUUID(),
    flowId: conv.id,
    now: now(),
  });
  return { conversationId: conv.id, userMessageId: userMsg.id };
}

const emptyStore: EntityStoreForRetrieval = {
  async searchSummaries() {
    return [];
  },
};

function enqueueHappyPath(llm: ReturnType<typeof createProgrammableLlm>): void {
  llm.enqueue('intent', { content: JSON.stringify({ intent: 'smalltalk' }) });
  llm.enqueue('entities', { content: JSON.stringify({ kinds: [], queryHints: [] }) });
  llm.enqueue('answer', { content: 'Hi there!' });
}

describe('chat model resolver', () => {
  it('returns the layer override when present, system default otherwise', () => {
    const fx = newFixture();
    try {
      const repo = createLayerChatSettingsRepo(fx.db);
      const resolver = createChatModelResolver({
        settingsRepo: repo,
        systemDefault: 'system-default',
      });

      // No row — falls back to system default.
      expect(resolver.resolve(fx.layerId)).toEqual({
        model: 'system-default',
        source: 'system',
      });

      // Row with model — layer wins.
      repo.upsert({
        layerId: fx.layerId,
        model: 'gpt-4o-mini',
        embeddingDailyCap: null,
        embeddingMonthlyCap: null,
        now: now(),
      });
      expect(resolver.resolve(fx.layerId)).toEqual({
        model: 'gpt-4o-mini',
        source: 'layer',
      });

      // Row with NULL model — falls back to system default.
      repo.upsert({
        layerId: fx.layerId,
        model: null,
        embeddingDailyCap: null,
        embeddingMonthlyCap: null,
        now: now(),
      });
      expect(resolver.resolve(fx.layerId)).toEqual({
        model: 'system-default',
        source: 'system',
      });
    } finally {
      closeFixture(fx);
    }
  });
});

describe('runPipeline llm_calls.model_source', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = newFixture();
  });
  afterEach(() => {
    closeFixture(fx);
  });

  it('stamps model_source = system when no layer override exists', async () => {
    const llm = createProgrammableLlm({ defaultModel: 'system-default' });
    enqueueHappyPath(llm);

    const seed = seedConversationAndUserMessage(fx, 'hello');
    const repo = createLayerChatSettingsRepo(fx.db);
    const resolver = createChatModelResolver({
      settingsRepo: repo,
      systemDefault: llm.defaultModel,
    });

    await runPipeline(
      {
        conversationId: seed.conversationId,
        userMessageId: seed.userMessageId,
        userContent: 'hello',
        layerId: fx.layerId,
        effectiveLayerIds: [fx.layerId],
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
        getEntityStore: () => emptyStore,
        chatModelResolver: resolver,
      },
    );

    const rows = fx.db
      .query<{ model_source: string | null }, []>(
        'SELECT model_source FROM llm_calls ORDER BY started_at ASC',
      )
      .all();
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.model_source === 'system')).toBe(true);
  });

  it('stamps model_source = layer when the layer overrides the model', async () => {
    const llm = createProgrammableLlm({ defaultModel: 'system-default' });
    enqueueHappyPath(llm);

    const seed = seedConversationAndUserMessage(fx, 'hello');
    const repo = createLayerChatSettingsRepo(fx.db);
    repo.upsert({
      layerId: fx.layerId,
      model: 'gpt-4o-mini',
      embeddingDailyCap: null,
      embeddingMonthlyCap: null,
      now: now(),
    });
    const resolver = createChatModelResolver({
      settingsRepo: repo,
      systemDefault: llm.defaultModel,
    });

    await runPipeline(
      {
        conversationId: seed.conversationId,
        userMessageId: seed.userMessageId,
        userContent: 'hello',
        layerId: fx.layerId,
        effectiveLayerIds: [fx.layerId],
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
        getEntityStore: () => emptyStore,
        chatModelResolver: resolver,
      },
    );

    const rows = fx.db
      .query<{ model_source: string | null }, []>(
        'SELECT model_source FROM llm_calls ORDER BY started_at ASC',
      )
      .all();
    expect(rows.length).toBe(3);
    expect(rows.every((r) => r.model_source === 'layer')).toBe(true);
  });
});
