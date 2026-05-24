/**
 * Phase 7.5 — per-layer tool registry surface.
 *
 * Returns the activated `tool` capabilities for a layer in an
 * OpenAI-compatible function-calling shape: `{ name, description,
 * parameters }`. This is groundwork for the
 * `chat-tool-calling-answerer.md` follow-up — phase 7.5 does NOT
 * wire the answerer to actually call into this list (ADR 0020 §1
 * keeps the answerer hard-coded for now).
 *
 * Filtering:
 *  - `spec.artifactKind === 'tool'`
 *  - the spec must zod-validate; malformed rows are skipped silently
 *    so a row a future code change rejected can't crash the surface.
 *  - deactivated rows are excluded by the registry's `listActive`.
 *
 * Determinism: ordered by `activatedAt` ascending so a snapshot of
 * the registry produces a snapshot tool list. Tests assert the
 * shape; production callers will arrive in a later phase.
 */

import {
  ToolProposalSpecSchema,
  type LayerCapability,
  type ToolHandler,
  type ToolProposalSpec,
} from '@bunny2/shared';
import type { CapabilityRegistry } from '../../proposals/capability-registry';

export interface RegisteredTool {
  readonly capabilityId: string;
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly handler: ToolHandler;
}

/**
 * Read activated tool capabilities for `layerId` in
 * OpenAI-function-calling shape. Returns `[]` when no tools are
 * active. Pure.
 */
export function listTools(
  registry: CapabilityRegistry,
  layerId: string,
): readonly RegisteredTool[] {
  const active = registry.listActive(layerId);
  const matched: { row: LayerCapability; spec: ToolProposalSpec }[] = [];
  for (const row of active) {
    if (row.kind !== 'tool') continue;
    let parsedSpec: unknown;
    try {
      parsedSpec = JSON.parse(row.specJson);
    } catch {
      continue;
    }
    const parsed = ToolProposalSpecSchema.safeParse(parsedSpec);
    if (!parsed.success) continue;
    matched.push({ row, spec: parsed.data });
  }
  matched.sort((a, b) => a.row.activatedAt.localeCompare(b.row.activatedAt));
  return matched.map(({ row, spec }) => ({
    capabilityId: row.id,
    name: spec.name,
    description: spec.description,
    parameters: spec.jsonSchema,
    handler: spec.handler,
  }));
}
