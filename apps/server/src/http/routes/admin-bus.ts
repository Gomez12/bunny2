import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { BusDlqReplayedPayload } from '../../bus/events';
import type { HonoVariables } from '../types';

/**
 * Phase 5.4 — `/admin/bus/*` admin DLQ surface.
 *
 * Sits behind the `/admin/*` `requireAdmin` gate. Two routes:
 *
 *  - `GET  /admin/bus/dlq`                — paginated list (latest
 *    failures first). The list joins `bus_dlq` with `bus_outbox` so
 *    the admin sees the event type + a clipped payload preview
 *    without needing to know the underlying schema. Full payloads
 *    are NOT exposed in this list — plan §7 last paragraph keeps
 *    payload behind the row id only.
 *  - `POST /admin/bus/dlq/:outboxId/replay` — flips the outbox row
 *    back to `pending` via the durable bus's `replayDlq` and
 *    publishes `bus.dlq.replayed`.
 *
 * Tests that wire an in-memory bus pass `replayDlq: undefined`; the
 * route 503s with `errors.bus.dlqReplayFailed` instead of crashing.
 * Production wiring in `apps/server/src/index.ts` always passes the
 * durable adapter's `replayDlq` method.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const PAYLOAD_PREVIEW_MAX = 500;

const NOT_FOUND = { error: 'errors.bus.dlqReplayFailed' } as const;
const UNAVAILABLE = { error: 'errors.bus.dlqReplayFailed' } as const;

interface DlqRow {
  readonly id: string;
  readonly outbox_id: string;
  readonly subscriber_key: string;
  readonly error: string;
  readonly attempts: number;
  readonly failed_at: string;
  readonly type: string | null;
  readonly payload_json: string | null;
}

interface DlqSummary {
  readonly id: string;
  readonly outboxId: string;
  readonly subscriberKey: string;
  readonly eventType: string;
  readonly payloadPreview: string;
  readonly attempts: number;
  readonly error: string;
  readonly failedAt: string;
}

export interface AdminBusRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  /**
   * Hook to the durable adapter's DLQ-replay surface. Optional so
   * tests that wire an in-memory bus can skip it; the replay route
   * 503s when this is undefined.
   */
  readonly replayDlq?: (outboxId: string) => boolean;
}

export function registerAdminBusRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AdminBusRouteDeps,
): void {
  // ---------- GET /admin/bus/dlq -----------------------------------------

  app.get('/admin/bus/dlq', (c) => {
    const limit = parseLimit(c.req.query('limit'));
    const rows = deps.db
      .query<DlqRow, [number]>(
        `SELECT d.id, d.outbox_id, d.subscriber_key, d.error, d.attempts, d.failed_at,
                o.type, o.payload_json
           FROM bus_dlq d
           LEFT JOIN bus_outbox o ON o.id = d.outbox_id
          ORDER BY d.failed_at DESC
          LIMIT ?`,
      )
      .all(limit);
    const items: DlqSummary[] = rows.map(toSummary);
    return c.json({ items });
  });

  // ---------- POST /admin/bus/dlq/:outboxId/replay -----------------------

  app.post('/admin/bus/dlq/:outboxId/replay', async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const outboxId = c.req.param('outboxId');

    if (deps.replayDlq === undefined) {
      return c.json(UNAVAILABLE, 503);
    }

    // Look up the dead row so we can echo `subscriberKey` on the
    // emitted event AND so we can return a clean 404 even when the
    // durable adapter happened to return `false` for some other
    // reason (race with a re-publish, etc.).
    const dead = deps.db
      .query<{ subscriber_key: string }, [string]>(
        `SELECT d.subscriber_key
           FROM bus_dlq d
          WHERE d.outbox_id = ?
          ORDER BY d.failed_at DESC
          LIMIT 1`,
      )
      .get(outboxId);
    if (dead === null) {
      return c.json(NOT_FOUND, 404);
    }

    const ok = deps.replayDlq(outboxId);
    if (!ok) {
      // The row is in the DLQ history but the outbox row is no longer
      // in `dead` status (e.g. someone already replayed it). Surface
      // the same 404 so the admin retries cleanly.
      return c.json(NOT_FOUND, 404);
    }

    const payload: BusDlqReplayedPayload = {
      outboxId,
      subscriberKey: dead.subscriber_key,
      replayedBy: user.id,
    };
    await deps.bus.publish({ type: 'bus.dlq.replayed', payload, correlationId });
    return c.json({ ok: true });
  });
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(Math.floor(n), MAX_LIMIT);
}

function clipPreview(raw: string | null): string {
  if (raw === null) return '';
  if (raw.length <= PAYLOAD_PREVIEW_MAX) return raw;
  return `${raw.slice(0, PAYLOAD_PREVIEW_MAX)}…`;
}

function toSummary(row: DlqRow): DlqSummary {
  return {
    id: row.id,
    outboxId: row.outbox_id,
    subscriberKey: row.subscriber_key,
    eventType: row.type ?? '',
    payloadPreview: clipPreview(row.payload_json),
    attempts: row.attempts,
    error: row.error,
    failedAt: row.failed_at,
  };
}
