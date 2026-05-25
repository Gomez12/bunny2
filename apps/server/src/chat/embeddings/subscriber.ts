/**
 * Phase 6.2 — entity-event → LanceDB write subscriber.
 *
 * Wires each registered phase-4 entity kind (`company`, `contact`,
 * `calendar_event`, `todo`) to its matching LanceDB table. Per the
 * plan §4.3 + ADR 0021 (proposed):
 *
 *   created / updated  →  embed payload.searchableText, upsert
 *                         { id, layer_id, kind, slug, text, vector }.
 *   restored           →  fetch the entity (deleted_at is now NULL),
 *                         re-derive searchable_text via the module,
 *                         upsert.
 *   deleted (soft)     →  remove the row by id.
 *
 * The current entity store emits ONE delete event family —
 * `entity.<kind>.deleted` — for soft-delete (`store.softDelete()` in
 * `entities/store.ts`). There is no hard-delete path yet and no
 * `entity.<kind>.softDeleted` event. The subscriber maps that single
 * `deleted` event to a LanceDB row removal because the plan's
 * invariant is "soft-delete must also remove the vector row" — i.e.
 * soft-delete is the harshest event the corpus has to react to today,
 * and a future hard-delete event will reuse the same handler.
 *
 * Subscriber lifecycle:
 *  - `start()` is called AFTER `createApp` so every entity module has
 *    registered and `listEntityModules()` is non-empty. It iterates
 *    the four phase-4 modules (any kind missing from
 *    `ENTITY_KIND_TO_LANCE_TABLE` is skipped — future kinds opt in by
 *    adding a row to that map).
 *  - Subscribes with `{ idempotent: true }` so the durable adapter
 *    replays in-flight rows past the lease window on boot. The
 *    upsert is idempotent (mergeInsert by `id`), and the delete is
 *    idempotent by definition.
 *  - The subscriber NEVER throws into the bus chain. An embed failure
 *    is logged and absorbed; the next `updated` event will retry the
 *    row. A LanceDB write failure is logged and absorbed for the
 *    same reason. The plan §11 records this trade-off: a stalled
 *    entity write is worse than a delayed embedding.
 *
 * Logging shape (matches plan §10):
 *   { event: 'chat.embeddings.upsert' | 'chat.embeddings.remove',
 *     kind, entityId, layerId, table, dimensions, durationMs }
 * No content / payload fields are logged.
 *
 * Telemetry counters (using the existing console + file-log baseline;
 * a future phase 6.7 may promote to a metric registry):
 *  - `chat.embeddings.upsert.ok`
 *  - `chat.embeddings.upsert.failed`
 *  - `chat.embeddings.remove.ok`
 *  - `chat.embeddings.remove.failed`
 */

import type { Unsubscribe, MessageBus, BusEvent } from '@bunny2/bus';
import type {
  EntityCreatedPayload,
  EntityDeletedPayload,
  EntityModule,
  EntityRestoredPayload,
  EntityUpdatedPayload,
} from '../../entities';
import { entityEventType } from '../../entities';
import type { Embedder } from './embedder';
import { getLanceTableForKind, type LanceWriter } from './lance-tables';
import type { LayerChatSettingsRepo } from '../repos/layer-chat-settings-repo';
import type { LayerEmbeddingSpendRepo } from '../repos/layer-embedding-spend-repo';
import { isoDay } from '../repos/layer-embedding-spend-repo';

export interface EmbeddingSubscriberDeps {
  readonly bus: MessageBus;
  readonly embedder: Embedder;
  readonly writer: LanceWriter;
  /** Snapshot of registered entity modules (call AFTER `createApp`). */
  readonly modules: readonly EntityModule<unknown>[];
  /**
   * Resolves the kind's payload + summary on a `restored` event so we
   * can re-derive `searchable_text`. Same shape as the enrichment
   * runner's `resolveStore`. Passing only the bits we need keeps the
   * subscriber independent of the full store factory.
   */
  readonly fetchEntity: (kind: string, id: string) => FetchedEntity | null;
  readonly logger?: SubscriberLogger;
  /** Stable counters for tests; production wires to console.log. */
  readonly counters?: SubscriberCounters;
  /**
   * Per-layer embedding budget — optional. When both repos are
   * provided, the subscriber consults `layer_chat_settings.{daily,
   * monthly}_cap` before each encode; on cap-hit the upsert is
   * skipped, a structured warning is logged, and a `deferred`
   * counter increments. The next `updated` event (or the daily
   * backfill sweep) retries the row.
   *
   * Absent → the subscriber matches the phase-6 behaviour byte-for-
   * byte. Tests that don't care about the budget omit both repos.
   */
  readonly settingsRepo?: LayerChatSettingsRepo;
  readonly spendRepo?: LayerEmbeddingSpendRepo;
  /** Override now() in tests so the `day` bucket is deterministic. */
  readonly clock?: () => Date;
}

