/**
 * Phase 6.2 — `chat.embeddings.backfill` scheduled-task handler.
 *
 * Backfills missing LanceDB rows for the four phase-4 entity kinds.
 * Per the plan §4.3:
 *  - rate-limited (default 50 entities/min, **configurable** via
 *    `task.config.rateLimitPerMinute`);
 *  - idempotent by entity `id` (re-running the handler against a
 *    fully-indexed corpus is a no-op).
 *
 * The handler iterates each registered phase-4 module's
 * `store.listSummaries(allLayerIds, ...)`, pages through with an
 * `offset` until the kind is exhausted, and for each summary checks
 * the LanceDB writer (`getById`) before re-encoding. Rows that are
 * already present are skipped — which is what makes the handler
 * idempotent.
 *
 * `allLayerIds` is the set of non-deleted layers at the moment the
 * handler runs. The subscriber races independently so a tight inner
 * loop pickup may overlap — that's fine because both code paths use
 * `mergeInsert by id`.
 *
 * Rate limiting is intentionally crude: the handler counts encoded
 * rows and sleeps `60_000 / rate` ms between successive encodes. A
 * proper token bucket would be over-engineering for a job whose
 * worst-case is "embed all 5000 entities in 100 minutes once, then
 * stay idle".
 *
 * Failure handling: a single embed failure is logged and the loop
 * continues (the row stays missing; the next backfill tick or the
 * subscriber will retry). The handler does NOT throw — the
 * scheduled-task framework would mark the run failed and a future
 * tick would re-do the whole scan.
 */

import type { Database } from 'bun:sqlite';
import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../../scheduled';
import { listEntityModules, type EntityModule } from '../../entities';
import type { Embedder } from './embedder';
import { getLanceTableForKind, type LanceWriter } from './lance-tables';

export const CHAT_EMBEDDINGS_BACKFILL_KIND = 'chat.embeddings.backfill';

const DEFAULT_RATE_LIMIT_PER_MINUTE = 50;
const DEFAULT_INTERVAL_MINUTES = 60 * 24; // once a day; the subscriber covers fresh writes.
const PAGE_SIZE = 200;

