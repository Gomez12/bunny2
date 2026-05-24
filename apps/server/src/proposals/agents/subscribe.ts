/**
 * Phase 7.5 — durable-bus subscriber wrapper for `agent` capabilities.
 *
 * Each activated `agent` row subscribes its handler to every bus
 * event kind in `spec.subscribesTo`. On deactivation we unsubscribe;
 * on boot we re-attach every active row (the per-process registry
 * is in-memory, the rows are durable).
 *
 * Idempotency: the durable bus's at-least-once semantics (ADR 0019)
 * means the same handler may run twice for the same event. The
 * underlying handler adapters (`enrichment-call`, `summary-call`)
 * are LLM calls and SAFE to run twice — the second run produces a
 * duplicate `llm_calls` row but no persisted side-effect. Callers
 * that DO persist (a future enrichment writer, say) must de-dupe on
 * the bus event id.
 *
 * DLQ behaviour: a handler exception is caught here and re-thrown,
 * so the durable bus's per-handler error path (the same path the
 * scheduled-task subscriber relies on) routes the failure into
 * `bus_dlq` via the existing infrastructure. Other agents in the
 * same layer keep flowing because each agent has its own
 * `subscribe(...)` registration — failures are isolated per
 * (capability, event-type) pair.
 *
 * Observability:
 *  - `proposal.agent.attached` / `proposal.agent.detached` per
 *    activation / deactivation.
 *  - `proposal.agent.run` per event handled: correlationId,
 *    agentName, layerId, durationMs, outcome (`ok` | `error`).
 *  - Telemetry counters: `proposal.agent.run.duration_ms`
 *    (histogram dim by handler-kind) and
 *    `proposal.agent.run.failed_count` (counter dim by handler-kind
 *    + error class).
 */

import type { BusEvent, MessageBus, Unsubscribe } from '@bunny2/bus';
import {
  AgentProposalSpecSchema,
  type AgentProposalSpec,
  type LayerCapability,
} from '@bunny2/shared';
import type { LlmClient } from '../../llm';
import { buildEnrichmentCallHandler } from './handlers/enrichment-call';
import { buildSummaryCallHandler } from './handlers/summary-call';

export interface AgentSubscriberLogger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

const defaultLogger: AgentSubscriberLogger = {
  info: (m, f) => console.log(`[proposal.agent] ${m}`, f ?? {}),
  warn: (m, f) => console.warn(`[proposal.agent] ${m}`, f ?? {}),
  error: (m, f) => console.error(`[proposal.agent] ${m}`, f ?? {}),
};

export interface AgentSubscriberDeps {
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  readonly logger?: AgentSubscriberLogger;
  readonly clock?: () => Date;
}

/**
 * Internal book-keeping. The registry holds one entry per active
 * `agent` capability; each entry owns the list of `Unsubscribe`
 * callbacks for the bus subscriptions the activation made. Keyed by
 * `capability.id` so detach is O(1).
 */
const attached = new Map<string, AttachedAgent>();

interface AttachedAgent {
  readonly capabilityId: string;
  readonly layerId: string;
  readonly name: string;
  readonly spec: AgentProposalSpec;
  readonly unsubs: Unsubscribe[];
}

/**
 * Attach an `agent` capability to the bus. Subscribes the handler to
 * every event kind in `spec.subscribesTo`. Returns the
 * `AttachedAgent` record (mostly for testing — production code can
 * ignore the return value and call `detachAgentSubscriber(...)`
 * later).
 *
 * Idempotent: calling `attachAgentSubscriber` twice for the same
 * capability id is a no-op on the second call (logged at `warn`).
 */
