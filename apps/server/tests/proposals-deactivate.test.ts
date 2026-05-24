/**
 * Phase 7.5 — `capabilityRegistry.deactivate(...)` tests.
 *
 * Pins:
 *  - Soft-deactivation updates `deactivated_at` and the registry's
 *    `listActive(...)` no longer returns the row.
 *  - `proposal.deactivated` is published exactly once with the
 *    actor's user id.
 *  - For `kind=agent`, the bus subscriber is detached (subsequent
 *    publishes don't invoke the handler).
 *  - Idempotent: deactivating an already-deactivated row is a no-op
 *    (returns null, no extra event).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { ProposalSpec } from '@bunny2/shared';
import { openDatabase } from '../src/storage/sqlite';
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';
import {
  createCapabilityRegistry,
  PROPOSAL_DEACTIVATED_EVENT_TYPE,
  resetAttachedAgentsForTest,
} from '../src/proposals';
import type { LlmClient } from '../src/llm';

const LAYER_X = '11111111-1111-1111-1111-111111111111';
const ADMIN_USER = '99999999-9999-9999-9999-999999999999';

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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-deactivate-'));
}

function newFixture(): Fixture {
  const dir = mkTmp();
  const db = openDatabase(dir, { journalMode: 'DELETE' });
  const nowIso = new Date().toISOString();
  db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO users (id, username, display_name, password_hash, must_change_password, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, ?)`,
  ).run(ADMIN_USER, 'admin', 'Admin', 'h', nowIso, nowIso);
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

function skillSpec(name: string): ProposalSpec {
  return {
    artifactKind: 'skill',
    name,
    description: 'd',
    intent: 'question.entity_lookup',
    promptFragment: 'frag',
    addressesTags: ['zero-hit-retrieval'],
  };
}

function agentSpec(name: string): ProposalSpec {
  return {
    artifactKind: 'agent',
    name,
    description: 'agent-d',
    subscribesTo: ['entity.contact.created'],
    handler: { kind: 'enrichment-call', config: { promptTemplate: 'enrich: ${term}' } },
    addressesTags: ['thumbs-down'],
  };
}

function mockLlm(): LlmClient & { calls: number } {
  let calls = 0;
  return {
    endpoint: 'mock://deactivate-llm',
    defaultModel: 'mock-default',
    async chat() {
      calls += 1;
      return { id: 'x', model: 'm', content: 'ok', tokensIn: 1, tokensOut: 1, raw: null };
    },
    get calls() {
      return calls;
    },
  } as LlmClient & { calls: number };
}

describe('phase 7.5 — capabilityRegistry.deactivate', () => {
  let fx: Fixture;
  beforeEach(() => {
    resetAttachedAgentsForTest();
    fx = newFixture();
  });
  afterEach(() => {
    closeFixture(fx);
    resetAttachedAgentsForTest();
  });

  it('soft-deactivates a skill, publishes proposal.deactivated, and listActive drops it', async () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus, logger: noopLogger });
    registry.activate({
      layerId: LAYER_X,
      kind: 'skill',
      name: 'will-die',
      spec: skillSpec('will-die'),
      origin: 'proposal:00000000-0000-0000-0000-000000000001',
    });

    const events: unknown[] = [];
    fx.bus.subscribe(PROPOSAL_DEACTIVATED_EVENT_TYPE, (e) => {
      events.push(e.payload);
    });

    const id = registry.deactivate({
      layerId: LAYER_X,
      kind: 'skill',
      name: 'will-die',
      deactivatedBy: ADMIN_USER,
    });
    expect(id).not.toBeNull();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(registry.listActive(LAYER_X)).toEqual([]);
    expect(events.length).toBe(1);
    expect((events[0] as { deactivatedBy?: string }).deactivatedBy).toBe(ADMIN_USER);
  });

  it('idempotent: deactivating twice is a no-op on the second call', async () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus, logger: noopLogger });
    registry.activate({
      layerId: LAYER_X,
      kind: 'skill',
      name: 'twice',
      spec: skillSpec('twice'),
      origin: 'builtin',
    });
    const events: unknown[] = [];
    fx.bus.subscribe(PROPOSAL_DEACTIVATED_EVENT_TYPE, (e) => {
      events.push(e.payload);
    });
    const first = registry.deactivate({
      layerId: LAYER_X,
      kind: 'skill',
      name: 'twice',
      deactivatedBy: ADMIN_USER,
    });
    const second = registry.deactivate({
      layerId: LAYER_X,
      kind: 'skill',
      name: 'twice',
      deactivatedBy: ADMIN_USER,
    });
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(events.length).toBe(1);
  });

  it('detaches the agent subscriber on agent-kind deactivation', async () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const llm = mockLlm();
    const registry = createCapabilityRegistry({
      repo,
      bus: fx.bus,
      logger: noopLogger,
      agentSubscriber: { llm },
    });
    registry.activate({
      layerId: LAYER_X,
      kind: 'agent',
      name: 'detach-me',
      spec: agentSpec('detach-me'),
      origin: 'builtin',
    });
    // Sanity: the agent's handler runs on bus event.
    await fx.bus.publish({ type: 'entity.contact.created', payload: { term: 'first' } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(llm.calls).toBe(1);

    registry.deactivate({
      layerId: LAYER_X,
      kind: 'agent',
      name: 'detach-me',
      deactivatedBy: ADMIN_USER,
    });
    await fx.bus.publish({ type: 'entity.contact.created', payload: { term: 'second' } });
    await new Promise<void>((r) => setTimeout(r, 0));
    // No additional LLM call — the agent is detached.
    expect(llm.calls).toBe(1);
  });
});
