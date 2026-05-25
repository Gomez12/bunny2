import type { ZodType } from 'zod';
import type { Entity, EntityMeta, EntityRef, EntitySummary } from '@bunny2/shared';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { LlmClient } from '../llm';
import type { EntityConnector } from './connectors/base';

/**
 * Phase 4.0 — server-internal contract every entity kind implements.
 *
 * A module is a small, declarative bundle:
 *  - `kind` — dotted, English, past-tense-irrelevant ("company",
 *    "contact", "calendar_event", "todo", ...). Used as the dotted
 *    segment in `entity.<kind>.<action>` event types and as the
 *    `entity_kind` column in the shared cross-cutting tables.
 *  - `tableName` — the per-kind table the `EntityStore` reads/writes
 *    (e.g. `companies`, `contacts`). Defined by the per-kind migration.
 *  - `payloadSchema` — zod schema for the kind-specific payload. The
 *    generic router validates request bodies against this before the
 *    store sees them.
 *  - `toSummary` — projects a payload + meta + ref into the universal
 *    `EntitySummary`. Used by the listing endpoints and by the LanceDB
 *    index writer (phase 6 read-side).
 *  - `searchableText` — short, denormalized text used by summary search
 *    and (later) embedding. Must NOT contain secrets; the connector
 *    base scrubs every external link payload separately.
 *  - `indexedColumns` — optional list of kind-specific columns the
 *    per-kind migration adds in addition to the shared shape (e.g.
 *    `companies.kvk_number`, `calendar_events.starts_at`,
 *    `todos.due_at`). Each entry tells the `EntityStore` how to derive
 *    the value from `payload` so the generic insert/update writes the
 *    denormalized column alongside the JSON payload. Added in 4a.1 —
 *    needed by every per-kind table that wants an indexable column,
 *    designed once instead of patched per kind. See §4.3 question 1 in
 *    `docs/dev/plans/done/phase-04-first-entities.md`.
 *  - `connectors` — optional list of `EntityConnector` instances. The
 *    registry holds them so phase 5 / 6 can enumerate every connector
 *    in the system.
 *  - `scheduledJobs` — optional list of job descriptors the phase-5
 *    scheduler picks up. In 4.0 the type only exists as a forward-
 *    declared opaque shape; phase 5 owns the runner.
 *  - lifecycle hooks (`onCreate`, `onUpdate`, `onSoftDelete`, `onRestore`)
 *    — optional per-kind callbacks invoked AFTER the row write and the
 *    bus publish. Use sparingly — most cross-cutting work belongs on
 *    the bus.
 */
export interface EntityModule<Payload> {
  readonly kind: string;
  readonly tableName: string;
  readonly payloadSchema: ZodType<Payload>;
  toSummary(input: {
    readonly ref: EntityRef;
    readonly meta: EntityMeta;
    readonly payload: Payload;
    /**
     * Row-level title supplied at create/update time. Modules MAY
     * derive a richer summary from `payload`, but the default
     * implementation should just return `title` so the row title and
     * the summary title stay in lockstep.
     */
    readonly title: string;
  }): EntitySummary;
  searchableText(payload: Payload): string;
  readonly indexedColumns?: readonly EntityIndexedColumn<Payload>[];
  /**
   * Optional indexed column name (must match an entry in
   * `indexedColumns`) that the generic list endpoint uses for the
   * `?from=&to=` range filter. When set, `GET /l/:slug/<kind>?from=…&to=…`
   * adds a SQL `AND <timeColumn> >= ? AND <timeColumn> <= ?` clause
   * against the indexed column; when omitted, the params are ignored.
   *
   * The store enforces at boot that the named column appears in
   * `indexedColumns` — a range filter on an unindexed column would be
   * a foot-gun for tables that grow.
   *
   * The router validates `from` / `to` as ISO-8601 strings (date or
   * date-time) via `Iso8601DateSchema` in `@bunny2/shared`. Lexico-
   * graphic ISO compare is sound; the column stores the same string
   * shape.
   *
   * Added in the calendar-list-range-filter follow-up (see
   * `docs/dev/follow-ups/done/calendar-list-range-filter.md`).
   * Calendar opts in with `timeColumn: 'starts_at'`; other kinds
   * remain opt-out.
   */
  readonly timeColumn?: string;
  readonly connectors?: readonly EntityConnector<Payload>[];
  readonly scheduledJobs?: readonly EntityScheduledJob[];
  /**
   * Phase 4a.3 — AI-enrichment jobs the generic runner picks up. Each
   * job declares which events trigger it; the runner subscribes once
   * per module and dispatches in order. Modules without enrichment
   * needs omit the field entirely.
   */
  readonly enrichmentJobs?: readonly EnrichmentJob<Payload>[];
  /**
   * Phase 4c.3 — Field names (keys of `Payload` as strings) that an
   * enrichment job is allowed to overwrite even when the current value
   * is non-empty / non-null. All other non-empty fields are protected
   * from runner-applied overwrites.
   *
   * Typed loosely as `readonly string[]` (NOT `keyof Payload`) because
   * the runner uses the list at a generic boundary where `Payload` is
   * erased and the list's variance does not survive narrowing. The
   * declarations remain self-documenting at the per-module level —
   * each module lists its own payload field names verbatim.
   *
   * Generalises the previously-hardcoded `description` exception (the
   * 4a.3 close-out predicted this generalisation when a second
   * exception landed; 4c.3's `attendees` + `meetingSummaryNote` are
   * the trigger). Modules that need NO overwrites omit the field
   * entirely; their enrichment can only fill empty fields.
   */
  readonly enrichmentOverwriteFields?: readonly string[];
  readonly onCreate?: EntityLifecycleHook<Payload>;
  readonly onUpdate?: EntityLifecycleHook<Payload>;
  readonly onSoftDelete?: EntityLifecycleHook<Payload>;
  readonly onRestore?: EntityLifecycleHook<Payload>;
  /**
   * Phase 4a.4 — optional aggregate-stats provider used by dashboard
   * widgets. The router exposes the provider's output verbatim under
   * `GET /l/:slug/<kind>/_stats`. Modules without a stats need omit the
   * field entirely; the router responds with 404 in that case. Same
   * additive shape as `indexedColumns` (4a.1) and `enrichmentJobs`
   * (4a.3): a small, declarative slot the foundation accepts so the
   * stats shape stays per-kind without leaking into the generic router.
   */
  readonly statsProvider?: EntityStatsProvider;
}

