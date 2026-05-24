/**
 * Phase 7.4 — per-layer capability registry + in-memory overlay.
 *
 * The registry is the per-layer source of truth for what tools / skills /
 * agents are active. Backed by the `layer_capabilities` table (phase 7.2
 * repo). Phase 7.4 ships:
 *
 *  - `listActive(layerId)`  — reads live rows from `layer_capabilities`.
 *  - `withOverlay(overlay)` — returns a read-through view where overlay
 *                             rows shadow live rows by
 *                             `(layer_id, kind, name)`. The overlay is
 *                             in-memory ONLY (ADR 0024 §1). Sandbox
 *                             runs that consult the registry see it;
 *                             everything else (live chat, other tasks)
 *                             does not.
 *  - `activate(input)`      — inserts into `layer_capabilities` (or
 *                             revives a soft-deactivated row) AND
 *                             publishes the `proposal.activated`
 *                             bus event. The per-kind activation hooks
 *                             (answerer skill load; bus subscriber for
 *                             agent kind) are phase 7.5 — leave clearly
 *                             marked TODOs for that wiring.
 *
 * Consumers (phase 7.5):
 *   - the answer step reads `listActive(layerId)` filtered to `kind=skill`
 *     and the matching intent;
 *   - the bus subscriber wrapper subscribes/unsubscribes on
 *     activate/deactivate for `kind=agent`;
 *   - the tool registry surface lists `kind=tool` rows for the (future)
 *     tool-calling answerer.
 *
 * Sandbox (phase 7.4 — this file's primary consumer): builds an overlay
 * from the proposal's spec and asks the orchestrator to read through
 * the overlay'd registry during replay.
 */

import type { MessageBus } from '@bunny2/bus';
import {
  ProposalSpecSchema,
  type ArtifactKind,
  type LayerCapability,
  type ProposalSpec,
} from '@bunny2/shared';
import type { LlmClient } from '../llm';
import type { LayerCapabilitiesRepo } from './repos/layer-capabilities-repo';
import {
  PROPOSAL_ACTIVATED_EVENT_TYPE,
  PROPOSAL_DEACTIVATED_EVENT_TYPE,
  type ProposalActivatedPayload,
  type ProposalDeactivatedPayload,
} from './events';
import {
  attachAgentSubscriber,
  detachAgentSubscriber,
  type AgentSubscriberLogger,
} from './agents/subscribe';

/**
 * Minimal logger surface mirroring `ScheduledTaskHandlerLogger` /
 * `PipelineLogger`. Kept narrow so this file doesn't bind to either.
 */
export interface CapabilityRegistryLogger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

const defaultLogger: CapabilityRegistryLogger = {
  info: (m, f) => console.log(`[proposal.registry] ${m}`, f ?? {}),
  warn: (m, f) => console.warn(`[proposal.registry] ${m}`, f ?? {}),
  error: (m, f) => console.error(`[proposal.registry] ${m}`, f ?? {}),
};

export interface ActivateInput {
  readonly layerId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly spec: ProposalSpec;
  /** `'builtin'` or `'proposal:<uuid>'`. */
  readonly origin: string;
  readonly now?: string;
  readonly correlationId?: string;
  readonly flowId?: string;
  /**
   * Optional metadata the future activation hooks (phase 7.5) will
   * pass — proposal id specifically — so the bus event can carry it
   * without re-deriving from `origin`.
   */
  readonly proposalId?: string;
}

export interface DeactivateInput {
  readonly layerId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly deactivatedBy: string;
  readonly now?: string;
  readonly correlationId?: string;
  readonly flowId?: string;
}

export interface CapabilityRegistry {
  /**
   * Active rows (`deactivated_at IS NULL`) for a layer. The order
   * mirrors the repo: activation order ascending. Cached lookups are
   * NOT done here — phase 7.5 is free to add a per-layer cache on
   * top of this surface.
   */
  listActive(layerId: string): readonly LayerCapability[];

  /**
   * Returns a read-through view of the registry where the overlay
   * rows shadow live rows by `(layerId, kind, name)`. The underlying
   * registry is not mutated. Each call returns a fresh view; views
   * are NOT registered anywhere and disappear when no one holds the
   * reference. The overlay is in-memory only (ADR 0024 §1).
   *
   * Conflict policy: an overlay row whose
   * `(layerId, kind, name)` collides with a live row REPLACES the
   * live row in the returned `listActive(layerId)` result. Non-colliding
   * overlay rows are appended. Live rows for layers the overlay doesn't
   * touch are returned unchanged.
   */
  withOverlay(overlay: readonly LayerCapability[]): CapabilityRegistry;

