/**
 * Phase 7.5 — answerer skill-fragment loader.
 *
 * The answerer's hard system prompt locks the model to the retrieval
 * JSON (ADR 0020 — phase 6.3). On top of that the answer step injects
 * "skill fragments": prompt snippets a proposal activated against a
 * `(layerId, intent)` key. Activation lands a row in
 * `layer_capabilities`; the loader reads it on every answer.
 *
 * Determinism: the returned list is ordered by `activatedAt` ascending
 * so a re-run with the same active set produces an identical prompt
 * (matters for the sandbox's "real delta" contract and for any future
 * snapshot test).
 *
 * Filtering:
 *  - `spec.artifactKind === 'skill'`
 *  - `spec.intent === intent` (the resolver's pinned closed enum)
 *  - the spec must zod-validate; a malformed row is skipped + logged
 *    upstream by the registry's defensive boundary, NOT here, so this
 *    helper stays a pure function over the registry's view.
 *
 * Phase-6 behaviour is preserved: if no skill rows match, the helper
 * returns `[]` and the answerer's prompt is byte-identical to before
 * 7.5. The orchestrator therefore keeps green every test that ignored
 * the registry.
 */

import {
  SkillProposalSpecSchema,
  type ChatIntent,
  type LayerCapability,
  type SkillProposalSpec,
} from '@bunny2/shared';
import type { CapabilityRegistry } from '../../proposals/capability-registry';

export interface LoadedSkillFragment {
  readonly capabilityId: string;
  readonly name: string;
  readonly promptFragment: string;
}

/**
 * Read activated skill capabilities for `layerId` matching `intent`,
 * sorted by `activatedAt` ascending. Returns `[]` on miss. Pure.
 */
export function loadSkillFragments(
  registry: CapabilityRegistry,
  layerId: string,
  intent: ChatIntent,
): readonly LoadedSkillFragment[] {
  const active = registry.listActive(layerId);
  const matched: { row: LayerCapability; spec: SkillProposalSpec }[] = [];
  for (const row of active) {
    if (row.kind !== 'skill') continue;
    let parsedSpec: unknown;
    try {
      parsedSpec = JSON.parse(row.specJson);
    } catch {
      continue;
    }
    const parsed = SkillProposalSpecSchema.safeParse(parsedSpec);
    if (!parsed.success) continue;
    if (parsed.data.intent !== intent) continue;
    matched.push({ row, spec: parsed.data });
  }
  matched.sort((a, b) => a.row.activatedAt.localeCompare(b.row.activatedAt));
  return matched.map(({ row, spec }) => ({
    capabilityId: row.id,
    name: spec.name,
    promptFragment: spec.promptFragment,
  }));
}
