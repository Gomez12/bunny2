/**
 * Phase 7.5 — `projection-lookup` tool handler adapter.
 *
 * Constructs a typed callable from a `tool` spec whose handler
 * declares `kind: 'projection-lookup'`. Routes a key+value lookup
 * through a caller-supplied projection (e.g. `calendar_projection_todos`
 * from phase 4d.6). The adapter knows nothing about the projection's
 * shape — it just enforces the typed-config contract + delegates.
 *
 * Same scope rule as `searchSummaries-aliased`: phase 7.5 does not
 * call this from the answerer (tool-calling answerer is a follow-up).
 * The unit test pins the closed-enum-handler-kind contract.
 */

import { z } from 'zod';
import { type ToolHandler } from '@bunny2/shared';

/**
 * Closed config schema for `projection-lookup`. `projection` is the
 * table/projection key; the registry of known projections is wired
 * by the caller, NOT by this adapter (a future code change adds a
 * projection by adding it to the caller's registry, NOT by extending
 * this schema).
 */
export const ProjectionLookupConfigSchema = z
  .object({
    projection: z.string().min(1).max(120),
    key: z.string().min(1).max(120),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
export type ProjectionLookupConfig = z.infer<typeof ProjectionLookupConfigSchema>;

export interface ProjectionLookupDeps {
  /**
   * Caller-owned projection registry. Returns `null` for an unknown
   * projection key (the answerer should fall through to retrieval).
   * Returning a typed callable keeps the adapter independent of the
   * underlying storage (SQLite today; could be anything tomorrow).
   */
  readonly resolveProjection: (
    projection: string,
  ) =>
    | null
    | ((
        layerIds: readonly string[],
        key: string,
        value: string,
        opts?: { readonly limit?: number },
      ) => Promise<readonly Readonly<Record<string, unknown>>[]>);
}

export interface ProjectionLookupCallable {
  (input: {
    readonly layerIds: readonly string[];
    readonly value: string;
  }): Promise<readonly Readonly<Record<string, unknown>>[]>;
}

export function buildProjectionLookupHandler(
  handler: ToolHandler,
  deps: ProjectionLookupDeps,
): ProjectionLookupCallable {
  if (handler.kind !== 'projection-lookup') {
    throw new Error(`buildProjectionLookupHandler: unexpected handler.kind=${handler.kind}`);
  }
  const cfg = ProjectionLookupConfigSchema.parse(handler.config);
  return async (input) => {
    const resolved = deps.resolveProjection(cfg.projection);
    if (resolved === null) return [];
    const opts = cfg.limit !== undefined ? { limit: cfg.limit } : undefined;
    return resolved(input.layerIds, cfg.key, input.value, opts);
  };
}
