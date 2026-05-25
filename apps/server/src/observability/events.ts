/**
 * Phase 2 — `admin.observability.*` bus-event taxonomy.
 *
 * Telemetry in this project = bus events on the `events` table
 * (see `docs/dev/observability/telemetry.md` §4). The admin
 * observability viewers each publish one such event per query
 * carrying `{ durationMs, rowCount, filterKeys }`.
 *
 * Why a separate file from `bus/events.ts`: those events describe
 * the durable bus itself (DLQ lifecycle). The events here describe
 * the admin observability HTTP surface — different layer, no
 * cycle (observability depends on bus, not vice-versa).
 *
 * Phase 2 ships `EventsQuery`; phase 3 adds three LLM-calls events
 * (`LlmCallsQuery` / `LlmCallsDetail` / `LlmCallsRollups`); phase 4
 * appends three chat-runs events (`ChatRunsQuery` / `ChatRunsDetail`
 * / `ChatRunsRawContentViewed`); phase 5 adds bus-outbox events;
 * phase 6 appends `AnalyticsQuery` / `AnalyticsRollups` for the admin
 * viewer surface AND the separate `analytics.events.*` family
 * (`Ingested` / `Rejected` / `Pruned`) for the web-sink write path.
 * The const-tuple keeps the catalogue closed at compile time so a
 * typo in a producer fails the typecheck.
 */

export const ADMIN_OBSERVABILITY_EVENT_TYPES = {
  EventsQuery: 'admin.observability.events.query',
  LlmCallsQuery: 'admin.observability.llm-calls.query',
  LlmCallsDetail: 'admin.observability.llm-calls.detail',
  LlmCallsRollups: 'admin.observability.llm-calls.rollups',
  ChatRunsQuery: 'admin.observability.chat-runs.query',
  ChatRunsDetail: 'admin.observability.chat-runs.detail',
  ChatRunsRawContentViewed: 'admin.observability.chat-runs.raw-content.viewed',
  BusOutboxQuery: 'admin.observability.bus-outbox.query',
  BusOutboxDetail: 'admin.observability.bus-outbox.detail',
  AnalyticsQuery: 'admin.observability.analytics.query',
  AnalyticsRollups: 'admin.observability.analytics.rollups',
} as const;

/**
 * Phase 6 — separate `analytics.events.*` family for the WRITE path
 * (`POST /analytics/events`) and the retention job. Kept apart from
 * the `admin.observability.*` namespace because these are not
 * admin-viewer queries — they fire on user-driven ingest and on the
 * scheduled prune. Both are stable-named, low-cardinality
 * (`event_name` dimension is bounded by the catalogue in
 * `apps/server/src/analytics/catalogue.ts`).
 */
export const ANALYTICS_SINK_EVENT_TYPES = {
  Ingested: 'analytics.events.ingested',
  Rejected: 'analytics.events.rejected',
  Pruned: 'analytics.events.pruned',
} as const;

export type AnalyticsSinkEventType =
  (typeof ANALYTICS_SINK_EVENT_TYPES)[keyof typeof ANALYTICS_SINK_EVENT_TYPES];

/**
 * Phase 6 — admin analytics-viewer list query payload. Same shape as
 * the other admin viewer query events so a SELECT against `events`
 * can aggregate latency across the whole admin observability
 * surface.
 */
export interface AdminObservabilityAnalyticsQueryPayload {
  readonly durationMs: number;
  readonly rowCount: number;
  readonly filterKeys: readonly string[];
  readonly limit: number;
  readonly hasCursor: boolean;
}

/**
 * Phase 6 — admin analytics-viewer rollups payload. Same closed
 * dimension set as `AdminObservabilityLlmCallsRollupsPayload`; the
 * counts are aggregates only (no per-event-name labels on the
 * telemetry event itself — those land in the rollups response body).
 */
export interface AdminObservabilityAnalyticsRollupsPayload {
  readonly durationMs: number;
  readonly count24h: number;
  readonly count7d: number;
}

/**
 * Phase 6 — `POST /analytics/events` accepted-write payload. The
 * `event_name` dimension is bounded by the closed catalogue, so it
 * is safe to label by name (cardinality stays in the dozens). No
 * per-user / per-layer labels — those would explode cardinality.
 */
export interface AnalyticsEventsIngestedPayload {
  readonly eventName: string;
}

/**
 * Phase 6 — `POST /analytics/events` rejection payload. `reason` is
 * a closed string union so dashboards can pivot on it without
 * per-payload context. `eventName` is included when known (i.e. the
 * envelope parsed but failed catalogue validation); name-not-string
 * rejections set it to `null`.
 */
export type AnalyticsEventsRejectedReason =
  | 'unknown_name'
  | 'unknown_property'
  | 'invalid_envelope'
  | 'payload_too_large'
  | 'invalid_property_value';

export interface AnalyticsEventsRejectedPayload {
  readonly eventName: string | null;
  readonly reason: AnalyticsEventsRejectedReason;
}