/**
 * Minimal entity shape the subscriber needs on a `restored` event.
 * Avoids leaking `Entity<unknown>` (which carries `payload` through
 * generics) into this file.
 */
export interface FetchedEntity {
  readonly id: string;
  readonly layerId: string;
  readonly kind: string;
  readonly slug: string;
  readonly searchableText: string;
}

export interface SubscriberLogger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface SubscriberCounters {
  inc(name: string, by?: number): void;
}

export interface EmbeddingSubscriber {
  start(): void;
  stop(): void;
}

const defaultLogger: SubscriberLogger = {
  info: (msg, fields) => console.log(`[chat.embeddings] ${msg}`, fields ?? {}),
  warn: (msg, fields) => console.warn(`[chat.embeddings] ${msg}`, fields ?? {}),
  error: (msg, fields) => console.error(`[chat.embeddings] ${msg}`, fields ?? {}),
};

const noopCounters: SubscriberCounters = { inc: () => undefined };

export function createEmbeddingSubscriber(deps: EmbeddingSubscriberDeps): EmbeddingSubscriber {
  const logger = deps.logger ?? defaultLogger;
  const counters = deps.counters ?? noopCounters;
  const clock = deps.clock ?? ((): Date => new Date());
  const unsubs: Unsubscribe[] = [];
  let started = false;

  /**
   * Returns the layer's daily + monthly caps, or `null` when no
   * budget is wired (in which case the subscriber behaves like
   * phase 6 — every encode runs unconditionally).
   */
  function readBudgetCaps(layerId: string): {
    readonly dailyCap: number | null;
    readonly monthlyCap: number | null;
  } | null {
    if (deps.settingsRepo === undefined || deps.spendRepo === undefined) return null;
    const row = deps.settingsRepo.find(layerId);
    return {
      dailyCap: row?.embeddingDailyCap ?? null,
      monthlyCap: row?.embeddingMonthlyCap ?? null,
    };
  }

  /**
   * Returns `true` when an encode for this layer would exceed any
   * configured cap. Pure check — does NOT mutate any counter; the
   * caller increments after a successful encode.
   */
  function isOverBudget(
    layerId: string,
    text: string,
    caps: { readonly dailyCap: number | null; readonly monthlyCap: number | null },
  ): { readonly capHit: 'daily' | 'monthly'; readonly estimatedTokens: number } | null {
    if (deps.spendRepo === undefined) return null;
    if (caps.dailyCap === null && caps.monthlyCap === null) return null;
    const estimated = Math.max(1, Math.ceil(text.length / 4));
    const day = isoDay(clock());
    if (caps.dailyCap !== null) {
      const spentToday = deps.spendRepo.getDayTokens(layerId, day);
      if (spentToday + estimated > caps.dailyCap) {
        return { capHit: 'daily', estimatedTokens: estimated };
      }
    }
    if (caps.monthlyCap !== null) {
      const last30 = deps.spendRepo.sumLastDays(layerId, day, 30);
      if (last30 + estimated > caps.monthlyCap) {
        return { capHit: 'monthly', estimatedTokens: estimated };
      }
    }
    return null;
  }

  /**
   * Record actual spend on a successful encode. The embedder does
   * not currently report token counts, so we use the `chars / 4`
   * heuristic for now. The Embedder interface can grow a token-
   * count return later; this helper is the single seam to update.
   */
  function recordSpend(layerId: string, text: string): number {
    if (deps.spendRepo === undefined) return 0;
    const day = isoDay(clock());
    const tokens = Math.max(1, Math.ceil(text.length / 4));
    deps.spendRepo.addTokens(layerId, day, tokens);
    counters.inc('embedding.tokens.spent', tokens);
    logger.info('embedding.tokens.spent', {
      event: 'embedding.tokens.spent',
      layerId,
      day,
      tokensSpent: tokens,
    });
    return tokens;
  }

  return {
    start(): void {
      if (started) return;
      started = true;
      let registeredKinds = 0;
      for (const module of deps.modules) {
        const table = getLanceTableForKind(module.kind);
        if (table === null) continue;
        registeredKinds += 1;

        unsubs.push(
          deps.bus.subscribe<EntityCreatedPayload>(
            entityEventType(module.kind, 'created'),
            (event) => handleCreatedOrUpdated(event, module, table),
            { idempotent: true },
          ),
        );
        unsubs.push(
          deps.bus.subscribe<EntityUpdatedPayload>(
            entityEventType(module.kind, 'updated'),
            (event) => handleCreatedOrUpdated(event, module, table),
            { idempotent: true },
          ),
        );
        unsubs.push(
          deps.bus.subscribe<EntityDeletedPayload>(
            entityEventType(module.kind, 'deleted'),
            (event) => handleDeleted(event, table),
            { idempotent: true },
          ),
        );
        unsubs.push(
          deps.bus.subscribe<EntityRestoredPayload>(
            entityEventType(module.kind, 'restored'),
            (event) => handleRestored(event, module, table),
            { idempotent: true },
          ),
        );
      }
      logger.info('subscriber started', {
        event: 'chat.embeddings.subscriber.started',
        kinds: registeredKinds,
        embedder: deps.embedder.id,
        dimensions: deps.embedder.dimensions,
      });
    },
    stop(): void {
      if (!started) return;
      started = false;
      for (const off of unsubs) {
        try {
          off();
        } catch {
          // Unsubscribe failures during shutdown are not actionable.
        }
      }
      unsubs.length = 0;
      logger.info('subscriber stopped', {
        event: 'chat.embeddings.subscriber.stopped',
      });
    },
  };

  async function handleCreatedOrUpdated(
    event: BusEvent<EntityCreatedPayload | EntityUpdatedPayload>,
    _module: EntityModule<unknown>,
    table: string,
  ): Promise<void> {
    const { ref, searchableText } = event.payload;
    if (searchableText.length === 0) {
      // Nothing to embed — but we still wipe any stale row so the
      // table mirrors the primary store. A row with empty text is
      // not useful and signals stale denormalisation.
      await safeRemove(table, ref.id, ref.kind, ref.layerId);
      return;
    }
    // Per-layer embedding-budget gate (no-op when no budget repos
    // are wired). On cap-hit we DROP the encode but keep the row
    // ready for the daily backfill — see plan §"Observability".
    const caps = readBudgetCaps(ref.layerId);
    if (caps !== null) {
      const over = isOverBudget(ref.layerId, searchableText, caps);
      if (over !== null) {
        counters.inc('chat.embeddings.deferred');
        logger.warn('embedding deferred (budget hit)', {
          event: 'chat.embeddings.deferred',
          reason: `cap_${over.capHit}`,
          kind: ref.kind,
          entityId: ref.id,
          layerId: ref.layerId,
          estimatedTokens: over.estimatedTokens,
          dailyCap: caps.dailyCap,
          monthlyCap: caps.monthlyCap,
        });
        // The daily `chat.embeddings.backfill` job re-discovers
        // rows that are missing from LanceDB and re-encodes them;
        // we deliberately do NOT call the LanceWriter so the row
        // simply stays absent until the cap window resets.
        return;
      }
    }
    const startedAt = Date.now();
    try {
      const vector = await deps.embedder.encode(searchableText);
      await deps.writer.upsert(table, {
        id: ref.id,
        layer_id: ref.layerId,
        kind: ref.kind,
        slug: ref.slug,
        text: searchableText,
        vector,
      });
      recordSpend(ref.layerId, searchableText);
      counters.inc('chat.embeddings.upsert.ok');
      logger.info('upsert ok', {
        event: 'chat.embeddings.upsert',
        kind: ref.kind,
        entityId: ref.id,
        layerId: ref.layerId,
        table,
        dimensions: vector.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      counters.inc('chat.embeddings.upsert.failed');
      logger.error('upsert failed', {
        event: 'chat.embeddings.upsert.failed',
        kind: ref.kind,
        entityId: ref.id,
        layerId: ref.layerId,
        table,
        durationMs: Date.now() - startedAt,
        error: errorMessage(err),
      });
    }
  }

  async function handleRestored(
    event: BusEvent<EntityRestoredPayload>,
    module: EntityModule<unknown>,
    table: string,
  ): Promise<void> {
    const { ref } = event.payload;
    const fetched = deps.fetchEntity(module.kind, ref.id);
    if (fetched === null) {
      // Entity was hard-deleted between the bus emit and our handler.
      // Nothing to embed; the matching `deleted` handler will have
      // (or will) clean the row.
      logger.warn('restore: entity not found', {
        event: 'chat.embeddings.restore.missing',
        kind: ref.kind,
        entityId: ref.id,
      });
      return;
    }
    if (fetched.searchableText.length === 0) {
      await safeRemove(table, ref.id, ref.kind, ref.layerId);
      return;
    }
    const caps = readBudgetCaps(fetched.layerId);
    if (caps !== null) {
      const over = isOverBudget(fetched.layerId, fetched.searchableText, caps);
      if (over !== null) {
        counters.inc('chat.embeddings.deferred');
        logger.warn('embedding deferred on restore (budget hit)', {
          event: 'chat.embeddings.deferred',
          reason: `cap_${over.capHit}`,
          kind: fetched.kind,
          entityId: fetched.id,
          layerId: fetched.layerId,
          estimatedTokens: over.estimatedTokens,
          dailyCap: caps.dailyCap,
          monthlyCap: caps.monthlyCap,
        });
        return;
      }
    }
    const startedAt = Date.now();
    try {
      const vector = await deps.embedder.encode(fetched.searchableText);
      await deps.writer.upsert(table, {
        id: fetched.id,
        layer_id: fetched.layerId,
        kind: fetched.kind,
        slug: fetched.slug,
        text: fetched.searchableText,
        vector,
      });
      recordSpend(fetched.layerId, fetched.searchableText);
      counters.inc('chat.embeddings.upsert.ok');
      logger.info('restore upsert ok', {
        event: 'chat.embeddings.restore',
        kind: fetched.kind,
        entityId: fetched.id,
        layerId: fetched.layerId,
        table,
        dimensions: vector.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      counters.inc('chat.embeddings.upsert.failed');
      logger.error('restore upsert failed', {
        event: 'chat.embeddings.restore.failed',
        kind: fetched.kind,
        entityId: fetched.id,
        layerId: fetched.layerId,
        table,
        durationMs: Date.now() - startedAt,
        error: errorMessage(err),
      });
    }
  }

  async function handleDeleted(
    event: BusEvent<EntityDeletedPayload>,
    table: string,
  ): Promise<void> {
    const { ref } = event.payload;
    await safeRemove(table, ref.id, ref.kind, ref.layerId, 'deleted');
  }

  async function safeRemove(
    table: string,
    id: string,
    kind: string,
    layerId: string,
    reason: 'deleted' | 'restored' | 'empty_text' = 'empty_text',
  ): Promise<void> {
    const startedAt = Date.now();
    try {
      await deps.writer.removeById(table, id);
      counters.inc('chat.embeddings.remove.ok');
      logger.info('remove ok', {
        event: 'chat.embeddings.remove',
        kind,
        entityId: id,
        layerId,
        table,
        reason,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      counters.inc('chat.embeddings.remove.failed');
      logger.error('remove failed', {
        event: 'chat.embeddings.remove.failed',
        kind,
        entityId: id,
        layerId,
        table,
        reason,
        durationMs: Date.now() - startedAt,
        error: errorMessage(err),
      });
    }
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // Cap to ~500 chars — same convention as the scheduled-task
    // run subscriber. Stack traces stay on console.error only.
    return err.message.length > 500 ? `${err.message.slice(0, 497)}…` : err.message;
  }
  return String(err);
}
