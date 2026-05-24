/**
 * Phase 5.4 — `bus.*` event taxonomy.
 *
 * Same shape as `scheduled/events.ts`: a closed const-tuple of event
 * type strings plus one typed payload interface per row. The plan
 * §7 last two rows are the source of truth for this file.
 *
 * Why a separate file from the scheduled-tasks taxonomy: the events
 * here describe the durable bus itself (DLQ lifecycle), not the
 * scheduled-tasks domain. Co-locating them in `scheduled/events.ts`
 * would invert the dependency — the scheduled domain depends on the
 * bus, not the other way around.
 *
 * Anti-leak invariants (plan §7):
 *  - `bus.dlq.added` carries `type` (event name) but NOT the full
 *    payload. The payload stays in `bus_outbox.payload_json` and is
 *    only reachable through the admin DLQ route.
 *  - `error` is the clipped string already stored on the
 *    `bus_outbox` row — no stack, no payload echo.
 */

export const BUS_EVENT_TYPES = ['bus.dlq.added', 'bus.dlq.replayed'] as const;

export type BusEventType = (typeof BUS_EVENT_TYPES)[number];

/**
 * Fired AFTER the durable adapter commits a `bus_dlq` row. Emitted
 * from `apps/server/src/index.ts` via the adapter's `onDlqAdded`
 * hook so the publish never races the in-progress transaction.
 */
export interface BusDlqAddedPayload {
  readonly outboxId: string;
  readonly subscriberKey: string;
  /** The event type that landed in the DLQ. NOT the full payload. */
  readonly type: string;
  readonly attempts: number;
  /** Clipped handler error message; same value stored on the row. */
  readonly error: string;
}

/**
 * Fired when the admin replays a DLQ row via
 * `POST /admin/bus/dlq/:outboxId/replay`. The `replayedBy` is the
 * acting admin's user id; the consumer loop will pick the row up on
 * the next pump.
 */
export interface BusDlqReplayedPayload {
  readonly outboxId: string;
  readonly subscriberKey: string;
  readonly replayedBy: string;
}
