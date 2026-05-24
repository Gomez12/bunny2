/**
 * Phase 6.3 — retrieval step (NO LLM).
 *
 * For each `(kind, term)` pair the resolver produced, call
 * `EntityStore.searchSummaries(ctx.effectiveLayerIds, term, { limit: 5 })`.
 * Aggregate, dedupe by id, cap at 20 hits.
 *
 * THIS IS THE AUTH BOUNDARY (plan §10, `overall.md` §5 invariant 8).
 * Layer filtering happens inside `searchSummaries` because we hand it
 * `ctx.effectiveLayerIds`. The answerer never sees a row outside the
 * caller's visible layers.
 *
 * Snippet shape: `text` ≤ 400 chars. We use `searchableText` because
 * (a) it's already denormalised by the per-kind module's
 * `searchableText(payload)` callback, and (b) it stays scrubbed of
 * external-link secrets (per the entity store contract).
 */

import {
  PIPELINE_ENTITY_KINDS,
  RetrievalOutputSchema,
  type EntitiesOutput,
  type EntityKind,
  type IntentOutput,
  type PipelineContext,
  type PipelineDeps,
  type PipelineStep,
  type PipelineStepResult,
  type RetrievalHit,
  type RetrievalOutput,
} from './types';

const PER_QUERY_LIMIT = 5;
const TOTAL_HITS_CAP = 20;
const SNIPPET_MAX = 400;

export interface RetrievalStepInput {
  readonly intent: IntentOutput;
  readonly entities: EntitiesOutput;
}

export function createRetrievalStep(): PipelineStep<RetrievalStepInput, RetrievalOutput> {
  return {
    kind: 'retrieval',
    async run(
      input: RetrievalStepInput,
      ctx: PipelineContext,
      deps: PipelineDeps,
    ): Promise<PipelineStepResult<RetrievalOutput>> {
      // Smalltalk / command.* / unsupported intents skip retrieval —
      // there's nothing useful to look up. The orchestrator still
      // logs a step row so the Kanban has all four columns; we mark
      // it `skipped` with an empty hits list.
      const intent = input.intent.intent;
      const skipForIntent =
        intent === 'smalltalk' ||
        intent === 'unsupported' ||
        intent === 'command.create' ||
        intent === 'command.update';
      if (skipForIntent) {
        const value: RetrievalOutput = { hits: [], skipped: true };
        return {
          value,
          outputJson: JSON.stringify(value),
          llmCallId: null,
          status: 'skipped',
        };
      }

      const targetKinds = expandKinds(input.entities);
      const dedup = new Map<string, RetrievalHit>();

      for (const hint of input.entities.queryHints) {
        const kinds = hint.kind !== undefined ? [hint.kind] : targetKinds;
        for (const kind of kinds) {
          const store = deps.getEntityStore(kind);
          if (store === null) continue;
          const term = hint.term.trim();
          if (term.length === 0) continue;
          // Phase 7.1 — `searchSummaries` is async now: the orchestrator
          // adapter may consult LanceDB before falling back to LIKE.
          // The auth-boundary contract is unchanged (the `layerIds`
          // filter runs pre-search on both paths — ADR 0021 §1).
          const summaries = await store.searchSummaries(ctx.effectiveLayerIds, term, {
            limit: PER_QUERY_LIMIT,
          });
          for (const s of summaries) {
            if (dedup.has(s.id)) continue;
            const text = (s.searchableText ?? '').slice(0, SNIPPET_MAX);
            dedup.set(s.id, {
              id: s.id,
              kind: s.kind as EntityKind,
              layerId: s.layerId,
              slug: s.slug,
              title: s.title,
              text,
            });
            if (dedup.size >= TOTAL_HITS_CAP) break;
          }
          if (dedup.size >= TOTAL_HITS_CAP) break;
        }
        if (dedup.size >= TOTAL_HITS_CAP) break;
      }

      const value: RetrievalOutput = {
        hits: Array.from(dedup.values()),
        skipped: false,
      };
      // Belt-and-braces zod check — guards future refactors.
      const parsed = RetrievalOutputSchema.parse(value);
      return {
        value: parsed,
        outputJson: JSON.stringify(parsed),
        llmCallId: null,
        status: 'succeeded',
      };
    },
  };
}

function expandKinds(out: EntitiesOutput): readonly EntityKind[] {
  if (out.kinds.length > 0) return out.kinds;
  // Resolver returned no kinds → fan out across every registered
  // kind. The per-kind store lookup will return `null` for kinds
  // the host didn't wire, and the loop simply skips them.
  return PIPELINE_ENTITY_KINDS;
}
