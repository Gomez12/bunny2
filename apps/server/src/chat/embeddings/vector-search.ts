/**
 * Phase 7.1 — vector read path for the chat pipeline's retrieval step.
 *
 * The phase-6 chat pipeline reads entity rows via SQLite LIKE inside
 * `EntityStore.searchSummaries` (see
 * `docs/dev/architecture/retrieval.md` §3). Phase 7 swaps that read
 * for a LanceDB vector query — behind the same retrieval-step seam,
 * with LIKE kept as a fallback.
 *
 * The swap is wired in `apps/server/src/http/router.ts` (the
 * orchestrator's `EntityStoreForRetrieval` adapter), not inside
 * `EntityStore` itself: keeping the per-kind store synchronous +
 * SQLite-only keeps the entity contract test surface unchanged and
 * matches the plan §4.1 promise that "the signature does not change".
 * The vector path is opt-in per-call: if any of the fallback triggers
 * fire, the call returns `null` and the caller drops back to the
 * sync LIKE path on the underlying store.
 *
 * Auth boundary (`overall.md` §5 invariant 8 / ADR 0021 §1): the
 * `layer_id IN (?)` filter runs BEFORE the neighbour scan. That is
 * enforced inside `LanceWriter.searchByVector` for both the production
 * LanceDB writer and the in-memory test writer; this file passes
 * `layerIds` through untouched so the contract holds at the helper
 * boundary too.
 *
 * Fallback triggers (returned as `null` so the caller can drop to LIKE):
 *   - `no-embedder` — deps.embedder is absent.
 *   - `mock-embedder` — the in-process `MockEmbedder` is the active
 *     embedder; CI / offline-dev paths stay deterministic on LIKE
 *     (the mock's hash is not semantically meaningful).
 *   - `corpus-empty` — the per-kind LanceDB table has zero rows OR
 *     does not exist yet (cold corpus). Treated as a fallback so a
 *     fresh deployment with no embeddings keeps answering questions.
 *   - `error` — the embedder threw OR the LanceDB query threw. We
 *     never let a vector outage starve the chat pipeline.
 *
 * Non-triggers (the caller MUST NOT fall back here):
 *   - Zero hits returned by a non-empty corpus. A populated corpus
 *     that genuinely has nothing close to the query returns `[]`,
 *     which is the correct answer; falling back to LIKE here would
 *     defeat the whole point of phase 7.
 *
 * Logging shape (per the plan §"Observability"):
 *   - `event: 'entity.search.vector'` on every successful vector
 *     query, with `{ kind, layerCount, hitCount, latencyMs }`.
 *   - `event: 'entity.search.vector.fallback'` on every fallback,
 *     with `{ kind, reason }`. The reason is a closed enum so the
 *     downstream telemetry label cardinality stays bounded.
 *
 * Telemetry (same conventions, names ASCII-stable):
 *   - `entity.search.vector.duration_ms` (dimensioned by `kind` only;
 *     never layer id, never query text).
 *   - `entity.search.vector.ok` / `entity.search.vector.fallback`
 *     counters dimensioned by `reason` on fallback so the operator
 *     can see why the vector path is being skipped.
 */

import { getLanceTableForKind, type LanceWriter, type VectorSearchHit } from './lance-tables';
import type { Embedder } from './embedder';

export type VectorSearchFallbackReason = 'no-embedder' | 'mock-embedder' | 'corpus-empty' | 'error';

export interface VectorSearchLogger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface VectorSearchCounters {
  inc(name: string, by?: number, dims?: Readonly<Record<string, string>>): void;
  observe?(name: string, value: number, dims?: Readonly<Record<string, string>>): void;
}

export interface CreateVectorSearchDeps {
  /**
   * Optional — when absent, every call returns `null` with reason
   * `no-embedder`. Lets `index.ts` always construct the helper while
   * still preserving the LIKE fallback for unusual boots.
   */
  readonly embedder?: Embedder;
  readonly reader: LanceWriter;
  readonly logger?: VectorSearchLogger;
  readonly counters?: VectorSearchCounters;
}

export interface VectorSearchHelper {
  /**
   * Returns the per-kind ranked vector hits, or `null` when the caller
   * MUST fall back to the LIKE path. Hits are layer-filtered
   * pre-scan; never returns a row outside `layerIds`.
   */
  searchByKind(
    kind: string,
    layerIds: readonly string[],
    term: string,
    limit: number,
  ): Promise<readonly VectorSearchHit[] | null>;
  /**
   * Reports the last-known fallback reason for a kind, if any. Used by
   * the chat orchestrator adapter to attach a stable reason label to
   * its own telemetry without re-running the embedder. Not load-
   * bearing for correctness.
   */
  lastFallbackReason(kind: string): VectorSearchFallbackReason | null;
}

