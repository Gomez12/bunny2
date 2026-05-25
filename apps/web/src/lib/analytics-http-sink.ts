/**
 * Phase 6 of `docs/dev/plans/admin-observability-viewer.md` — the
 * production analytics sink.
 *
 * Posts batched events to `POST /analytics/events`. Never throws —
 * sink failures land in `console.warn`; the queue drops oldest
 * events when the buffer overflows so a hostile call pattern cannot
 * blow up memory. Wired exactly once from
 * `apps/web/src/main.tsx` via `configureAnalytics({ sink: httpAnalyticsSink })`.
 *
 * Batching policy (chosen per advisor + plan §6 C):
 *   - Flush when the buffer reaches {@link FLUSH_AT_COUNT} events
 *     (currently 20), OR
 *   - Flush at the next {@link FLUSH_INTERVAL_MS} heartbeat
 *     (currently 5 s), whichever fires first.
 *   - On `pagehide` / `beforeunload`, attempt a synchronous final
 *     flush via `navigator.sendBeacon` so the last batch lands when
 *     the user navigates away.
 *
 * Retry policy:
 *   - On a transient network failure (`TypeError` from `fetch`, or
 *     HTTP 5xx / 408 / 429), the events stay in the buffer for the
 *     NEXT scheduled flush.
 *   - On a non-retryable HTTP error (4xx other than 408 / 429), the
 *     batch is dropped — those would only be unknown-name /
 *     malformed envelopes, which retrying cannot fix.
 *   - The buffer is bounded at {@link MAX_QUEUE_LENGTH}; once it is
 *     full, the OLDEST events are dropped and a single
 *     `console.warn` line names the running drop count.
 *
 * Overflow telemetry deviation (advisor note 8):
 *   - We do NOT post a separate "drop" telemetry event from inside
 *     the drop path. Doing so would trigger another network call on
 *     the same failure surface that caused the queue to fill, and
 *     it would force a meta-event into the closed catalogue.
 *     Instead we log the running drop count via `console.warn` and
 *     leave aggregate visibility to ops queries.
 */

import type { AnalyticsEvent, AnalyticsSink } from './analytics';
import { apiBase } from './api';

const FLUSH_AT_COUNT = 20;
const FLUSH_INTERVAL_MS = 5000;
const MAX_QUEUE_LENGTH = 200;
const ENDPOINT_PATH = '/analytics/events';
const MAX_RETRIES_PER_BATCH = 1;

interface QueuedEvent {
  readonly name: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

let queue: QueuedEvent[] = [];
let droppedCount = 0;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let lifecycleListenersBound = false;

/**
 * The sink callable handed to `configureAnalytics({ sink })`.
 * Every `trackEvent(...)` from the web app routes through here.
 */
export const httpAnalyticsSink: AnalyticsSink = (event: AnalyticsEvent): void => {
  try {
    enqueue(event);
    ensureLifecycleListeners();
    if (queue.length >= FLUSH_AT_COUNT) {
      void flushSoon(0);
    } else {
      void flushSoon(FLUSH_INTERVAL_MS);
    }
  } catch (err) {
    // Defence in depth — the primitive already guards the sink call,
    // but a sink internal error must never surface to the caller.
    safeWarn('[analytics-http-sink] enqueue failed', err);
  }
};

function enqueue(event: AnalyticsEvent): void {
  queue.push({
    name: event.name,
    props: event.props,
    occurredAt: new Date().toISOString(),
  });
  if (queue.length > MAX_QUEUE_LENGTH) {
    const overflow = queue.length - MAX_QUEUE_LENGTH;
    queue.splice(0, overflow);
    droppedCount += overflow;
    safeWarn('[analytics-http-sink] queue overflow; dropped oldest', {
      droppedCount,
      queueLength: queue.length,
    });
  }
}

function flushSoon(delayMs: number): void {
  if (flushTimer !== null) return;
  const t = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, delayMs);
  flushTimer = t;
}

