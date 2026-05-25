import type { ZodType } from 'zod';
import { WhiteboardPayloadSchema, type WhiteboardPayload } from '@bunny2/shared';
import type { EnrichmentJob, EntityModule } from '../module';
import type { EntityConnector } from '../connectors/base';
import { whiteboardStatsProvider } from './stats';

/**
 * Phase 11.1 — fifth concrete `EntityModule`.
 *
 * Wires:
 *  - `kind = 'whiteboard'` — the bus event prefix (`entity.whiteboard.*`)
 *    and the URL segment (`/l/:slug/whiteboard/...`, singular per the
 *    §4.0 router naming; the 11.5 web UI will surface a friendlier
 *    `/l/:slug/whiteboards` page that calls this URL underneath,
 *    mirroring the singular↔plural seam companies / contacts /
 *    calendar / todos set up client-side).
 *  - `tableName = 'whiteboards'` — the per-kind table created in
 *    `0021_whiteboards.sql`.
 *  - `payloadSchema` — the cross-package zod schema from
 *    `packages/shared/src/whiteboards.ts`. Per ADR 0028, elements are
 *    validated only on `version`/`type`/`id`; the rest passes through
 *    as opaque `unknown`.
 *  - `indexedColumns` — ONE denormalized column the generic store
 *    writes on every insert/update: `scene_byte_size`. The other two
 *    whiteboard-specific columns (`last_checkpoint_at`,
 *    `thumbnail_etag`, plus the matching `thumbnail_blob` BLOB) are
 *    SERVER-MANAGED, set out-of-band by the 11.5 PATCH/checkpoint
 *    flow. Putting them in `indexedColumns` with a no-op extract
 *    would erase them on every save — see the migration's column
 *    comment.
 *  - `toSummary` — composes a subtitle showing the element count
 *    badge (deliberately cheap — the count is already in the payload,
 *    no extra SQL).
 *  - `searchableText` — lowercase, space-joined digest of TEXT
 *    elements only. Non-text element bodies (lines, arrows, images,
 *    geometric shapes) NEVER reach the searchable index — that's the
 *    plan §7 "LanceDB index pollution" mitigation, captured in ADR
 *    0028.
 *
 * No enrichment jobs in 11.1 — scene summarisation + `@mention`
 * resolution land in 11.3. No connectors in 11.1 — the placeholder
 * lands in 11.2. The `CreateWhiteboardModuleOptions` shape mirrors
 * `CreateTodoModuleOptions` so future sub-phases stay additive.
 */
export const WHITEBOARD_KIND = 'whiteboard';
export const WHITEBOARD_TABLE = 'whiteboards';

const SUBTITLE_MAX_LENGTH = 120;

/**
 * Phase 11.1 — option shape mirrors `CreateTodoModuleOptions`.
 *
 * Both slots are optional and intentionally empty in v1:
 *   - `connectors`  — wired in 11.2 (placeholder `EntityConnector`
 *                     that refuses sync). Strictly typed as
 *                     `readonly EntityConnector<WhiteboardPayload>[]`
 *                     so any mistyped placeholder fails at compile
 *                     time.
 *   - `enrichmentJobs` — wired in 11.3 (scene summariser + mention
 *                     resolver). Same `EnrichmentJob<WhiteboardPayload>`
 *                     typing as the calendar / todos precedent so the
 *                     runner picks the jobs up without per-kind glue.
 *
 * The factory threads each value through with a conditional spread so
 * the module's slot stays `undefined` when the option is omitted —
 * matching the calendar / todos precedent and what the registry's
 * `rebuildConnectorIndex` treats as "no bucket". DO NOT default to
 * `[]` — the contract tests assert `connectors === undefined` for the
 * empty case.
 */
export interface CreateWhiteboardModuleOptions {
  readonly connectors?: readonly EntityConnector<WhiteboardPayload>[];
  readonly enrichmentJobs?: readonly EnrichmentJob<WhiteboardPayload>[];
}

/**
 * Build a fresh `whiteboardModule`. Production wiring calls this once
 * at boot (via `registerWhiteboardModule` in `./index.ts`); tests call
 * it per-fixture so they can later inject stubs without colliding on
 * registry state. The default export `whiteboardModule` uses the
 * no-deps factory call.
 */
export function createWhiteboardModule(
  opts: CreateWhiteboardModuleOptions = {},
): EntityModule<WhiteboardPayload> {
  return {
    kind: WHITEBOARD_KIND,
    tableName: WHITEBOARD_TABLE,
    ...(opts.connectors === undefined ? {} : { connectors: opts.connectors }),
    ...(opts.enrichmentJobs === undefined ? {} : { enrichmentJobs: opts.enrichmentJobs }),
    // The shared schema has no fields with `default(...)` — both top-level
    // keys (`scene`, `files`) are required and have no defaults, so the
    // input and output types coincide. The cast through `unknown` mirrors
    // the calendar / todos precedent and is purely defensive against
    // future schema additions that might introduce defaults.
    payloadSchema: WhiteboardPayloadSchema as unknown as ZodType<WhiteboardPayload>,
    statsProvider: whiteboardStatsProvider,
    indexedColumns: [
      {
        name: 'scene_byte_size',
        // `JSON.stringify(payload).length` is UTF-16 code units, not
        // bytes — close enough for the 11.5 size-cap heuristic but
        // documented for the future TextEncoder switch if/when the
        // cap moves to true byte-accurate.
        extract: (payload) => JSON.stringify(payload).length,
      },
    ],
    toSummary({ ref, meta, payload, title }) {
      const elementCount = payload.scene.elements.length;
      const subtitleRaw = `${elementCount} element${elementCount === 1 ? '' : 's'}`;
      const subtitle =
        subtitleRaw.length > SUBTITLE_MAX_LENGTH
          ? `${subtitleRaw.slice(0, SUBTITLE_MAX_LENGTH - 1)}…`
          : subtitleRaw;
      return {
        ...ref,
        meta,
        title,
        subtitle,
        searchableText: searchableTextFor(payload),
      };
    },
    searchableText(payload) {
      return searchableTextFor(payload);
    },
  };
}

export const whiteboardModule: EntityModule<WhiteboardPayload> = createWhiteboardModule();

/**
 * Extract lowercase text content from text elements ONLY. Non-text
 * elements (lines, arrows, rectangles, images, …) are deliberately
 * skipped — they have no human-readable content and would pollute the
 * LanceDB index per plan §7 Risks "LanceDB index pollution". This is
 * the mitigation captured in ADR 0028.
 *
 * Elements are opaque `unknown` per ADR 0028, so the function uses
 * runtime type guards (`typeof === 'string'` / `typeof === 'object'`)
 * rather than narrowing against a structural type.
 */
function searchableTextFor(payload: WhiteboardPayload): string {
  const parts: string[] = [];
  for (const el of payload.scene.elements) {
    if (el === null || typeof el !== 'object') continue;
    const elObj = el as Record<string, unknown>;
    if (elObj.type !== 'text') continue;
    const text = elObj.text;
    if (typeof text !== 'string') continue;
    parts.push(text);
  }
  // Lowercase the digest because the §4.0 store's `searchSummaries`
  // lowercases the query before substring-matching. Keeping both
  // sides lowercase is what makes the chat retrieval (phase 6) find
  // a whiteboard whose text element says "AMI BV" when the query
  // says "ami".
  return parts.join(' ').toLowerCase();
}
