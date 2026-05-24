import type { Database } from 'bun:sqlite';
import type { BusEvent, MessageBus, Unsubscribe } from '@bunny2/bus';
import type { Entity, EntityRef } from '@bunny2/shared';
import type { LlmClient } from '../llm';
import { estimateCostUsd, type PricingMap } from '../llm/pricing';
import type { EnrichmentTrigger, EntityModule } from './module';
import type { EntityStore } from './store';
import {
  ENTITY_EVENT_TYPES,
  entityEventType,
  type EntityConnectorSyncSucceededPayload,
  type EntityCreatedPayload,
  type EntityEnrichmentDeferredPayload,
  type EntityEnrichmentFailedPayload,
  type EntityEnrichmentStartedPayload,
  type EntityEnrichmentSucceededPayload,
  type EntityUpdatedPayload,
} from './events';
import { listEntityModules } from './registry';

/**
 * Phase 4a.3 — generic AI-enrichment runner.
 *
 * Same shape as `connector-runner.ts`:
 *  - `start()` subscribes to `entity.<kind>.{created,updated}` for every
 *    module that declares `enrichmentJobs`, plus one subscription to
 *    `entity.connector.sync.succeeded`.
 *  - `stop()` detaches every subscription and clears in-flight timers.
 *  - `tickOnce()` flushes every pending debounced entry synchronously —
 *    tests use this instead of fake-timer plumbing for the debounce
 *    half of the runner (the fake clock is still needed for the rate
 *    limit window).
 *
 * The runner is foundation-shaped (no companies-specific code). Future
 * kinds (4b.3 contacts, 4c.3 calendar, 4d.3 todos) reuse it by
 * declaring their own `enrichmentJobs` on their module — no new
 * subscriber, no new bus event.
 *
 * # Coalescing
 *
 * Multiple events for the same `(kind, entityId)` within
 * `config.enrichment.debounceMs` are collapsed: the runner keeps a
 * `Map<key, ScheduledEntry>` keyed on `${kind}:${entityId}`. Each new
 * event re-arms the timer to `now + debounceMs` and merges the
 * `runOn` trigger reasons. When the timer fires, the runner walks
 * every registered job whose `runOn` intersects the merged reason set
 * and runs it once.
 *
 * # Rate limit
 *
 * A simple sliding-window bucket per `layerId` caps the number of LLM
 * calls per 60 seconds at `config.enrichment.maxRunsPerLayerPerMinute`
 * (default 30). When the bucket is full, the runner publishes
 * `entity.enrichment.deferred` and re-arms the entry's timer to the
 * next minute boundary so a later tick can satisfy it.
 *
 * # Failure
 *
 * A job that throws does NOT propagate. The runner publishes
 * `entity.enrichment.failed` with the structured reason and moves on
 * — exactly the same discipline as the connector dispatcher.
 */

export interface EnrichmentRunnerConfig {
  /** Debounce window per (kind, entityId). Default 5000ms. */
  readonly debounceMs?: number;
  /** Per-layer LLM-call cap in 60s. Default 30. */
  readonly maxRunsPerLayerPerMinute?: number;
}

export interface EnrichmentRunnerDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  readonly clock?: () => Date;
  readonly pricing?: PricingMap;
  readonly config?: EnrichmentRunnerConfig;
  /**
   * Pluggable module listing so tests can drive the runner with a
   * dedicated fixture module without touching the process-global
   * registry. Default: `listEntityModules()`.
   */
  readonly listModules?: () => readonly EntityModule<unknown>[];
  /**
   * Resolves the store for a given module. Default: the caller passes
   * `null` and the runner refuses to apply patches (jobs can still
   * publish events). Production wiring passes a per-kind store factory.
   * Tests inject a single store directly.
   */
  readonly resolveStore?: (module: EntityModule<unknown>) => EntityStore<unknown> | null;
}

export interface EnrichmentRunner {
  start(): void;
  stop(): void;
  /**
   * Flushes every pending debounced entry synchronously, ignoring its
   * remaining debounce delay. Returns the number of job invocations
   * (jobs that ran, including those that produced an empty patch but
   * excluding deferred ones).
   */
  tickOnce(): Promise<number>;
}

