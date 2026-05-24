import type { ZodType } from 'zod';
import { TodoPayloadSchema, type TodoPayload } from '@bunny2/shared';
import type { EnrichmentJob, EntityModule } from '../module';
import type { EntityConnector } from '../connectors/base';

/**
 * Phase 4d.1 — fourth concrete `EntityModule`.
 *
 * Wires:
 *  - `kind = 'todo'` — the bus event prefix (`entity.todo.*`) and the
 *    URL segment (`/l/:slug/todo/...`, singular per the §4.0 router
 *    naming; the 4d.5 web UI will surface a friendlier
 *    `/l/:slug/todos` page that calls this URL underneath, mirroring
 *    the singular↔plural seam companies / contacts / calendar set up
 *    client-side).
 *  - `tableName = 'todos'` — the per-kind table created in
 *    `0010_todos.sql`.
 *  - `payloadSchema` — the cross-package zod schema from
 *    `packages/shared/src/todos.ts`.
 *  - `indexedColumns` — five denormalized columns the generic store
 *    writes on every insert/update: `status`, `priority`, `due_at`,
 *    `linked_entity_id`, `linked_entity_kind`. Mixes TEXT (4 cols)
 *    and INTEGER (`priority`); the §4.0 foundation's
 *    `IndexedValue = string | number | null` type space accepts both
 *    natively — same path calendar's `all_day` exercised in 4c.1.
 *    Zero foundation tweaks needed.
 *  - `toSummary` — composes a status descriptor plus optional
 *    `dueAt` plus optional link-kind hint. Mirrors calendar's
 *    pattern of embedding dynamic data directly in the subtitle;
 *    the 4d.5 UI handles locale-aware rendering on top.
 *  - `searchableText` — lowercase, space-joined digest of the fields
 *    a user is most likely to search for (title is added by the
 *    generic router; we add description, tags, status, dueAt).
 *
 * No enrichment jobs / stats provider in 4d.1 — auto-priority +
 * auto-due enrichment lands in 4d.3, the dashboard widget in 4d.4.
 * Phase 4d.2 added an OPTIONAL `connectors?` slot on
 * `CreateTodoModuleOptions` so a future Trello / Linear / Asana
 * import lands additively without touching this file's exported
 * surface. Production still ships ZERO concrete connectors in v1 —
 * `buildProductionTodoModule()` returns a connector-less module on
 * purpose (see `index.ts`). The factory shape mirrors
 * `createCalendarEventModule` so future sub-phases stay additive.
 */
export const TODO_KIND = 'todo';
export const TODO_TABLE = 'todos';

const SUBTITLE_MAX_LENGTH = 120;

/**
 * Phase 4d.2 — extended with an OPTIONAL `connectors?` slot. The slot
 * is empty in v1 production wiring (no Trello / Linear / Asana /
 * Google Tasks connector ships in this release; see
 * `docs/dev/plans/phase-04-first-entities.md` §14 — 4d.2 close-out).
 * The shape exists so a future connector — e.g. a `trelloConnector`
 * — can be threaded through `buildProductionTodoModule()` without
 * touching this file. 4d.3 (enrichment) will extend the same options
 * shape additively with `enrichmentJobs?`, mirroring the
 * companies / contacts / calendar precedent.
 *
 * Strictly typed as `readonly EntityConnector<TodoPayload>[]` so any
 * mistyped placeholder (e.g. a connector built for a different
 * payload kind) fails at compile time.
 */
export interface CreateTodoModuleOptions {
  readonly connectors?: readonly EntityConnector<TodoPayload>[];
  /**
   * Phase 4d.3 — optional enrichment-job override. Mirrors the
   * companies / contacts / calendar factory pattern. The factory
   * threads the value through with a conditional spread so the
   * module's `enrichmentJobs` field stays `undefined` when the slot
   * is omitted (matching the calendar precedent — empty arrays
   * change the registry's behaviour and the contract tests assert
   * `enrichmentJobs === undefined` for the omitted case).
   *
   * Production wiring sets this via `buildProductionTodoModule()` in
   * `index.ts` (the natural seam the 4d.2 close-out called out).
   * Tests bypass the helper and call `createTodoModule({
   * enrichmentJobs: [...] })` directly so they can inject fakes.
   *
   * No `enrichmentOverwriteFields` is declared on the module — both
   * jobs (`todos.autoPriority`, `todos.autoDue`) are gated by "skip
   * when the user-set field is already populated", so the runner's
   * default "fill the blank" policy is the right behaviour. This
   * matches the 4b.3 contacts shape.
   */
  readonly enrichmentJobs?: readonly EnrichmentJob<TodoPayload>[];
}

