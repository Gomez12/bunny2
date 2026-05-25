import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { HonoVariables } from '../types';
import {
  ANALYTICS_SINK_EVENT_TYPES,
  type AnalyticsEventsRejectedReason,
} from '../../observability/events';
import { allowedPropsFor, isKnownAnalyticsEventName } from '../../analytics/catalogue';
import { hashUserId } from '../../analytics/hash';

/**
 * Phase 6 of `docs/dev/plans/admin-observability-viewer.md` —
 * `POST /analytics/events` ingest endpoint.
 *
 * Behaviour (ADR `docs/dev/decisions/0031-analytics-local-sink.md`
 * D2 + redaction audit finding 2):
 *   - Gated by `requireAuth` (the default for non-public paths). NOT
 *     `requireAdmin` — every signed-in user's browser posts here.
 *     Mitigates R1 (abuse target) via session gate + body cap +
 *     closed catalogue validation.
 *   - Body cap: 32 KB per request. Rejects oversize early before
 *     `JSON.parse` so a hostile payload cannot pin CPU on the parse.
 *   - Accepts a single event or a batch (`{ events: [...] }`); the
 *     web sink batches up to 20 events per call so a batch shape
 *     reduces request count.
 *   - For every event: rejects unknown `name` (D2) and rejects any
 *     `props` key not in the catalogue's `allowedProps` list
 *     (redaction-audit finding 2 — properties_json is bounded by the
 *     catalogue, never sanitised by trimming).
 *   - `user_id` (from the authenticated session) is hashed via
 *     {@link hashUserId} BEFORE insert. The raw id never lands on
 *     disk for this surface (D3).
 *   - On a rejected event, logs `analytics.events.rejected` with the
 *     event name + reason only (never the payload). On a successful
 *     write, emits `analytics.events.ingested` telemetry with the
 *     event name dimension only.
 *
 * Response shape:
 *   `{ ingested: number, rejected: { eventName, reason }[] }`
 * Whole-request rejections (oversize, malformed envelope) return a
 * 4xx with the standard `{ error: 'errors.…' }` envelope.
 */

const MAX_BODY_BYTES = 32 * 1024;
const MAX_EVENTS_PER_REQUEST = 50;

/** Per-event allowed primitive types. Property values must be one of these. */
type AllowedPropertyValue = string | number | boolean | null;

export interface AnalyticsRouteDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  /** Override for tests (id generator). */
  readonly idFactory?: () => string;
  /** Override the clock; defaults to `Date.now`. */
  readonly now?: () => number;
}

interface InsertParams {
  readonly id: string;
  readonly occurredAt: string;
  readonly eventName: string;
  readonly layerSlug: string | null;
  readonly userIdHash: string | null;
  readonly propertiesJson: string;
  readonly ingestedAt: string;
}

