/**
 * Phase 6 of `docs/dev/plans/admin-observability-viewer.md` — the
 * closed catalogue of analytics event names + property keys.
 *
 * Source of truth for the ingest validator:
 *   - `POST /analytics/events` rejects an event name that is not a
 *     key of {@link ANALYTICS_EVENT_CATALOGUE}.
 *   - For a known name, the endpoint rejects a property key that is
 *     not listed in that entry's `allowedProps`.
 *
 * Per ADR 0031 D2 ("ingest rejects unknown event names") + the
 * redaction-audit finding 2 ("`analytics_events.properties_json`
 * must be catalogue-bounded"), this file is the single point that
 * enforces the privacy contract documented in
 * `docs/dev/observability/analytics.md §Privacy`.
 *
 * Adding a new analytics event
 * ----------------------------
 *   1. Add the corresponding row in `analytics.md` (the
 *      product/UX-facing catalogue).
 *   2. Add an entry here with the same property keys.
 *   3. Add the `trackEvent('…', { … })` call site in `apps/web`.
 *   4. If the production sink is already wired, the new event lands
 *      in `analytics_events` automatically.
 */

export interface AnalyticsEventSchema {
  /**
   * Closed set of property keys the ingest endpoint accepts for this
   * event name. Empty array = the event has no documented properties
   * (some events ship name-only).
   */
  readonly allowedProps: readonly string[];
}

/**
 * Closed event catalogue. Mirrors the per-domain tables in
 * `docs/dev/observability/analytics.md`. Property keys are sorted
 * alphabetically per entry purely for readability.
 *
 * The `as const satisfies …` shape keeps `keyof` narrow at the
 * type-system level so a typo in a producer fails the typecheck.
 */
export const ANALYTICS_EVENT_CATALOGUE = {
  // ---- Chat ----------------------------------------------------------
  chat_conversation_started: { allowedProps: ['layerSlug'] },
  chat_conversation_title_regenerated: { allowedProps: ['layerSlug'] },
  chat_message_sent: {
    allowedProps: ['conversationId', 'layerSlug', 'lengthBucket'],
  },
  chat_message_trace_inspected: { allowedProps: ['layerSlug'] },
  chat_stream_aborted: { allowedProps: ['conversationId', 'layerSlug'] },
  chat_feedback_submitted: { allowedProps: ['value'] },
  // ---- Proposals ----------------------------------------------------
  proposals_page_opened: { allowedProps: ['layerSlug'] },
  proposal_detail_opened: { allowedProps: ['layerSlug', 'proposalId'] },
  proposal_approved: {
    allowedProps: ['layerSlug', 'outcome', 'proposalId'],
  },
  proposal_sandbox_replayed: {
    allowedProps: ['layerSlug', 'outcome', 'proposalId'],
  },
  proposal_rejected: { allowedProps: ['layerSlug', 'proposalId'] },
  proposal_rolled_back: { allowedProps: ['layerSlug', 'proposalId'] },
  // ---- Capabilities --------------------------------------------------
  capabilities_page_opened: { allowedProps: ['layerSlug'] },
  capability_deactivated: { allowedProps: ['capabilityId', 'layerSlug'] },
  // ---- Entities ------------------------------------------------------
  entity_restored: { allowedProps: ['kind', 'layerSlug'] },
  entity_external_link_added: { allowedProps: ['kind', 'layerSlug'] },
  entity_external_link_removed: { allowedProps: ['kind', 'layerSlug'] },
  // ---- Layers --------------------------------------------------------
  layer_member_removed: { allowedProps: ['kind', 'layerSlug'] },
} as const satisfies Record<string, AnalyticsEventSchema>;

export type AnalyticsEventName = keyof typeof ANALYTICS_EVENT_CATALOGUE;

/** Set form for fast O(1) lookup at ingest time. */
const KNOWN_NAMES: ReadonlySet<string> = new Set(Object.keys(ANALYTICS_EVENT_CATALOGUE));

/** True when `name` is a known analytics event. */
export function isKnownAnalyticsEventName(name: string): name is AnalyticsEventName {
  return KNOWN_NAMES.has(name);
}

/**
 * Returns the closed property set for `name`, or `null` when `name`
 * is not in the catalogue.
 */
export function allowedPropsFor(name: string): readonly string[] | null {
  if (!isKnownAnalyticsEventName(name)) return null;
  return ANALYTICS_EVENT_CATALOGUE[name].allowedProps;
}

/** Exported for the admin viewer's drift-detection panel. */
export function listCatalogueEntries(): ReadonlyArray<{
  readonly name: AnalyticsEventName;
  readonly allowedProps: readonly string[];
}> {
  return Object.entries(ANALYTICS_EVENT_CATALOGUE).map(([name, schema]) => ({
    name: name as AnalyticsEventName,
    allowedProps: schema.allowedProps,
  }));
}
