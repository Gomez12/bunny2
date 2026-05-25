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
 * Phase 2 ships only `EventsQuery`. Phases 3 and 4 will append
 * `LlmCallsQuery` and `ChatRunsQuery` rows; phase 6 will append
 * `AnalyticsQuery`. The const-tuple keeps the catalogue closed at
 * compile time so a typo in a producer fails the typecheck.
 */

export const ADMIN_OBSERVABILITY_EVENT_TYPES = {
  EventsQuery: 'admin.observability.events.query',
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