export function registerAnalyticsRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AnalyticsRouteDeps,
): void {
  const idFactory = deps.idFactory ?? ((): string => crypto.randomUUID());
  const now = deps.now ?? ((): number => Date.now());

  // Prepared once so the per-event hot path stays cheap.
  const insertStmt = deps.db.query<
    unknown,
    [string, string, string, string | null, string | null, string, string]
  >(
    `INSERT INTO analytics_events
       (id, occurred_at, event_name, layer_slug, user_id_hash,
        properties_json, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  app.post('/analytics/events', async (c) => {
    // Body-size cap first. We read content-length up front; if absent
    // (chunked) we fall through to text() which is itself bounded by
    // Hono's incoming-body handling. We then count UTF-8 bytes.
    const contentLengthHeader = c.req.header('content-length');
    if (contentLengthHeader !== undefined) {
      const declared = Number(contentLengthHeader);
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        emitRejection(deps, null, 'payload_too_large');
        return c.json({ error: 'errors.analytics.payloadTooLarge' }, 413);
      }
    }

    let raw: string;
    try {
      raw = await c.req.text();
    } catch {
      emitRejection(deps, null, 'invalid_envelope');
      return c.json({ error: 'errors.analytics.invalidEnvelope' }, 400);
    }
    if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
      emitRejection(deps, null, 'payload_too_large');
      return c.json({ error: 'errors.analytics.payloadTooLarge' }, 413);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      emitRejection(deps, null, 'invalid_envelope');
      return c.json({ error: 'errors.analytics.invalidEnvelope' }, 400);
    }

    const events = pickEvents(parsed);
    if (events === null) {
      emitRejection(deps, null, 'invalid_envelope');
      return c.json({ error: 'errors.analytics.invalidEnvelope' }, 400);
    }
    if (events.length === 0) {
      // An empty batch is a no-op rather than an error — the sink
      // may flush at a heartbeat with zero events queued.
      return c.json({ ingested: 0, rejected: [] });
    }
    if (events.length > MAX_EVENTS_PER_REQUEST) {
      emitRejection(deps, null, 'payload_too_large');
      return c.json({ error: 'errors.analytics.payloadTooLarge' }, 413);
    }

    // Authenticated user — `requireAuth` middleware put this on the
    // context. If for some reason the session resolver returned
    // without a user (unreachable on a non-public route), we leave
    // the hash null rather than crash.
    const user = c.get('user');
    const userIdHash = user !== undefined ? hashUserId(user.id) : null;

    const ingestedAtIso = new Date(now()).toISOString();
    const rejected: Array<{ readonly eventName: string | null; readonly reason: string }> = [];
    let ingested = 0;

    for (const candidate of events) {
      const verdict = validateEvent(candidate);
      if (verdict.kind === 'reject') {
        emitRejection(deps, verdict.eventName, verdict.reason);
        rejected.push({ eventName: verdict.eventName, reason: verdict.reason });
        continue;
      }
      const params: InsertParams = {
        id: idFactory(),
        occurredAt: verdict.occurredAt,
        eventName: verdict.eventName,
        layerSlug: verdict.layerSlug,
        userIdHash,
        propertiesJson: JSON.stringify(verdict.props),
        ingestedAt: ingestedAtIso,
      };
      insertStmt.run(
        params.id,
        params.occurredAt,
        params.eventName,
        params.layerSlug,
        params.userIdHash,
        params.propertiesJson,
        params.ingestedAt,
      );
      ingested += 1;

      // Telemetry — closed-cardinality `eventName` dimension only.
      // Fire-and-forget so the ingest write path stays non-blocking;
      // matches the rejection-path convention in `emitRejection`.
      void deps.bus
        .publish({
          type: ANALYTICS_SINK_EVENT_TYPES.Ingested,
          payload: { eventName: verdict.eventName },
        })
        .catch(() => {
          // Telemetry must never break a write. Swallow.
        });
    }

    // Status code policy (ADR 0031 D2 — "rejects unknown event names
    // with 400"): a request whose EVERY event was rejected returns
    // 400 so the web sink's `non-retryable` branch logs the failure.
    // Mixed batches (some ingested + some rejected) return 200 with
    // per-event verdicts so the sink keeps the rejected names without
    // re-sending the ingested half.
    if (ingested === 0 && rejected.length > 0) {
      return c.json({ ingested, rejected }, 400);
    }
    return c.json({ ingested, rejected });
  });
}

interface ValidatedEvent {
  readonly kind: 'ok';
  readonly eventName: string;
  readonly occurredAt: string;
  readonly layerSlug: string | null;
  readonly props: Record<string, AllowedPropertyValue>;
}

interface RejectedEvent {
  readonly kind: 'reject';
  readonly eventName: string | null;
  readonly reason: AnalyticsEventsRejectedReason;
}

/**
 * Extracts an array of event candidates from a parsed envelope. The
 * sink can post either a bare object or `{ events: [...] }`.
 * Returns null when the envelope shape is unrecoverable.
 */
function pickEvents(parsed: unknown): unknown[] | null {
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as { events?: unknown };
  if (Array.isArray(obj.events)) return obj.events;
  // Single-event shape: `{ name, props?, occurredAt?, layerSlug? }`.
  if (typeof (parsed as { name?: unknown }).name === 'string') {
    return [parsed];
  }
  return null;
}

/**
 * Validates one event candidate against the catalogue. Reject with
 * a stable error reason on any deviation — privacy rules in
 * `docs/dev/observability/analytics.md §Privacy` say "every property
 * is a stable identifier, a closed enum, or a bucketed numeric", so
 * we typecheck values to those primitives even when the key is
 * known (defence against a hostile client posting an object value
 * whose nested keys would defeat the catalogue check).
 */
function validateEvent(candidate: unknown): ValidatedEvent | RejectedEvent {
  if (candidate === null || typeof candidate !== 'object') {
    return { kind: 'reject', eventName: null, reason: 'invalid_envelope' };
  }
  const raw = candidate as {
    name?: unknown;
    props?: unknown;
    occurredAt?: unknown;
    layerSlug?: unknown;
  };
  if (typeof raw.name !== 'string' || raw.name.length === 0) {
    return { kind: 'reject', eventName: null, reason: 'invalid_envelope' };
  }
  const name = raw.name;
  if (!isKnownAnalyticsEventName(name)) {
    return { kind: 'reject', eventName: name, reason: 'unknown_name' };
  }

  // `occurredAt` is optional — the sink usually omits it and we
  // stamp at ingest time. When supplied, validate it.
  let occurredAt: string;
  if (raw.occurredAt === undefined || raw.occurredAt === null) {
    occurredAt = new Date().toISOString();
  } else if (typeof raw.occurredAt === 'string') {
    const d = new Date(raw.occurredAt);
    if (Number.isNaN(d.getTime())) {
      return { kind: 'reject', eventName: name, reason: 'invalid_envelope' };
    }
    occurredAt = d.toISOString();
  } else {
    return { kind: 'reject', eventName: name, reason: 'invalid_envelope' };
  }

  // `layerSlug` is convenience: when a top-level layerSlug is on the
  // envelope it lands on the column. We also pull it out of `props`
  // because every catalogue entry that documents a `layerSlug`
  // surfaces it there.
  let layerSlugFromEnvelope: string | null = null;
  if (raw.layerSlug !== undefined && raw.layerSlug !== null) {
    if (typeof raw.layerSlug !== 'string' || raw.layerSlug.length === 0) {
      return { kind: 'reject', eventName: name, reason: 'invalid_envelope' };
    }
    layerSlugFromEnvelope = raw.layerSlug;
  }

  const allowed = allowedPropsFor(name);
  if (allowed === null) {
    // Belt-and-braces — `isKnownAnalyticsEventName` already passed.
    return { kind: 'reject', eventName: name, reason: 'unknown_name' };
  }
  const allowedSet = new Set(allowed);

  const propsRaw = raw.props === undefined ? {} : raw.props;
  if (propsRaw === null || typeof propsRaw !== 'object' || Array.isArray(propsRaw)) {
    return { kind: 'reject', eventName: name, reason: 'invalid_envelope' };
  }
  const props: Record<string, AllowedPropertyValue> = {};
  for (const [key, value] of Object.entries(propsRaw as Record<string, unknown>)) {
    if (!allowedSet.has(key)) {
      return { kind: 'reject', eventName: name, reason: 'unknown_property' };
    }
    // Closed primitive shape — see the function header. Nested
    // objects / arrays / functions are rejected by construction.
    if (
      value !== null &&
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return { kind: 'reject', eventName: name, reason: 'invalid_property_value' };
    }
    props[key] = value;
  }

  const layerSlug = typeof props.layerSlug === 'string' ? props.layerSlug : layerSlugFromEnvelope;

  return {
    kind: 'ok',
    eventName: name,
    occurredAt,
    layerSlug,
    props,
  };
}

function emitRejection(
  deps: AnalyticsRouteDeps,
  eventName: string | null,
  reason: AnalyticsEventsRejectedReason,
): void {
  console.log('[analytics.events.rejected]', {
    event: 'analytics.events.rejected',
    eventName,
    reason,
  });
  // Bus telemetry — fire-and-forget; never throw on the write path.
  void deps.bus
    .publish({
      type: ANALYTICS_SINK_EVENT_TYPES.Rejected,
      payload: { eventName, reason },
    })
    .catch(() => {
      // Swallow — telemetry must not break an HTTP write.
    });
}