/**
 * Phase 6 — `analytics.events.prune` outcome payload. `deletedCount`
 * is an aggregate; no per-row identifiers leave the prune handler.
 */
export interface AnalyticsEventsPrunedPayload {
  readonly deletedCount: number;
  readonly retentionDays: number;
}

export type AdminObservabilityEventType =
  (typeof ADMIN_OBSERVABILITY_EVENT_TYPES)[keyof typeof ADMIN_OBSERVABILITY_EVENT_TYPES];

/**
 * Payload published on every admin events-viewer query.
 *
 * `filterKeys` lists the filter names the caller activated — useful
 * for "which filter is hot" rollups without leaking the actual
 * values (correlation/flow ids and layer ids are kept out of the
 * telemetry payload by design).
 */
export interface AdminObservabilityEventsQueryPayload {
  readonly durationMs: number;
  readonly rowCount: number;
  readonly filterKeys: readonly string[];
  readonly limit: number;
  readonly hasCursor: boolean;
}

/**
 * Payload published on every admin LLM-calls list query. Same
 * stable-dimension shape as `AdminObservabilityEventsQueryPayload`
 * so dashboards can aggregate by `type` across all admin viewers.
 */
export interface AdminObservabilityLlmCallsQueryPayload {
  readonly durationMs: number;
  readonly rowCount: number;
  readonly filterKeys: readonly string[];
  readonly limit: number;
  readonly hasCursor: boolean;
}

/**
 * Payload published on every admin LLM-call detail fetch.
 * `requestTruncated` / `responseTruncated` capture R3 mitigation
 * activity so operators can see "how often did a >200KB payload
 * trip the truncation" without surfacing the bytes themselves.
 */
export interface AdminObservabilityLlmCallsDetailPayload {
  readonly durationMs: number;
  readonly found: boolean;
  readonly requestTruncated: boolean;
  readonly responseTruncated: boolean;
  readonly linkedEventCount: number;
}

/**
 * Payload published on every admin LLM-calls rollups computation.
 * Returns rolling 24h / 7d windows; the payload carries only the
 * aggregate counts (no per-user / per-layer breakdown — low
 * cardinality per `AGENTS.md §Telemetry`).
 */
export interface AdminObservabilityLlmCallsRollupsPayload {
  readonly durationMs: number;
  readonly count24h: number;
  readonly count7d: number;
}

/**
 * Phase 4 — chat-pipeline runs list query payload. Same stable-
 * dimension shape as the other admin viewers so dashboards can
 * aggregate by `type` across surfaces.
 */
export interface AdminObservabilityChatRunsQueryPayload {
  readonly durationMs: number;
  readonly rowCount: number;
  readonly filterKeys: readonly string[];
  readonly limit: number;
  readonly hasCursor: boolean;
}

/**
 * Phase 4 — chat-pipeline run detail. `stepCount` and
 * `linkedLlmCallCount` capture the drilldown shape without leaking
 * any raw content. `rawIncluded` flips to true when the request was
 * issued with `?raw=true` (the gated path also emits the dedicated
 * `ChatRunsRawContentViewed` event so the audit trail names the
 * exact action).
 */
export interface AdminObservabilityChatRunsDetailPayload {
  readonly durationMs: number;
  readonly found: boolean;
  readonly stepCount: number;
  readonly linkedLlmCallCount: number;
  readonly rawIncluded: boolean;
}

/**
 * Phase 4 — explicit audit trail for the gated raw-content
 * expander. Logged AND emitted as telemetry whenever an admin
 * issues `?raw=true` on the chat-runs detail endpoint. Payload
 * keeps a closed dimension set: the row id and the step kinds
 * whose raw input was returned. No content. Per the redaction
 * audit, the gated step kinds are `intent` and `entities`, both
 * of which carry the user's raw message in `input_json`.
 */
export interface AdminObservabilityChatRunsRawContentViewedPayload {
  readonly runId: string;
  readonly revealedKinds: readonly ('intent' | 'entities')[];
}

/**
 * Phase 5 — bus outbox list query payload. Same closed dimension set
 * as the other admin viewers (durationMs, rowCount, filterKeys, limit,
 * hasCursor) so dashboards can aggregate by `type` across surfaces.
 * The bus DLQ side keeps its existing legacy shape (no telemetry —
 * the DLQ list ships from `admin-bus.ts` and is unchanged in phase 5).
 */
export interface AdminObservabilityBusOutboxQueryPayload {
  readonly durationMs: number;
  readonly rowCount: number;
  readonly filterKeys: readonly string[];
  readonly limit: number;
  readonly hasCursor: boolean;
}

/**
 * Phase 5 — bus outbox detail fetch payload. `payloadTruncated` /
 * `metadataTruncated` capture the > 200 KB R3 mitigation activity so
 * operators can see how often a large payload tripped the cap — the
 * value itself never appears in telemetry.
 */
export interface AdminObservabilityBusOutboxDetailPayload {
  readonly durationMs: number;
  readonly found: boolean;
  readonly payloadTruncated: boolean;
  readonly metadataTruncated: boolean;
}