interface PendingEntry {
  readonly key: string;
  readonly kind: string;
  readonly entityId: string;
  triggers: Set<EnrichmentTrigger>;
  /** When this entry should fire (epoch ms). */
  fireAtMs: number;
  /** Correlation id from the most recent triggering event. */
  correlationId: string | undefined;
}

const DEFAULT_DEBOUNCE_MS = 5_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;

export function createEnrichmentRunner(deps: EnrichmentRunnerDeps): EnrichmentRunner {
  const clock = deps.clock ?? (() => new Date());
  const debounceMs = deps.config?.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const ratePerMinute = deps.config?.maxRunsPerLayerPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
  const listModules = deps.listModules ?? listEntityModules;
  const resolveStore = deps.resolveStore ?? ((): null => null);
  const pricing = deps.pricing ?? {};

  const pending = new Map<string, PendingEntry>();
  /** Per-layer timestamps of recent runs (ms since epoch). */
  const recentRuns = new Map<string, number[]>();
  const unsubscribes: Unsubscribe[] = [];
  let started = false;

  function key(kind: string, entityId: string): string {
    return `${kind}:${entityId}`;
  }

  function schedule(input: {
    readonly kind: string;
    readonly entityId: string;
    readonly trigger: EnrichmentTrigger;
    readonly correlationId?: string;
  }): void {
    const k = key(input.kind, input.entityId);
    const nowMs = clock().getTime();
    const existing = pending.get(k);
    if (existing === undefined) {
      pending.set(k, {
        key: k,
        kind: input.kind,
        entityId: input.entityId,
        triggers: new Set<EnrichmentTrigger>([input.trigger]),
        fireAtMs: nowMs + debounceMs,
        correlationId: input.correlationId,
      });
      return;
    }
    existing.triggers.add(input.trigger);
    existing.fireAtMs = nowMs + debounceMs;
    if (input.correlationId !== undefined) {
      existing.correlationId = input.correlationId;
    }
  }

  function findModuleForKind(kind: string): EntityModule<unknown> | null {
    for (const m of listModules()) {
      if (m.kind === kind) return m;
    }
    return null;
  }

  function trimRateWindow(layerId: string): number[] {
    const nowMs = clock().getTime();
    const cutoff = nowMs - 60_000;
    const arr = recentRuns.get(layerId) ?? [];
    const trimmed = arr.filter((t) => t > cutoff);
    recentRuns.set(layerId, trimmed);
    return trimmed;
  }

  function checkAndRecordRateLimit(layerId: string): boolean {
    const arr = trimRateWindow(layerId);
    if (arr.length >= ratePerMinute) return false;
    arr.push(clock().getTime());
    recentRuns.set(layerId, arr);
    return true;
  }

  async function applyPatch<P>(
    module: EntityModule<P>,
    store: EntityStore<P>,
    entity: Entity<P>,
    patch: Partial<P>,
  ): Promise<boolean> {
    const overwriteFields = module.enrichmentOverwriteFields ?? [];
    const filtered: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(patch as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      const current = (entity.payload as unknown as Record<string, unknown>)[field];
      // For string-typed fields, treat empty string as "unset" too.
      const currentIsEmpty =
        current === null ||
        current === undefined ||
        (typeof current === 'string' && current.trim().length === 0);
      // Phase 4c.3 — the runner refuses to overwrite a non-empty field
      // UNLESS the module explicitly lists it in
      // `enrichmentOverwriteFields`. Empty / null / whitespace-only
      // fields stay overridable regardless of the list. This
      // generalises the previously-hardcoded `description` exception
      // (4a.3 close-out predicted this generalisation when calendar's
      // attendees / meetingSummaryNote needed the same affordance).
      if (!currentIsEmpty && !overwriteFields.includes(field)) continue;
      filtered[field] = value;
    }
    if (Object.keys(filtered).length === 0) return false;
    const next = { ...(entity.payload as object), ...filtered } as P;
    await store.update({
      id: entity.id,
      payload: next,
      actorId: entity.meta.updatedBy,
    });
    return true;
  }

  function recordLastEnriched(
    entityId: string,
    kind: string,
    version: number,
    jobId: string,
  ): void {
    const nowIso = clock().toISOString();
    const existing = deps.db
      .query<
        { memory_json: string },
        [string]
      >(`SELECT memory_json FROM entity_souls WHERE entity_id = ?`)
      .get(entityId);
    let mem: Record<string, unknown> = {};
    if (existing !== null) {
      try {
        const parsed = JSON.parse(existing.memory_json) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          mem = parsed as Record<string, unknown>;
        }
      } catch {
        mem = {};
      }
    }
    const lastByJob =
      (mem['lastEnrichedAtVersionByJob'] as Record<string, number> | undefined) ?? {};
    lastByJob[jobId] = version;
    mem['lastEnrichedAtVersionByJob'] = lastByJob;
    if (existing === null) {
      deps.db
        .query<
          unknown,
          [string, string, string, string]
        >(`INSERT INTO entity_souls (entity_id, entity_kind, memory_json, updated_at) VALUES (?, ?, ?, ?)`)
        .run(entityId, kind, JSON.stringify(mem), nowIso);
    } else {
      deps.db
        .query<
          unknown,
          [string, string, string]
        >(`UPDATE entity_souls SET memory_json = ?, updated_at = ? WHERE entity_id = ?`)
        .run(JSON.stringify(mem), nowIso, entityId);
    }
  }

  async function processEntry(entry: PendingEntry): Promise<number> {
    const module = findModuleForKind(entry.kind);
    if (module === null) return 0;
    const jobs = module.enrichmentJobs ?? [];
    if (jobs.length === 0) return 0;
    const store = resolveStore(module);
    if (store === null) {
      // Without a store we cannot read the current entity nor apply
      // patches. This branch exists for tests that intentionally drive
      // the runner without a store; production wiring always sets one.
      return 0;
    }
    const entity = store.getById(entry.entityId);
    if (entity === null) return 0;
    let ran = 0;
    for (const job of jobs) {
      const overlap = job.runOn.some((t) => entry.triggers.has(t));
      if (!overlap) continue;
      const trigger = pickPrimaryTrigger(job.runOn, entry.triggers);
      // Rate limit
      if (!checkAndRecordRateLimit(entry.kind === module.kind ? entity.layerId : entity.layerId)) {
        const deferred: EntityEnrichmentDeferredPayload = {
          kind: entry.kind,
          entityId: entry.entityId,
          jobId: job.id,
          layerId: entity.layerId,
          reason: 'rate_limited',
        };
        await deps.bus.publish({
          type: ENTITY_EVENT_TYPES.EnrichmentDeferred,
          payload: deferred,
          ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
        });
        // Re-arm so a later tick can pick it up.
        entry.fireAtMs = clock().getTime() + 60_000;
        pending.set(entry.key, entry);
        // Do not run further jobs for this entity in this pass — the
        // bucket is exhausted; everything else should also defer.
        return ran;
      }
      const started: EntityEnrichmentStartedPayload = {
        kind: entry.kind,
        entityId: entry.entityId,
        jobId: job.id,
      };
      await deps.bus.publish({
        type: ENTITY_EVENT_TYPES.EnrichmentStarted,
        payload: started,
        ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
      });
      try {
        const result = await job.run(entity, {
          db: deps.db,
          bus: deps.bus,
          llm: deps.llm,
          layerId: entity.layerId,
          trigger,
          module,
          ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
        });
        const hasPatch =
          result.patch !== undefined && Object.keys(result.patch as object).length > 0;
        let applied = false;
        if (hasPatch) {
          applied = await applyPatch(module, store, entity, result.patch as Partial<unknown>);
          if (applied) {
            const refreshed = store.getById(entry.entityId);
            if (refreshed !== null) {
              recordLastEnriched(entry.entityId, module.kind, refreshed.meta.version, job.id);
            }
          }
        } else {
          recordLastEnriched(entry.entityId, module.kind, entity.meta.version, job.id);
        }
        const tokensIn = result.tokensIn ?? 0;
        const tokensOut = result.tokensOut ?? 0;
        const model = result.model ?? deps.llm.defaultModel;
        const costUsd = estimateCostUsd(model, tokensIn, tokensOut, pricing);
        const succeeded: EntityEnrichmentSucceededPayload = {
          kind: entry.kind,
          entityId: entry.entityId,
          jobId: job.id,
          hasPatch: applied,
          tokensIn,
          tokensOut,
          costUsd,
        };
        await deps.bus.publish({
          type: ENTITY_EVENT_TYPES.EnrichmentSucceeded,
          payload: succeeded,
          ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
        });
        ran += 1;
      } catch (err) {
        const safe = sanitizeError(err);
        const failed: EntityEnrichmentFailedPayload = {
          kind: entry.kind,
          entityId: entry.entityId,
          jobId: job.id,
          error: safe,
        };
        await deps.bus.publish({
          type: ENTITY_EVENT_TYPES.EnrichmentFailed,
          payload: failed,
          ...(entry.correlationId === undefined ? {} : { correlationId: entry.correlationId }),
        });
        ran += 1;
      }
    }
    return ran;
  }

  async function tickOnce(): Promise<number> {
    const entries = Array.from(pending.values());
    pending.clear();
    let ran = 0;
    for (const entry of entries) {
      ran += await processEntry(entry);
    }
    return ran;
  }

  function onCreatedHandler(kind: string) {
    return async (event: BusEvent<EntityCreatedPayload>) => {
      schedule({
        kind,
        entityId: event.payload.ref.id,
        trigger: 'created',
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      });
    };
  }

  function onUpdatedHandler(kind: string) {
    return async (event: BusEvent<EntityUpdatedPayload>) => {
      schedule({
        kind,
        entityId: event.payload.ref.id,
        trigger: 'updated',
        ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
      });
    };
  }

  async function onSyncSucceeded(event: BusEvent<EntityConnectorSyncSucceededPayload>) {
    const ref: EntityRef = event.payload.ref;
    schedule({
      kind: ref.kind,
      entityId: ref.id,
      trigger: 'sync.succeeded',
      ...(event.correlationId === undefined ? {} : { correlationId: event.correlationId }),
    });
  }

  function start(): void {
    if (started) return;
    started = true;
    for (const module of listModules()) {
      if (module.enrichmentJobs === undefined || module.enrichmentJobs.length === 0) {
        continue;
      }
      unsubscribes.push(
        deps.bus.subscribe<EntityCreatedPayload>(
          entityEventType(module.kind, 'created'),
          onCreatedHandler(module.kind),
        ),
      );
      unsubscribes.push(
        deps.bus.subscribe<EntityUpdatedPayload>(
          entityEventType(module.kind, 'updated'),
          onUpdatedHandler(module.kind),
        ),
      );
    }
    unsubscribes.push(
      deps.bus.subscribe<EntityConnectorSyncSucceededPayload>(
        ENTITY_EVENT_TYPES.ConnectorSyncSucceeded,
        onSyncSucceeded,
      ),
    );
  }

  function stop(): void {
    for (const u of unsubscribes) u();
    unsubscribes.length = 0;
    pending.clear();
    started = false;
  }

  return { start, stop, tickOnce };
}

function pickPrimaryTrigger(
  runOn: readonly EnrichmentTrigger[],
  observed: ReadonlySet<EnrichmentTrigger>,
): EnrichmentTrigger {
  // Order matters: a connector sync is a stronger signal than a plain
  // create/update because it brings external ground-truth. Prefer it.
  if (runOn.includes('sync.succeeded') && observed.has('sync.succeeded')) {
    return 'sync.succeeded';
  }
  if (runOn.includes('updated') && observed.has('updated')) return 'updated';
  if (runOn.includes('created') && observed.has('created')) return 'created';
  return runOn[0] ?? 'updated';
}

function sanitizeError(err: unknown): string {
  if (err instanceof Error) {
    if (err.message.startsWith('errors.')) return err.message;
    return 'errors.entity.enrichment.failed';
  }
  return 'errors.entity.enrichment.failed';
}