  /**
   * Insert into `layer_capabilities` (or revive a soft-deactivated
   * row) and publish `proposal.activated`. Phase 7.5 wires the per-
   * kind activation hooks:
   *  - `skill`: no extra work — the answerer reads via
   *    `loadSkillFragments` on demand.
   *  - `tool` : no extra work — the registry surface reads on demand.
   *  - `agent`: subscribes the handler to the bus via
   *    `attachAgentSubscriber(...)`. Requires `agentSubscriber` in
   *    the registry's construction deps; without it agents activate
   *    as DATA-ONLY rows (no live bus subscription) and the call
   *    logs a `phase 7.5 wiring missing` warning. Sandbox replays
   *    intentionally use this DATA-ONLY mode (no LlmClient is
   *    threaded into the overlay path) — the bus events the live
   *    capability handler would react to don't fire inside a
   *    scratch-DB replay anyway.
   */
  activate(input: ActivateInput): LayerCapability;

  /**
   * Phase 7.5 — admin deactivation. Soft-deactivates the row
   * (`deactivated_at = now`), detaches the agent subscriber when
   * `kind=agent`, and publishes `proposal.deactivated`. No-op when
   * the row is already deactivated or doesn't exist (idempotent).
   *
   * Returns the capability row's id when a row was deactivated,
   * `null` when the call was a no-op.
   */
  deactivate(input: DeactivateInput): string | null;
}

export interface CapabilityRegistryDeps {
  readonly repo: LayerCapabilitiesRepo;
  readonly bus: MessageBus;
  readonly logger?: CapabilityRegistryLogger;
  readonly idFactory?: () => string;
  readonly clock?: () => Date;
  /**
   * Phase 7.5 — agent-subscriber wiring. When present, activating an
   * `agent` capability calls `attachAgentSubscriber(...)` against
   * this client. When absent (e.g. the sandbox path, or a test that
   * only exercises skill / tool kinds), agent activations are
   * data-only and the registry logs a `wiring missing` warning so
   * the gap is visible in CI.
   */
  readonly agentSubscriber?: {
    readonly llm: LlmClient;
    readonly logger?: AgentSubscriberLogger;
  };
}

/**
 * Build the per-process capability registry. One instance per server
 * process; sandbox replays consume `withOverlay(...)` views.
 */
export function createCapabilityRegistry(deps: CapabilityRegistryDeps): CapabilityRegistry {
  const logger = deps.logger ?? defaultLogger;
  const newId = deps.idFactory ?? ((): string => crypto.randomUUID());
  const clock = deps.clock ?? ((): Date => new Date());

  return buildView(deps, logger, newId, clock, EMPTY_OVERLAY);
}

const EMPTY_OVERLAY: readonly LayerCapability[] = Object.freeze([] as LayerCapability[]);