export function attachAgentSubscriber(
  capability: LayerCapability,
  deps: AgentSubscriberDeps,
): AttachedAgent | null {
  const logger = deps.logger ?? defaultLogger;
  if (capability.kind !== 'agent') {
    logger.warn('proposal.agent.attach.skipped', {
      event: 'proposal.agent.attach.skipped',
      reason: 'not-an-agent',
      capabilityId: capability.id,
      kind: capability.kind,
    });
    return null;
  }
  if (attached.has(capability.id)) {
    logger.warn('proposal.agent.attach.duplicate', {
      event: 'proposal.agent.attach.duplicate',
      capabilityId: capability.id,
    });
    return attached.get(capability.id) ?? null;
  }
  let specJson: unknown;
  try {
    specJson = JSON.parse(capability.specJson);
  } catch (err) {
    logger.error('proposal.agent.attach.invalid-spec-json', {
      event: 'proposal.agent.attach.invalid-spec-json',
      capabilityId: capability.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  const parsed = AgentProposalSpecSchema.safeParse(specJson);
  if (!parsed.success) {
    logger.error('proposal.agent.attach.invalid-spec', {
      event: 'proposal.agent.attach.invalid-spec',
      capabilityId: capability.id,
      error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    });
    return null;
  }
  const spec = parsed.data;

  const handler = buildHandler(spec, deps);
  const unsubs: Unsubscribe[] = [];
  for (const eventType of spec.subscribesTo) {
    const off = deps.bus.subscribe<unknown>(
      eventType,
      async (event: BusEvent<unknown>) => {
        await runHandler(event, capability, spec, handler, deps);
      },
      { idempotent: true },
    );
    unsubs.push(off);
  }
  const record: AttachedAgent = {
    capabilityId: capability.id,
    layerId: capability.layerId,
    name: capability.name,
    spec,
    unsubs,
  };
  attached.set(capability.id, record);
  logger.info('proposal.agent.attached', {
    event: 'proposal.agent.attached',
    capabilityId: capability.id,
    layerId: capability.layerId,
    name: capability.name,
    handlerKind: spec.handler.kind,
    subscribesTo: [...spec.subscribesTo],
  });
  return record;
}

/**
 * Detach an `agent` capability. Calls every `Unsubscribe` the
 * activation registered and drops the entry from the registry.
 * Idempotent: calling twice is a no-op on the second call.
 */
export function detachAgentSubscriber(
  capabilityId: string,
  deps: { readonly logger?: AgentSubscriberLogger } = {},
): void {
  const logger = deps.logger ?? defaultLogger;
  const record = attached.get(capabilityId);
  if (record === undefined) {
    return;
  }
  for (const off of record.unsubs) {
    try {
      off();
    } catch {
      // Unsubscribe failures during teardown are not actionable.
    }
  }
  attached.delete(capabilityId);
  logger.info('proposal.agent.detached', {
    event: 'proposal.agent.detached',
    capabilityId,
    layerId: record.layerId,
    name: record.name,
  });
}

/** Test-only: returns whether the registry currently tracks `id`. */
export function isAgentAttached(capabilityId: string): boolean {
  return attached.has(capabilityId);
}

/** Test-only: tear down every attached agent. */
export function resetAttachedAgentsForTest(): void {
  for (const id of [...attached.keys()]) {
    detachAgentSubscriber(id);
  }
}

// ---------------------------------------------------------------------
// Handler construction + invocation
// ---------------------------------------------------------------------

type AgentHandlerCallable = (event: BusEvent<unknown>) => Promise<void>;

function buildHandler(spec: AgentProposalSpec, deps: AgentSubscriberDeps): AgentHandlerCallable {
  // Both default handlers are LLM-call adapters; their per-event
  // bodies pull a `term` / `text` field out of the payload when
  // present and fall back to JSON.stringify-ing the payload so a
  // misshaped event doesn't crash the agent.
  if (spec.handler.kind === 'enrichment-call') {
    const callable = buildEnrichmentCallHandler(spec.handler, { llm: deps.llm });
    return async (event: BusEvent<unknown>): Promise<void> => {
      const term = readPayloadString(event.payload, 'term') ?? safeJson(event.payload);
      const arg: { term: string; correlationId?: string; flowId?: string } = { term };
      if (event.correlationId !== undefined) arg.correlationId = event.correlationId;
      if (event.flowId !== undefined) arg.flowId = event.flowId;
      await callable(event, arg);
    };
  }
  if (spec.handler.kind === 'summary-call') {
    const callable = buildSummaryCallHandler(spec.handler, { llm: deps.llm });
    return async (event: BusEvent<unknown>): Promise<void> => {
      const text = readPayloadString(event.payload, 'text') ?? safeJson(event.payload);
      const arg: { text: string; correlationId?: string; flowId?: string } = { text };
      if (event.correlationId !== undefined) arg.correlationId = event.correlationId;
      if (event.flowId !== undefined) arg.flowId = event.flowId;
      await callable(event, arg);
    };
  }
  // The zod schema in `@bunny2/shared` already constrains
  // `handler.kind` to the closed enum, so this branch is defensive.
  throw new Error(
    `attachAgentSubscriber: unknown handler.kind=${(spec.handler as { kind?: string }).kind}`,
  );
}

async function runHandler(
  event: BusEvent<unknown>,
  capability: LayerCapability,
  spec: AgentProposalSpec,
  handler: AgentHandlerCallable,
  deps: AgentSubscriberDeps,
): Promise<void> {
  const logger = deps.logger ?? defaultLogger;
  const clock = deps.clock ?? ((): Date => new Date());
  const startedAtMs = clock().getTime();
  try {
    await handler(event);
    logger.info('proposal.agent.run', {
      event: 'proposal.agent.run',
      capabilityId: capability.id,
      layerId: capability.layerId,
      agentName: capability.name,
      handlerKind: spec.handler.kind,
      busEventId: event.id,
      busEventType: event.type,
      correlationId: event.correlationId,
      durationMs: clock().getTime() - startedAtMs,
      outcome: 'ok',
      // Telemetry: histogram by handler-kind only — names are
      // unbounded per layer.
      'proposal.agent.run.duration_ms': clock().getTime() - startedAtMs,
    });
  } catch (err) {
    logger.error('proposal.agent.run.failed', {
      event: 'proposal.agent.run.failed',
      capabilityId: capability.id,
      layerId: capability.layerId,
      agentName: capability.name,
      handlerKind: spec.handler.kind,
      busEventId: event.id,
      busEventType: event.type,
      correlationId: event.correlationId,
      durationMs: clock().getTime() - startedAtMs,
      outcome: 'error',
      errorClass: errorClass(err),
      error: err instanceof Error ? err.message : String(err),
      // Counter: dim by handler-kind + error class — both bounded.
      'proposal.agent.run.failed_count': 1,
    });
    // Re-throw so the durable bus's per-handler error path takes
    // over (DLQ wiring + reattempt). Per-handler isolation is
    // preserved because each `bus.subscribe` registration owns its
    // own error boundary.
    throw err;
  }
}

function readPayloadString(payload: unknown, key: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function safeJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 4000 ? s.slice(0, 3997) + '...' : s;
  } catch {
    return '';
  }
}

function errorClass(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}