export interface CreateBackfillHandlerDeps {
  readonly embedder: Embedder;
  readonly writer: LanceWriter;
  /** Resolves every registered entity module. Defaults to the global registry. */
  readonly listModules?: () => readonly EntityModule<unknown>[];
  /**
   * Returns the per-kind summary pages. Defaults to a thin wrapper
   * around the kind's table reading `searchable_text` + `slug` + `id`
   * + `layer_id` directly — see `defaultListSummaries`. The seam is
   * here so tests can pre-seed a deterministic set without booting a
   * full per-kind store.
   */
  readonly listSummaries?: ListSummariesFn;
  /**
   * Resolves the set of non-deleted layer ids the backfill scans.
   * Defaults to `SELECT id FROM layers WHERE deleted_at IS NULL`.
   * Overridable so unit tests can drive the loop without a real DB.
   */
  readonly listActiveLayerIds?: (db: Database) => readonly string[];
  /** Async sleep, overridable for tests. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export type ListSummariesFn = (
  db: Database,
  module: EntityModule<unknown>,
  layerIds: readonly string[],
  page: { limit: number; offset: number },
) => readonly BackfillSummary[];

export interface BackfillSummary {
  readonly id: string;
  readonly layerId: string;
  readonly slug: string;
  readonly searchableText: string;
}

export function createChatEmbeddingsBackfillHandler(
  deps: CreateBackfillHandlerDeps,
): ScheduledTaskHandler {
  const listModules = deps.listModules ?? (() => listEntityModules());
  const listSummaries = deps.listSummaries ?? defaultListSummaries;
  const listActiveLayers = deps.listActiveLayerIds ?? listActiveLayerIds;
  const sleep = deps.sleep ?? defaultSleep;

  return {
    kind: CHAT_EMBEDDINGS_BACKFILL_KIND,
    defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
    async run(ctx: ScheduledTaskRunContext): Promise<void> {
      const rateLimit = pickPositiveInt(
        ctx.task.config['rateLimitPerMinute'],
        DEFAULT_RATE_LIMIT_PER_MINUTE,
      );
      const sleepMs = Math.ceil(60_000 / rateLimit);
      const allLayerIds = listActiveLayers(ctx.db);
      const modules = listModules().filter((m) => getLanceTableForKind(m.kind) !== null);

      let encoded = 0;
      let skipped = 0;
      let failed = 0;

      for (const module of modules) {
        const table = getLanceTableForKind(module.kind);
        if (table === null) continue;
        let offset = 0;
        for (;;) {
          const page = listSummaries(ctx.db, module, allLayerIds, {
            limit: PAGE_SIZE,
            offset,
          });
          if (page.length === 0) break;
          for (const summary of page) {
            if (summary.searchableText.length === 0) {
              skipped += 1;
              continue;
            }
            // The hard rule for phase 6 is "no LanceDB on the
            // retrieval / read path". This `getById` is a
            // write-side idempotency check — comparing the stored
            // text against the entity's current `searchable_text` so
            // we don't re-spend tokens encoding rows that are
            // already up to date. It is NOT exposed to chat
            // retrieval (which stays on `searchSummaries` in
            // phase 6). The strict alternative would drop the
            // check and lean on `mergeInsert` idempotency, at the
            // cost of re-encoding the whole corpus every backfill
            // tick — meaningful money on `OpenAiEmbedder`. ADR 0021
            // calls out the read/write asymmetry; this read stays
            // on the write side of that line.
            const existing = await deps.writer.getById(table, summary.id);
            if (existing !== null && existing.text === summary.searchableText) {
              // Same text already vectorised — no need to re-encode.
              skipped += 1;
              continue;
            }
            try {
              const vector = await deps.embedder.encode(summary.searchableText);
              await deps.writer.upsert(table, {
                id: summary.id,
                layer_id: summary.layerId,
                kind: module.kind,
                slug: summary.slug,
                text: summary.searchableText,
                vector,
              });
              encoded += 1;
              ctx.logger.info('chat.embeddings.backfill encoded', {
                event: 'chat.embeddings.backfill.encoded',
                kind: module.kind,
                entityId: summary.id,
                layerId: summary.layerId,
                table,
                dimensions: vector.length,
              });
              if (sleepMs > 0) await sleep(sleepMs);
            } catch (err) {
              failed += 1;
              ctx.logger.error('chat.embeddings.backfill encode failed', {
                event: 'chat.embeddings.backfill.failed',
                kind: module.kind,
                entityId: summary.id,
                layerId: summary.layerId,
                table,
                error: errorMessage(err),
              });
            }
          }
          if (page.length < PAGE_SIZE) break;
          offset += PAGE_SIZE;
        }
      }

      ctx.logger.info('chat.embeddings.backfill summary', {
        event: 'chat.embeddings.backfill.summary',
        encoded,
        skipped,
        failed,
        rateLimit,
        modules: modules.length,
      });
    },
  };
}

function pickPositiveInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) {
    return v;
  }
  return fallback;
}

/**
 * Reads `id, layer_id, slug, searchable_text` from the kind's table.
 * Filters soft-deleted rows so the backfill mirrors the subscriber's
 * "soft-delete means no row" contract.
 *
 * Goes around the per-kind `EntityStore.listSummaries` to avoid
 * building per-kind stores (which need an `llm` + `bus` dep). The
 * shape of the per-kind table is fixed by the universal entity
 * contract — every per-kind table has these columns plus the kind's
 * own indexed columns.
 */
function defaultListSummaries(
  db: Database,
  module: EntityModule<unknown>,
  layerIds: readonly string[],
  page: { limit: number; offset: number },
): readonly BackfillSummary[] {
  if (layerIds.length === 0) return [];
  const placeholders = layerIds.map(() => '?').join(', ');
  const sql =
    `SELECT id, layer_id, slug, searchable_text FROM ${module.tableName} ` +
    `WHERE deleted_at IS NULL AND layer_id IN (${placeholders}) ` +
    `ORDER BY updated_at ASC LIMIT ? OFFSET ?`;
  type Row = {
    id: string;
    layer_id: string;
    slug: string;
    searchable_text: string;
  };
  const stmt = db.query<Row, (string | number)[]>(sql);
  const rows = stmt.all(...layerIds, page.limit, page.offset);
  return rows.map((row) => ({
    id: row.id,
    layerId: row.layer_id,
    slug: row.slug,
    searchableText: row.searchable_text,
  }));
}

function listActiveLayerIds(db: Database): readonly string[] {
  type Row = { id: string };
  const rows = db
    .query<Row, []>('SELECT id FROM layers WHERE deleted_at IS NULL ORDER BY created_at ASC')
    .all();
  return rows.map((r) => r.id);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 500 ? `${err.message.slice(0, 497)}…` : err.message;
  }
  return String(err);
}
