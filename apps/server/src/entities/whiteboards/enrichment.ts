import type { WhiteboardPayload } from '@bunny2/shared';
import type { EnrichmentJob } from '../module';

/**
 * Phase 11.1 — empty enrichment-job list.
 *
 * Real jobs land in 11.3:
 *   - Scene summariser → writes a 1–2 sentence summary to
 *     `entity_souls.memory_json` for chat retrieval grounding.
 *   - `@mention` resolver → scans text elements for `@<name>` and
 *     `[[<name>]]` and writes resolved references to
 *     `entity_external_links` with `connector =
 *     'whiteboard.mention'`.
 *
 * The export shape mirrors the calendar / todos cadence so 11.3 can
 * wire its jobs additively without touching the module factory.
 * Typed as `readonly EnrichmentJob<WhiteboardPayload>[]` (not
 * `never[]`) so the 11.3 patch can change the array contents without
 * also changing the export type.
 */
export const whiteboardEnrichmentJobs: readonly EnrichmentJob<WhiteboardPayload>[] = [];
