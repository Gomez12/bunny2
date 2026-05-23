import type { ZodType } from 'zod';
import type { EntityMeta, EntityRef, EntitySummary } from '@bunny2/shared';
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
  readonly connectors?: readonly EntityConnector<Payload>[];
  readonly scheduledJobs?: readonly EntityScheduledJob[];
  readonly onCreate?: EntityLifecycleHook<Payload>;
  readonly onUpdate?: EntityLifecycleHook<Payload>;
  readonly onSoftDelete?: EntityLifecycleHook<Payload>;
  readonly onRestore?: EntityLifecycleHook<Payload>;
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