/**
 * Pure-SQL aggregate provider. `compute` runs synchronously against the
 * shared `Database` handle and returns whatever JSON-serialisable shape
 * the kind's dashboard widget expects. The router does not enforce a
 * specific stat surface — each kind owns its own shape.
 */
export interface EntityStatsProvider {
  compute(ctx: EntityStatsContext): Record<string, unknown>;
}

export interface EntityStatsContext {
  readonly layerId: string;
  readonly db: Database;
  /**
   * Injectable clock for deterministic "recently …" buckets in tests.
   * Defaults to `() => new Date()` at the router; providers should rely
   * on the value, not on `Date.now()` directly.
   */
  readonly now: () => Date;
}

/**
 * Declarative descriptor for a per-kind indexed column.
 *
 * The `EntityStore` writes the value returned by `extract(payload)` into
 * the column on every insert/update, alongside the JSON payload. SQLite
 * stores `null`, strings, and finite numbers natively; that is the only
 * value space we promise. Modules that need a richer shape should keep
 * the canonical value in `payload` and project a primitive here.
 *
 * `name` MUST match `/^[a-z_][a-z0-9_]*$/` — the store interpolates it
 * into SQL once at factory time, and the validator rejects anything
 * else at boot, not at first request.
 */
export interface EntityIndexedColumn<Payload> {
  readonly name: string;
  extract(payload: Payload): string | number | null;
}

/** Lifecycle context shared by all per-module hooks. */
export interface EntityLifecycleContext<Payload> {
  readonly ref: EntityRef;
  readonly meta: EntityMeta;
  readonly payload: Payload;
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
}

export type EntityLifecycleHook<Payload> = (ctx: EntityLifecycleContext<Payload>) => Promise<void>;

/**
 * Opaque scheduled-job descriptor. The phase-5 scheduler owns the
 * runtime shape; phase 4.0 only needs the marker so modules can
 * declare future work additively.
 */
export interface EntityScheduledJob {
  readonly id: string;
  readonly kind: string;
  readonly cron: string;
}

/**
 * Phase 4a.3 — AI-enrichment job descriptor.
 *
 * `runOn` lists the trigger surfaces. The runner subscribes once per
 * module to `entity.<kind>.created`, `entity.<kind>.updated`, and
 * `entity.connector.sync.succeeded`. For each registered job whose
 * `runOn` matches the trigger, the runner debounces by entityId, then
 * calls `run(entity, ctx)`.
 *
 * `run` MUST NOT call `store.update` itself — the runner owns patch
 * application, version bumping, and event emission. Return `{}` or
 * `{ patch: {} }` to signal "no change".
 *
 * The runner applies the patch by reading the current payload via the
 * store and merging the job's partial. `null`-valued fields in the
 * patch are SKIPPED (treated as "uncertain"); the LLM prompt is
 * expected to return `null` on uncertainty so the runner can apply
 * defense-in-depth.
 *
 * The runner refuses to overwrite a non-empty existing field UNLESS
 * the field name appears in `module.enrichmentOverwriteFields` (see
 * `EntityModule`). Empty / null / whitespace-only fields are always
 * fair game regardless of that list — "fill the blank" is the default.
 */
export type EnrichmentTrigger = 'created' | 'updated' | 'sync.succeeded';

export interface EnrichmentJob<Payload> {
  readonly id: string;
  readonly runOn: readonly EnrichmentTrigger[];
  run(
    entity: Entity<Payload>,
    ctx: EnrichmentJobContext<Payload>,
  ): Promise<EnrichmentResult<Payload>>;
}

/** Context handed to every enrichment job. */
export interface EnrichmentJobContext<Payload> {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  /** The layer the entity lives in — handy for telemetry / prompts. */
  readonly layerId: string;
  /** Why this job ran this time — useful for prompt selection. */
  readonly trigger: EnrichmentTrigger;
  /** Correlation id threaded from the source event when available. */
  readonly correlationId?: string;
  /** Module the job belongs to. */
  readonly module: EntityModule<Payload>;
}

export interface EnrichmentResult<Payload> {
  /**
   * Partial payload to merge into the entity. Empty / missing means no
   * change — the runner does NOT call `store.update`. `null`-valued
   * fields are skipped by the runner (see `EnrichmentJob` doc).
   */
  readonly patch?: Partial<Payload>;
  /** Optional human-readable note for telemetry. Not persisted. */
  readonly note?: string;
  /** Token counts the job observed. The runner threads these into the success event. */
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  /** Model name used by the job — used for cost lookup. */
  readonly model?: string;
}