function buildView(
  deps: CapabilityRegistryDeps,
  logger: CapabilityRegistryLogger,
  newId: () => string,
  clock: () => Date,
  overlay: readonly LayerCapability[],
): CapabilityRegistry {
  return {
    listActive(layerId: string): readonly LayerCapability[] {
      const live = deps.repo.listActiveByLayer(layerId).map(repoRowToCapability);
      if (overlay.length === 0) {
        return live;
      }
      const overlayForLayer = overlay.filter((c) => c.layerId === layerId);
      if (overlayForLayer.length === 0) {
        return live;
      }
      // Build a `(kind, name)` index so overlay rows replace
      // colliding live rows; non-colliding overlay rows are appended.
      const overlayKeys = new Set<string>(overlayForLayer.map((c) => `${c.kind}::${c.name}`));
      const merged: LayerCapability[] = [];
      for (const liveRow of live) {
        if (!overlayKeys.has(`${liveRow.kind}::${liveRow.name}`)) {
          merged.push(liveRow);
        }
      }
      for (const overlayRow of overlayForLayer) {
        merged.push(overlayRow);
      }
      return merged;
    },

    withOverlay(nextOverlay: readonly LayerCapability[]): CapabilityRegistry {
      // Composition: overlays don't stack — each `withOverlay(...)`
      // returns a view rooted on the live registry plus the new
      // overlay. Stacking would let one sandbox replay accidentally
      // see another's overlay; we want strict isolation.
      void overlay;
      return buildView(deps, logger, newId, clock, nextOverlay);
    },

    activate(input: ActivateInput): LayerCapability {
      const nowIso = input.now ?? clock().toISOString();
      // Defensive zod re-check at the activation boundary (ADR 0023
      // §2): even though mint + sandbox already validated the spec,
      // catching an unknown handler kind here prevents an out-of-band
      // path (a future admin re-activation route) from registering a
      // capability the consumers can't interpret.
      const reparse = ProposalSpecSchema.safeParse(input.spec);
      if (!reparse.success) {
        throw new Error(
          `capability-registry.activate: spec failed defensive zod re-check: ${reparse.error.issues
            .map((i) => `${i.path.join('.')}: ${i.message}`)
            .join('; ')}`,
        );
      }
      const id = newId();
      const inserted = deps.repo.insertCapability({
        id,
        layerId: input.layerId,
        kind: input.kind,
        name: input.name,
        specJson: JSON.stringify(input.spec),
        origin: input.origin,
        activatedAt: nowIso,
      });
      const capability = repoRowToCapability(inserted);

      // Phase 7.5 — per-kind activation hooks.
      //   - skill: no extra work (answerer reads via `loadSkillFragments`)
      //   - tool : no extra work (registry surface reads via `listTools`)
      //   - agent: attach handler to the durable bus (per `subscribesTo`)
      if (input.kind === 'agent') {
        if (deps.agentSubscriber !== undefined) {
          attachAgentSubscriber(capability, {
            bus: deps.bus,
            llm: deps.agentSubscriber.llm,
            ...(deps.agentSubscriber.logger !== undefined
              ? { logger: deps.agentSubscriber.logger }
              : {}),
            ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
          });
        } else {
          logger.warn('proposal.capability.activate.agent-wiring-missing', {
            event: 'proposal.capability.activate.agent-wiring-missing',
            capabilityId: capability.id,
            layerId: input.layerId,
            name: input.name,
          });
        }
      }

      const payload: ProposalActivatedPayload = {
        layerId: input.layerId,
        artifactKind: input.kind,
        capabilityId: capability.id,
        origin: input.origin,
        ...(input.proposalId !== undefined ? { proposalId: input.proposalId } : {}),
      };
      // Best-effort publish: bus failures shouldn't roll back the
      // INSERT (the row is the source of truth). Log + swallow.
      void deps.bus
        .publish<ProposalActivatedPayload>({
          type: PROPOSAL_ACTIVATED_EVENT_TYPE,
          payload,
          ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
          ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
        })
        .catch((err) => {
          logger.warn('proposal.activated.publish-failed', {
            event: 'proposal.activated.publish-failed',
            capabilityId: capability.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      logger.info('proposal.capability.activated', {
        event: 'proposal.capability.activated',
        capabilityId: capability.id,
        layerId: input.layerId,
        kind: input.kind,
        origin: input.origin,
        // Counter dim — bounded.
        'proposal.capability.activated_count': 1,
      });
      return capability;
    },

    deactivate(input: DeactivateInput): string | null {
      const row = deps.repo.getByName(input.layerId, input.kind, input.name);
      if (row === null) {
        logger.warn('proposal.capability.deactivate.not-found', {
          event: 'proposal.capability.deactivate.not-found',
          layerId: input.layerId,
          kind: input.kind,
          name: input.name,
        });
        return null;
      }
      if (row.deactivatedAt !== null) {
        // Already deactivated — idempotent no-op.
        return null;
      }
      const nowIso = input.now ?? clock().toISOString();
      deps.repo.deactivate(row.id, nowIso);

      // Per-kind deactivation hooks. `agent` is the only kind with
      // live runtime state (a bus subscription); skill and tool are
      // pure data so their detachment is the row update itself.
      if (input.kind === 'agent') {
        detachAgentSubscriber(row.id, {
          ...(deps.agentSubscriber?.logger !== undefined
            ? { logger: deps.agentSubscriber.logger }
            : {}),
        });
      }

      const payload: ProposalDeactivatedPayload = {
        layerId: input.layerId,
        artifactKind: input.kind,
        capabilityId: row.id,
        name: input.name,
        deactivatedBy: input.deactivatedBy,
      };
      void deps.bus
        .publish<ProposalDeactivatedPayload>({
          type: PROPOSAL_DEACTIVATED_EVENT_TYPE,
          payload,
          ...(input.correlationId !== undefined ? { correlationId: input.correlationId } : {}),
          ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
        })
        .catch((err) => {
          logger.warn('proposal.deactivated.publish-failed', {
            event: 'proposal.deactivated.publish-failed',
            capabilityId: row.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      logger.info('proposal.capability.deactivated', {
        event: 'proposal.capability.deactivated',
        capabilityId: row.id,
        layerId: input.layerId,
        kind: input.kind,
        name: input.name,
        deactivatedBy: input.deactivatedBy,
      });

      return row.id;
    },
  };
}

function repoRowToCapability(row: {
  readonly id: string;
  readonly layerId: string;
  readonly kind: ArtifactKind;
  readonly name: string;
  readonly specJson: string;
  readonly origin: string;
  readonly activatedAt: string;
  readonly deactivatedAt: string | null;
}): LayerCapability {
  return {
    id: row.id,
    layerId: row.layerId,
    kind: row.kind,
    name: row.name,
    specJson: row.specJson,
    origin: row.origin,
    activatedAt: row.activatedAt,
    deactivatedAt: row.deactivatedAt,
  };
}