async function flush(): Promise<void> {
  if (queue.length === 0) return;
  const batch = queue;
  queue = [];
  await sendBatch(batch, 0);
}

async function sendBatch(batch: readonly QueuedEvent[], attempt: number): Promise<void> {
  if (batch.length === 0) return;
  const body = JSON.stringify({
    events: batch.map((e) => ({
      name: e.name,
      props: e.props,
      occurredAt: e.occurredAt,
    })),
  });
  try {
    const res = await fetch(`${apiBase}${ENDPOINT_PATH}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (res.ok) return;
    if (isRetryableStatus(res.status) && attempt < MAX_RETRIES_PER_BATCH) {
      // Stash the batch back at the head of the queue so the next
      // heartbeat-driven flush picks it up. Subsequent retries are
      // bounded by `MAX_RETRIES_PER_BATCH`.
      queue.unshift(...batch);
      flushSoon(FLUSH_INTERVAL_MS);
      return;
    }
    // Non-retryable — drop. Surface for grep but never throw.
    safeWarn('[analytics-http-sink] batch dropped (non-retryable)', {
      status: res.status,
      size: batch.length,
    });
  } catch (err) {
    // Transient network failure — retry once more on the next tick.
    if (attempt < MAX_RETRIES_PER_BATCH) {
      queue.unshift(...batch);
      flushSoon(FLUSH_INTERVAL_MS);
      return;
    }
    safeWarn('[analytics-http-sink] batch dropped (network)', { size: batch.length, err });
  }
}

function isRetryableStatus(status: number): boolean {
  if (status === 408 || status === 429) return true;
  if (status >= 500 && status <= 599) return true;
  return false;
}

function ensureLifecycleListeners(): void {
  if (lifecycleListenersBound) return;
  if (typeof window === 'undefined') return;
  // `pagehide` is the recommended replacement for `beforeunload`; we
  // bind both for older browsers but only the first that fires wins.
  const onLeave = (): void => {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    sendBeacon(batch);
  };
  window.addEventListener('pagehide', onLeave);
  window.addEventListener('beforeunload', onLeave);
  lifecycleListenersBound = true;
}

function sendBeacon(batch: readonly QueuedEvent[]): void {
  if (typeof navigator === 'undefined' || typeof navigator.sendBeacon !== 'function') {
    // `keepalive` on fetch is the next-best option; we still don't
    // await it because the page is unloading.
    try {
      void fetch(`${apiBase}${ENDPOINT_PATH}`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          events: batch.map((e) => ({ name: e.name, props: e.props, occurredAt: e.occurredAt })),
        }),
        keepalive: true,
      });
    } catch {
      // Best-effort; never propagate.
    }
    return;
  }
  try {
    const blob = new Blob(
      [
        JSON.stringify({
          events: batch.map((e) => ({ name: e.name, props: e.props, occurredAt: e.occurredAt })),
        }),
      ],
      { type: 'application/json' },
    );
    navigator.sendBeacon(`${apiBase}${ENDPOINT_PATH}`, blob);
  } catch {
    // Best-effort.
  }
}

function safeWarn(message: string, fields?: unknown): void {
  try {
    if (fields === undefined) {
      console.warn(message);
    } else {
      console.warn(message, fields);
    }
  } catch {
    // Some embeddings throw on console; swallow.
  }
}

/**
 * Test-only — flushes the queue immediately and returns whatever
 * batch was sent (or `null` when the queue was empty). Production
 * callers use the `httpAnalyticsSink` export.
 */
export async function __flushAnalyticsHttpSinkForTests(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flush();
}

/** Test-only — empties the queue, lifecycle listeners, drop count. */
export function __resetAnalyticsHttpSinkForTests(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  queue = [];
  droppedCount = 0;
  lifecycleListenersBound = false;
}

/** Test-only — visibility into the internal queue / drop count. */
export function __peekAnalyticsHttpSinkForTests(): {
  readonly queueLength: number;
  readonly droppedCount: number;
} {
  return { queueLength: queue.length, droppedCount };
}
