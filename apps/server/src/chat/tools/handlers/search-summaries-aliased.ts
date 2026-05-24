/**
 * Phase 7.5 — `searchSummaries-aliased` tool handler adapter.
 *
 * Constructs a typed callable from a `tool` spec whose handler
 * declares `kind: 'searchSummaries-aliased'`. The adapter rewrites
 * the input term through an alias table (`{ from, to }[]`) before
 * delegating to a caller-supplied `searchSummaries` function. This
 * is the lightweight "Acmé → Acme" fix-up the headline phase-7
 * smoke test will eventually exercise.
 *
 * Phase 7.5 does NOT wire the adapter into the answerer — the
 * tool-calling answerer is a follow-up. The adapter exists so the
 * registry surface (`listTools`) has a real, typed callable to
 * return, and so the unit test pins the closed-enum-handler-kind
 * contract end-to-end.
 */

import { z } from 'zod';
import { type ToolHandler } from '@bunny2/shared';

/**
 * Closed config schema for `searchSummaries-aliased`. Aliases is a
 * directional map: each `{from, to}` pair replaces `from` with `to`
 * in the search term (substring; case-insensitive). `limit` defaults
 * to 10 — the answerer trims to its own per-step cap downstream.
 */
export const SearchSummariesAliasedConfigSchema = z
  .object({
    aliases: z
      .array(
        z
          .object({
            from: z.string().min(1).max(120),
            to: z.string().min(1).max(120),
          })
          .strict(),
      )
      .min(1)
      .max(50),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type SearchSummariesAliasedConfig = z.infer<typeof SearchSummariesAliasedConfigSchema>;

export interface SearchSummariesAliasedDeps {
  readonly searchSummaries: (
    layerIds: readonly string[],
    query: string,
    opts?: { readonly limit?: number },
  ) => Promise<
    readonly {
      readonly id: string;
      readonly kind: string;
      readonly layerId: string;
      readonly slug: string;
      readonly title: string;
      readonly searchableText: string;
    }[]
  >;
}

export interface SearchSummariesAliasedCallable {
  (input: { readonly layerIds: readonly string[]; readonly query: string }): Promise<
    readonly {
      readonly id: string;
      readonly kind: string;
      readonly layerId: string;
      readonly slug: string;
      readonly title: string;
      readonly searchableText: string;
    }[]
  >;
}

/**
 * Build a typed callable from the handler config + a delegate. The
 * registry stores the spec; this adapter binds the spec to a runtime
 * function. The function is pure besides delegating; the alias
 * substitution is case-insensitive but preserves the rest of the
 * term verbatim.
 *
 * Throws when the handler is not a `searchSummaries-aliased` row, so
 * a caller that picks the wrong adapter for the wrong row fails
 * loudly rather than silently mis-routing.
 */
export function buildSearchSummariesAliasedHandler(
  handler: ToolHandler,
  deps: SearchSummariesAliasedDeps,
): SearchSummariesAliasedCallable {
  if (handler.kind !== 'searchSummaries-aliased') {
    throw new Error(`buildSearchSummariesAliasedHandler: unexpected handler.kind=${handler.kind}`);
  }
  const cfg = SearchSummariesAliasedConfigSchema.parse(handler.config);
  return async (input) => {
    let q = input.query;
    for (const { from, to } of cfg.aliases) {
      // Case-insensitive substring replace, all occurrences.
      const re = new RegExp(escapeRegExp(from), 'gi');
      q = q.replace(re, to);
    }
    const opts = cfg.limit !== undefined ? { limit: cfg.limit } : undefined;
    return deps.searchSummaries(input.layerIds, q, opts);
  };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