const defaultLogger: VectorSearchLogger = {
  info: (msg, fields) => console.log(`[entity.search.vector] ${msg}`, fields ?? {}),
  warn: (msg, fields) => console.warn(`[entity.search.vector] ${msg}`, fields ?? {}),
};
const noopCounters: VectorSearchCounters = { inc: () => undefined };

export function createVectorSearch(deps: CreateVectorSearchDeps): VectorSearchHelper {
  const logger = deps.logger ?? defaultLogger;
  const counters = deps.counters ?? noopCounters;
  // Per-kind cached "the corpus has at least one row" boolean. Once we
  // observe a non-zero count we never re-check — saves a `countRows`
  // round-trip on every query. The cache only invalidates on a full
  // wipe (not a real flow today; if it ever becomes one, restart the
  // process or expose a `reset()` from the helper).
  const corpusNonEmpty = new Map<string, true>();
  const lastFallback = new Map<string, VectorSearchFallbackReason>();

  return {
    lastFallbackReason(kind) {
      return lastFallback.get(kind) ?? null;
    },
    async searchByKind(kind, layerIds, term, limit) {
      const startedAt = Date.now();
      const table = getLanceTableForKind(kind);
      if (table === null) {
        // Unknown kind: not really a "fallback" — the orchestrator
        // adapter will likely report `null` anyway via the underlying
        // store. We still log it so a typo in a kind name surfaces.
        recordFallback(kind, 'corpus-empty');
        return null;
      }
      if (deps.embedder === undefined) {
        recordFallback(kind, 'no-embedder');
        return null;
      }
      if (deps.embedder.id === 'mock') {
        recordFallback(kind, 'mock-embedder');
        return null;
      }
      if (layerIds.length === 0 || term.length === 0 || limit <= 0) {
        // Empty inputs: degenerate — return `[]` without burning an
        // embedder call. Not a fallback (the caller should not retry
        // LIKE on a zero-layer / zero-term query either).
        lastFallback.delete(kind);
        return [];
      }
      // Corpus-empty check. Cheap once the cache primes.
      if (!corpusNonEmpty.has(table)) {
        try {
          const count = await deps.reader.countRows(table);
          if (count === 0) {
            recordFallback(kind, 'corpus-empty');
            return null;
          }
          corpusNonEmpty.set(table, true);
        } catch (err) {
          // `countRows` failed — same posture as a query failure:
          // fall back, log, never throw into the pipeline.
          logger.warn('corpus count failed', {
            event: 'entity.search.vector.fallback',
            kind,
            reason: 'error',
            error: errorMessage(err),
          });
          recordFallback(kind, 'error');
          return null;
        }
      }

      let vector: Float32Array;
      try {
        vector = await deps.embedder.encode(term);
      } catch (err) {
        logger.warn('embedder failed', {
          event: 'entity.search.vector.fallback',
          kind,
          reason: 'error',
          error: errorMessage(err),
        });
        recordFallback(kind, 'error');
        return null;
      }

      try {
        const rows = await deps.reader.searchByVector(table, vector, layerIds, limit);
        if (rows === null) {
          // Cold table — same posture as `count === 0`.
          recordFallback(kind, 'corpus-empty');
          return null;
        }
        const latencyMs = Date.now() - startedAt;
        counters.inc('entity.search.vector.ok', 1, { kind });
        counters.observe?.('entity.search.vector.duration_ms', latencyMs, { kind });
        logger.info('vector search ok', {
          event: 'entity.search.vector',
          kind,
          layerCount: layerIds.length,
          hitCount: rows.length,
          latencyMs,
        });
        lastFallback.delete(kind);
        return rows;
      } catch (err) {
        logger.warn('vector query failed', {
          event: 'entity.search.vector.fallback',
          kind,
          reason: 'error',
          error: errorMessage(err),
        });
        recordFallback(kind, 'error');
        return null;
      }
    },
  };

  function recordFallback(kind: string, reason: VectorSearchFallbackReason): void {
    counters.inc('entity.search.vector.fallback', 1, { kind, reason });
    logger.info('vector fallback', {
      event: 'entity.search.vector.fallback',
      kind,
      reason,
    });
    lastFallback.set(kind, reason);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 500 ? `${err.message.slice(0, 497)}…` : err.message;
  }
  return String(err);
}