/**
 * Build a fresh `todoModule`. Production wiring calls this once at
 * boot (via `registerTodoModule`); tests call it per-fixture so they
 * can later inject stubs without colliding on registry state. The
 * default export `todoModule` uses the no-deps factory call.
 *
 * Phase 4d.2 — `opts.connectors` is threaded through with a
 * conditional spread so the module's `connectors` field stays
 * `undefined` when the slot is omitted (matching the calendar
 * precedent and what the registry's `rebuildConnectorIndex`
 * treats as "no bucket"). DO NOT default to `[]` — the contract
 * tests assert `connectors === undefined` for the empty case.
 */
export function createTodoModule(opts: CreateTodoModuleOptions = {}): EntityModule<TodoPayload> {
  return {
    kind: TODO_KIND,
    tableName: TODO_TABLE,
    ...(opts.connectors === undefined ? {} : { connectors: opts.connectors }),
    ...(opts.enrichmentJobs === undefined ? {} : { enrichmentJobs: opts.enrichmentJobs }),
    // Phase 4d.3 — `priority` MUST appear here because the zod schema
    // defaults `priority` to `3`. After parse, every stored payload
    // has `priority: 3` even when the user did not specify one — the
    // runner's `applyPatch` would otherwise see the `3` as a set
    // value and drop the patch. The auto-priority job's own gate
    // (`current !== undefined && current !== 3 → skip`) is the
    // actual user-intent protection; it is STRICTER than the
    // runner's "non-empty" check. `dueAt` has no schema default and
    // is genuinely `undefined` when unset, so it does not need the
    // overwrite slot — the runner's "fill the blank" default covers
    // it. See `docs/dev/decisions/0013-entity-enrichment.md` Update
    // (4d.3) for the rationale.
    enrichmentOverwriteFields: ['priority'],
    // The shared schema has `status: z.enum(...).default('open')` and
    // `priority: z.number().int().min(1).max(5).default(3)`, so its
    // INPUT type is `{ status?, priority?, ... }` while the PARSED
    // type is `{ status, priority, ... }`. The `EntityModule<Payload>`
    // slot wants `ZodType<Payload>` — the OUTPUT side. Cast through
    // the parsed type so the input/output asymmetry stays inside the
    // schema and out of the module surface. Calendar's 4c.1 module
    // does the same for `allDay`'s `default(false)`.
    payloadSchema: TodoPayloadSchema as unknown as ZodType<TodoPayload>,
    indexedColumns: [
      {
        name: 'status',
        // `status` defaults to 'open' via the zod schema, so this
        // never returns null in practice. The fallback exists only
        // to satisfy the `string | number | null` slot type.
        extract: (payload) => payload.status ?? 'open',
      },
      {
        name: 'priority',
        // Second non-TEXT indexed column the §4.0 foundation accepts
        // (after calendar's `all_day` in 4c.1). The
        // `IndexedValue = string | number | null` slot type already
        // covers INTEGER — zero foundation modifications.
        extract: (payload) => payload.priority ?? 3,
      },
      {
        name: 'due_at',
        extract: (payload) => payload.dueAt ?? null,
      },
      {
        name: 'linked_entity_id',
        // The migration's CHECK constraint enforces "both or
        // neither" between `linked_entity_id` and
        // `linked_entity_kind`. The shared `linkedEntityRef` zod
        // schema enforces the same invariant via the
        // `.object({ kind, entityId }).strict()` shape — so the two
        // extracts below always return both or both `null`.
        extract: (payload) => payload.linkedEntityRef?.entityId ?? null,
      },
      {
        name: 'linked_entity_kind',
        extract: (payload) => payload.linkedEntityRef?.kind ?? null,
      },
    ],
    toSummary({ ref, meta, payload, title }) {
      const status = payload.status ?? 'open';
      const dueAtPart = payload.dueAt !== undefined ? ` · due ${payload.dueAt}` : '';
      const linkPart =
        payload.linkedEntityRef !== undefined ? ` · @${payload.linkedEntityRef.kind}` : '';
      const subtitleRaw = `${status}${dueAtPart}${linkPart}`;
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

export const todoModule: EntityModule<TodoPayload> = createTodoModule();

function searchableTextFor(payload: TodoPayload): string {
  const parts: string[] = [];
  if (payload.description !== undefined) parts.push(payload.description);
  if (payload.tags !== undefined) {
    for (const t of payload.tags) parts.push(t);
  }
  if (payload.status !== undefined) parts.push(payload.status);
  if (payload.dueAt !== undefined) parts.push(payload.dueAt);
  // Lowercase the digest because the §4.0 store's `searchSummaries`
  // lowercases the query before substring-matching. Keeping both
  // sides lowercase is what makes "urgent" find a todo tagged
  // `#urgent`.
  return parts.join(' ').toLowerCase();
}
