/**
 * Phase 11.3 — `entity.whiteboards.enrich` scheduled-task handler.
 *
 * Daily sweep that catches whiteboards the event-based enrichment
 * runner (`apps/server/src/entities/enrichment-runner.ts`) missed —
 * e.g. server restart between PATCH and the runner's debounce
 * window, or an LLM outage that left the soul without a summary on
 * the previous tick. Mirrors the `chat.summarize-conversation`
 * pattern: per-event subscriber + scheduled sweep, both invoking
 * the same per-row work functions from `./enrichment.ts`.
 *
 * The runner's own debounce (default 5 s, see
 * `EnrichmentRunnerConfig.debounceMs`) is what coalesces a flurry
 * of saves into one enrichment pass — plan §9.3 calls out 60 s as
 * a proposal, but the runner is process-global; bumping it for one
 * kind would affect every other kind. The sweep below provides the
 * second-chance guarantee instead. See the final report for the
 * decision.
 *
 * Registration mirrors `registerChatScheduledTaskHandlers`: an
 * idempotent boot-time call that adds the handler to the
 * scheduled-task registry, wired into `apps/server/src/index.ts`
 * next to the chat / proposals / built-in helpers so the
 * `docs/dev/architecture/job-inventory.md` cross-check stays green.
 */

import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { Entity, WhiteboardPayload } from '@bunny2/shared';
import type { LlmClient } from '../../llm';
import {
  registerScheduledTaskHandler,
  getScheduledTaskHandler,
  type ScheduledTaskHandler,
  type ScheduledTaskRunContext,
} from '../../scheduled';
import { getEntityModule } from '../registry';
import { createEntityStore } from '../store';
import type { EntityModule } from '../module';
import { whiteboardModule } from './module';
import {
  whiteboardSceneSummaryJob,
  whiteboardMentionResolverJob,
  WHITEBOARD_SCENE_SUMMARY_JOB_ID,
} from './enrichment';

export const WHITEBOARDS_ENRICH_KIND = 'entity.whiteboards.enrich';

const DEFAULT_INTERVAL_MINUTES = 60 * 24;
/** Cap so a single sweep cannot OOM the worker on a layer with thousands of whiteboards. */
const DEFAULT_MAX_PER_SWEEP = 200;

interface SoulRow {
  memory_json: string;
}

interface WhiteboardRow {
  id: string;
}

/**
 * Per-sweep config read from `scheduled_tasks.config`. `maxPerSweep`
 * is the only knob; the schedule cadence is owned by the task row.
 */
export interface WhiteboardsEnrichConfig {
  readonly maxPerSweep: number;
}

function readConfig(raw: Readonly<Record<string, unknown>>): WhiteboardsEnrichConfig {
  return { maxPerSweep: pickPositiveInt(raw['maxPerSweep'], DEFAULT_MAX_PER_SWEEP) };
}

function pickPositiveInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) {
    return v;
  }
  return fallback;
}

/**
 * Find whiteboards that need a (re-)enrichment pass:
 *  - no soul row yet, OR
 *  - soul exists but `summarySourceVersion` is less than the
 *    whiteboard's current version, OR
 *  - soul exists with no `summarySourceVersion` (older shape; first
 *    sweep stamps it).
 *
 * Soft-deleted rows are excluded.
 */
export function listStaleWhiteboards(db: Database, limit: number): readonly WhiteboardRow[] {
  return db
    .query<WhiteboardRow, [number]>(
      `SELECT w.id
         FROM whiteboards w
         LEFT JOIN entity_souls s ON s.entity_id = w.id
        WHERE w.deleted_at IS NULL
          AND (
            s.entity_id IS NULL
            OR json_extract(s.memory_json, '$.summarySourceVersion') IS NULL
            OR CAST(json_extract(s.memory_json, '$.summarySourceVersion') AS INTEGER) < w.version
          )
        ORDER BY w.updated_at DESC
        LIMIT ?`,
    )
    .all(limit);
}

export interface WhiteboardsEnrichSweepResult {
  readonly considered: number;
  readonly enriched: number;
  readonly failed: number;
}

/**
 * Pure sweep function used by the scheduled handler and by the
 * smoke-worker tests. Loads each candidate via the whiteboards
 * `EntityStore` and invokes the two production jobs sequentially.
 *
 * Failures are LOGGED (via the optional `logger` shape mirroring the
 * runner's discipline) and counted; one bad row does not abort the
 * sweep.
 */
