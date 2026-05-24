/**
 * Phase 4.0 — universal entity event taxonomy.
 *
 * Per-kind events are emitted by the generic `EntityStore` (one event per
 * mutation, parameterized by `kind`). Connector events are emitted by
 * the generic connector base. Translator events are emitted by the
 * per-kind translator job. The taxonomy is closed over the `kind`
 * parameter — `entity.<kind>.{created,updated,deleted,restored}` — so
 * a subscriber that listens on the kind-prefixed type only sees its own
 * domain.
 *
 * Subscribers in phase 4 (announced; not all live in this commit):
 *  - The translator scheduled job — listens for
 *    `entity.<kind>.{created,updated}` and enqueues re-translation per
 *    layer locale.
 *  - The LanceDB index writer (write-side only; phase-6 reads apply the
 *    pre-retrieval auth filter).
 *  - The todo→calendar projection (4d.6) — listens for
 *    `entity.todo.{created,updated,deleted}`.
 *
 * Anti-leak invariants (mirroring `auth-and-sessions.md §9` /
 * `event-bus.md §9`):
 *  - Connector payloads (KvK numbers, Google calendar refresh tokens,
 *    encrypted blobs) NEVER appear in a bus event. The connector base
 *    scrubs `payload_json` before publish (see `connectors/base.ts`).
 *  - `searchableText` is a digest, not a content dump — short enough
 *    to live in an event without bloating the log.
 */

import type { EntityRef, EntitySyncState } from '@bunny2/shared';

export type EntityAction = 'created' | 'updated' | 'deleted' | 'restored';

/** `entity.<kind>.<action>` — assembled per emit. */
export function entityEventType(kind: string, action: EntityAction): string {
  return `entity.${kind}.${action}`;
}

export const ENTITY_EVENT_TYPES = {
  TranslationRequested: 'entity.translation.requested',
  TranslationCompleted: 'entity.translation.completed',
  ConnectorSyncRequested: 'entity.connector.sync.requested',
  ConnectorSyncSucceeded: 'entity.connector.sync.succeeded',
  ConnectorSyncFailed: 'entity.connector.sync.failed',
  ConnectorIngestRequested: 'entity.connector.ingest.requested',
  ConnectorIngestCompleted: 'entity.connector.ingest.completed',
  EnrichmentStarted: 'entity.enrichment.started',
  EnrichmentSucceeded: 'entity.enrichment.succeeded',
  EnrichmentFailed: 'entity.enrichment.failed',
  EnrichmentDeferred: 'entity.enrichment.deferred',
} as const;

export type EntityEventType = (typeof ENTITY_EVENT_TYPES)[keyof typeof ENTITY_EVENT_TYPES];

/** Payload shape for `entity.<kind>.created`. */
export interface EntityCreatedPayload {
  readonly ref: EntityRef;
  readonly version: number;
  readonly originalLocale: string;
  readonly searchableText: string;
}

/** Payload shape for `entity.<kind>.updated`. */
export interface EntityUpdatedPayload {
  readonly ref: EntityRef;
  readonly version: number;
  readonly previousVersion: number;
  readonly searchableText: string;
}

/** Payload shape for `entity.<kind>.deleted` (soft-delete). */
export interface EntityDeletedPayload {
  readonly ref: EntityRef;
  readonly version: number;
  readonly deletedBy: string;
}

/** Payload shape for `entity.<kind>.restored`. */
export interface EntityRestoredPayload {
  readonly ref: EntityRef;
  readonly version: number;
}

/** Payload shape for `entity.translation.requested`. */
export interface EntityTranslationRequestedPayload {
  readonly ref: EntityRef;
  readonly locale: string;
  /** The entity version this translation is sourced from. */
  readonly sourceVersion: number;
}

/** Payload shape for `entity.translation.completed`. */
export interface EntityTranslationCompletedPayload {
  readonly ref: EntityRef;
  readonly locale: string;
  readonly sourceVersion: number;
  readonly latencyMs: number;
}

/** Payload shape for `entity.connector.sync.requested`. */
export interface EntityConnectorSyncRequestedPayload {
  readonly ref: EntityRef;
  readonly connector: string;
  readonly externalId: string;
}

/** Payload shape for `entity.connector.sync.succeeded`. */
export interface EntityConnectorSyncSucceededPayload {
  readonly ref: EntityRef;
  readonly connector: string;
  readonly externalId: string;
  readonly syncState: EntitySyncState;
  readonly syncedAt: string;
}

/** Payload shape for `entity.connector.sync.failed`. */
export interface EntityConnectorSyncFailedPayload {
  readonly ref: EntityRef;
  readonly connector: string;
  readonly externalId: string;
  readonly error: string;
}

/**
 * Phase 4b.2 — payload-bearing ingest events.
 *
 * Anti-leak invariants:
 *  - `requested` carries `contentType` + `byteLength` only — NEVER the
 *    raw `bytes` or the `filename` (filename can contain user emails /
 *    PII; we log a numeric size instead).
 *  - `completed` carries a numeric summary only — counts of created /
 *    updated entities + a warning count. Individual entity refs are
 *    surfaced via the per-entity `entity.<kind>.{created,updated}`
 *    events the generic store already emits.
 */
export interface EntityConnectorIngestRequestedPayload {
  readonly kind: string;
  readonly connectorId: string;
  readonly layerId: string;
  readonly contentType: string;
  readonly byteLength: number;
}

export interface EntityConnectorIngestCompletedPayload {
  readonly kind: string;
  readonly connectorId: string;
  readonly layerId: string;
  readonly created: number;
  readonly updated: number;
  readonly warningCount: number;
}

/**
 * Phase 4a.3 enrichment events. The runner publishes these around every
 * `EntityModule.enrichmentJobs[]` invocation. Generic over kind — every
 * future entity kind that registers enrichment jobs reuses the surface.
 *
 * Anti-leak invariants:
 *  - The runner NEVER includes payload content (prompts, responses) in
 *    these events. Token counts + cost are quantitative — the full
 *    prompt + response lives in `llm_calls`, joined by `correlationId`.
 *  - `error` is an i18n key (e.g. `errors.entity.enrichment.failed`) or
 *    a redacted Error message — never a stack trace.
 */
export interface EntityEnrichmentStartedPayload {
  readonly kind: string;
  readonly entityId: string;
  readonly jobId: string;
}

export interface EntityEnrichmentSucceededPayload {
  readonly kind: string;
  readonly entityId: string;
  readonly jobId: string;
  readonly hasPatch: boolean;
  readonly tokensIn: number;
  readonly tokensOut: number;
  /** USD cost from the pricing map. `null` when the model is unknown. */
  readonly costUsd: number | null;
}

export interface EntityEnrichmentFailedPayload {
  readonly kind: string;
  readonly entityId: string;
  readonly jobId: string;
  readonly error: string;
}

/**
 * Emitted when the per-layer rate limit kicks in. The runner does NOT
 * call the LLM and does NOT consume a slot from the bucket; the entry
 * is re-queued so a later tick can satisfy it once the window slides.
 */
export interface EntityEnrichmentDeferredPayload {
  readonly kind: string;
  readonly entityId: string;
  readonly jobId: string;
  readonly layerId: string;
  readonly reason: 'rate_limited';
}
