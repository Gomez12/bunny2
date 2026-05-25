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
 * will append a `ChatRunsQuery` row; phase 6 will append
 * `AnalyticsQuery`. The const-tuple keeps the catalogue closed at
 * compile time so a typo in a producer fails the typecheck.
 */

export const ADMIN_OBSERVABILITY_EVENT_TYPES = {
  EventsQuery: 'admin.observability.events.query',
  LlmCallsQuery: 'admin.observability.llm-calls.query',
  LlmCallsDetail: 'admin.observability.llm-calls.detail',
  LlmCallsRollups: 'admin.observability.llm-calls.rollups',
} as const;

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