export async function runWhiteboardsEnrichSweep(deps: {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  readonly config: WhiteboardsEnrichConfig;
  readonly correlationId?: string;
  readonly logger?: {
    info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  };
}): Promise<WhiteboardsEnrichSweepResult> {
  const module =
    (getEntityModule('whiteboard') as EntityModule<WhiteboardPayload> | null) ?? whiteboardModule;
  const store = createEntityStore<WhiteboardPayload>({
    module,
    db: deps.db,
    bus: deps.bus,
    llm: deps.llm,
  });

  const candidates = listStaleWhiteboards(deps.db, deps.config.maxPerSweep);
  if (candidates.length === 0) {
    return { considered: 0, enriched: 0, failed: 0 };
  }

  let enriched = 0;
  let failed = 0;
  for (const row of candidates) {
    const entity = store.getById(row.id);
    if (entity === null) continue;
    try {
      await whiteboardSceneSummaryJob.run(entity, {
        db: deps.db,
        bus: deps.bus,
        llm: deps.llm,
        layerId: entity.layerId,
        trigger: 'updated',
        module,
        ...(deps.correlationId === undefined ? {} : { correlationId: deps.correlationId }),
      });
      await whiteboardMentionResolverJob.run(entity, {
        db: deps.db,
        bus: deps.bus,
        llm: deps.llm,
        layerId: entity.layerId,
        trigger: 'updated',
        module,
        ...(deps.correlationId === undefined ? {} : { correlationId: deps.correlationId }),
      });
      enriched += 1;
    } catch (err) {
      failed += 1;
      // No raw payloads in logs per AGENTS.md §Logging.
      deps.logger?.warn('entity.whiteboards.enrich row failed', {
        event: 'entity.whiteboards.enrich.row.failed',
        entityId: row.id,
        errorCode: err instanceof Error ? err.message : 'unknown',
      });
    }
  }

  return { considered: candidates.length, enriched, failed };
}

/**
 * The scheduled-task handler. Default cadence is daily (24 h) — the
 * event-driven runner already handles the fresh path; the sweep is
 * a safety net, not a hot path. Layer scope is `everyone`: per-layer
 * scoping would force one row per layer with no scaling benefit
 * because the per-row cap (`maxPerSweep`) already protects throughput.
 */
export const whiteboardsEnrichHandler: ScheduledTaskHandler = {
  kind: WHITEBOARDS_ENRICH_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(ctx: ScheduledTaskRunContext): Promise<void> {
    const config = readConfig(ctx.task.config);
    const result = await runWhiteboardsEnrichSweep({
      db: ctx.db,
      bus: ctx.bus,
      llm: ctx.llm,
      config,
      correlationId: ctx.correlationId,
      logger: ctx.logger,
    });
    ctx.logger.info('entity.whiteboards.enrich sweep complete', {
      event: 'entity.whiteboards.enrich.sweep.complete',
      considered: result.considered,
      enriched: result.enriched,
      failed: result.failed,
      maxPerSweep: config.maxPerSweep,
    });
  },
};

/**
 * Idempotent boot-time registration. Mirrors
 * `registerChatScheduledTaskHandlers` / `registerProposalsScheduledTaskHandlers`:
 * safe to call multiple times in production wiring, and the
 * docs-check / test suites call it with no deps so the registered
 * `kind` lines up with the documented row in
 * `docs/dev/architecture/job-inventory.md`.
 *
 * Signature accepts no deps because the handler resolves the
 * whiteboards module + store from the registry at run time — same
 * shape as `proposalsEvidencePruneHandler`'s registration in
 * `proposals/scheduled.ts`. Tests that need a per-fixture variant
 * register the module via `registerEntityModule(...)` BEFORE calling
 * this helper.
 */
export function registerWhiteboardsScheduledTaskHandlers(): void {
  const handlers: readonly ScheduledTaskHandler[] = [whiteboardsEnrichHandler];
  for (const handler of handlers) {
    if (getScheduledTaskHandler(handler.kind) === null) {
      registerScheduledTaskHandler(handler);
    }
  }
}

// Re-exported soul accessor for tests that want to read the summary
// without re-implementing the JSON path.
export function readWhiteboardSummary(
  db: Database,
  entityId: string,
): { summary: string; sourceVersion: number } | null {
  const row = db
    .query<SoulRow, [string]>('SELECT memory_json FROM entity_souls WHERE entity_id = ?')
    .get(entityId);
  if (row === null) return null;
  try {
    const parsed = JSON.parse(row.memory_json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const obj = parsed as Record<string, unknown>;
    const summary = obj['summary'];
    const version = obj['summarySourceVersion'];
    if (typeof summary !== 'string' || typeof version !== 'number') return null;
    return { summary, sourceVersion: version };
  } catch {
    return null;
  }
}

// Silence unused-import warnings when only some tests import a subset.
export type { Entity };
export { WHITEBOARD_SCENE_SUMMARY_JOB_ID };
