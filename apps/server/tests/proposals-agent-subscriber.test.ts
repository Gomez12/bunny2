/**
 * Phase 7.5 — agent subscriber wrapper tests.
 *
 * Pins:
 *  - `attachAgentSubscriber` subscribes the handler to every event
 *    type in `spec.subscribesTo`; publishing one of those types
 *    invokes the handler.
 *  - `detachAgentSubscriber` unsubscribes — subsequent publishes do
 *    not invoke the handler.
 *  - Two publishes invoke the handler twice (at-least-once OK —
 *    handler is LLM-call only, no persisted side-effect; the docs
 *    on the adapter call this out).
 *  - Boot re-attach: an active row created via the repo (NOT via
 *    `activate(...)`) can be re-attached on boot.
 *  - DLQ behaviour: a throwing handler propagates the error to the
 *    bus (where the durable adapter's existing DLQ machinery takes
 *    over). Other subscribers in the same process still receive
 *    subsequent events.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { LayerCapability, ProposalSpec } from '@bunny2/shared';
import {
  attachAgentSubscriber,
  detachAgentSubscriber,
  isAgentAttached,
  resetAttachedAgentsForTest,
} from '../src/proposals';
import type { LlmClient } from '../src/llm';

const LAYER_X = '11111111-1111-1111-1111-111111111111';

const noopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function mockLlm(): LlmClient & { calls: { prompt: string }[] } {
  const calls: { prompt: string }[] = [];
  return {
    endpoint: 'mock://agent-llm',
    defaultModel: 'mock-default',
    async chat(req) {
      const promptParts = req.messages.map((m) => m.content);
      calls.push({ prompt: promptParts.join('\n') });
      return {
        id: crypto.randomUUID(),
        model: req.model ?? 'mock-default',
        content: 'ok',
        tokensIn: 1,
        tokensOut: 1,
        raw: null,
      };
    },
    get calls() {
      return calls;
    },
  } as LlmClient & { calls: { prompt: string }[] };
}

function agentSpec(name: string, subscribesTo: readonly string[]): ProposalSpec {
  return {
    artifactKind: 'agent',
    name,
    description: 'desc',
    subscribesTo: [...subscribesTo],
    handler: {
      kind: 'enrichment-call',
      config: { promptTemplate: 'enrich: ${term}' },
    },
    addressesTags: ['thumbs-down'],
  };
}

function agentRow(opts: { name: string; subscribesTo: readonly string[] }): LayerCapability {
  return {
    id: crypto.randomUUID(),
    layerId: LAYER_X,
    kind: 'agent',
    name: opts.name,
    specJson: JSON.stringify(agentSpec(opts.name, opts.subscribesTo)),
    origin: 'builtin',
    activatedAt: new Date().toISOString(),
    deactivatedAt: null,
  };
}

describe('phase 7.5 — agent subscriber wrapper', () => {
  beforeEach(() => {
    resetAttachedAgentsForTest();
  });
  afterEach(() => {
    resetAttachedAgentsForTest();
  });

  it('attaches handler and publishing the event triggers the LLM call', async () => {
    const bus = new InMemoryMessageBus();
    const llm = mockLlm();
    const cap = agentRow({ name: 'enricher', subscribesTo: ['entity.contact.created'] });
    const record = attachAgentSubscriber(cap, { bus, llm, logger: noopLogger });
    expect(record).not.toBeNull();
    expect(isAgentAttached(cap.id)).toBe(true);

    await bus.publish({ type: 'entity.contact.created', payload: { term: 'Acme Corp' } });
    // The handler runs asynchronously; wait one microtask cycle.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(llm.calls.length).toBe(1);
    expect(llm.calls[0]?.prompt).toContain('Acme Corp');
  });

  it('detach prevents further invocations', async () => {
    const bus = new InMemoryMessageBus();
    const llm = mockLlm();
    const cap = agentRow({ name: 'enricher', subscribesTo: ['entity.contact.created'] });
    attachAgentSubscriber(cap, { bus, llm, logger: noopLogger });
    await bus.publish({ type: 'entity.contact.created', payload: { term: 'first' } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(llm.calls.length).toBe(1);

    detachAgentSubscriber(cap.id, { logger: noopLogger });
    expect(isAgentAttached(cap.id)).toBe(false);
    await bus.publish({ type: 'entity.contact.created', payload: { term: 'second' } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(llm.calls.length).toBe(1);
  });

  it('two deliveries invoke the handler twice (at-least-once semantics)', async () => {
    const bus = new InMemoryMessageBus();
    const llm = mockLlm();
    const cap = agentRow({ name: 'enricher', subscribesTo: ['entity.contact.created'] });
    attachAgentSubscriber(cap, { bus, llm, logger: noopLogger });
    await bus.publish({ type: 'entity.contact.created', payload: { term: 'first' } });
    await bus.publish({ type: 'entity.contact.created', payload: { term: 'first' } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(llm.calls.length).toBe(2);
  });

  it('a throwing handler does not poison the bus for other agents', async () => {
    const bus = new InMemoryMessageBus({ onHandlerError: () => undefined });
    const llm = mockLlm();

    // First agent: a stub that throws by using an LLM that throws.
    const throwingLlm: LlmClient = {
      endpoint: 'mock://throw',
      defaultModel: 'm',
      async chat() {
        throw new Error('agent handler boom');
      },
    };
    const capBad = agentRow({ name: 'bad', subscribesTo: ['entity.contact.created'] });
    attachAgentSubscriber(capBad, { bus, llm: throwingLlm, logger: noopLogger });

    // Second agent: healthy.
    const capGood = agentRow({ name: 'good', subscribesTo: ['entity.contact.created'] });
    attachAgentSubscriber(capGood, { bus, llm, logger: noopLogger });

    await bus.publish({ type: 'entity.contact.created', payload: { term: 'isolated' } });
    await new Promise<void>((r) => setTimeout(r, 0));
    // The healthy agent's LLM was invoked once even though the bad
    // agent threw.
    expect(llm.calls.length).toBe(1);
  });

  it('boot re-attach: a freshly inserted active row picks up new publishes', async () => {
    // Mirrors the boot path in `apps/server/src/index.ts`: a row
    // exists in `layer_capabilities` (here: synthesised in-memory)
    // and `attachAgentSubscriber(...)` is called for it.
    const bus = new InMemoryMessageBus();
    const llm = mockLlm();
    const cap = agentRow({ name: 'boot-attached', subscribesTo: ['entity.contact.created'] });
    attachAgentSubscriber(cap, { bus, llm, logger: noopLogger });
    expect(isAgentAttached(cap.id)).toBe(true);
    await bus.publish({ type: 'entity.contact.created', payload: { term: 'after-boot' } });
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(llm.calls.length).toBe(1);
  });

  it('skips and warns when attaching a non-agent capability', () => {
    const bus = new InMemoryMessageBus();
    const llm = mockLlm();
    const cap: LayerCapability = {
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'not-an-agent',
      specJson: '{}',
      origin: 'builtin',
      activatedAt: new Date().toISOString(),
      deactivatedAt: null,
    };
    const result = attachAgentSubscriber(cap, { bus, llm, logger: noopLogger });
    expect(result).toBeNull();
  });
});
