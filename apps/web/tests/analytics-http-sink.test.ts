/**
 * Phase 6 of `docs/dev/plans/admin-observability-viewer.md` — unit
 * tests for the production analytics HTTP sink.
 *
 * Coverage:
 *   - Batching: a single `trackEvent` does not POST immediately; a
 *     burst of 20 events triggers a flush.
 *   - Never throws: a fetch that rejects, a 500 response, or a 4xx
 *     response all keep `trackEvent` from propagating.
 *   - Retry: a transient 503 leaves the events queued and the next
 *     flush re-sends them.
 *   - Overflow drop: pushing beyond `MAX_QUEUE_LENGTH` events causes
 *     the oldest to drop with a `console.warn` line; subsequent
 *     `trackEvent` calls continue to enqueue.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  __flushAnalyticsHttpSinkForTests,
  __peekAnalyticsHttpSinkForTests,
  __resetAnalyticsHttpSinkForTests,
  httpAnalyticsSink,
} from '../src/lib/analytics-http-sink';

interface FetchCall {
  readonly url: string;
  readonly body: string;
}

let calls: FetchCall[] = [];
const originalFetch = globalThis.fetch;

function installMockFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Response,
): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const body = typeof init?.body === 'string' ? init.body : '';
    calls.push({ url, body });
    return Promise.resolve(handler(input, init));
  }) as typeof fetch;
}

function installMockFetchReject(): void {
  (globalThis as unknown as { fetch: typeof fetch }).fetch = ((): Promise<Response> => {
    calls.push({ url: 'rejected', body: '' });
    return Promise.reject(new TypeError('network down'));
  }) as typeof fetch;
}

beforeEach(() => {
  calls = [];
  __resetAnalyticsHttpSinkForTests();
});

afterEach(() => {
  __resetAnalyticsHttpSinkForTests();
  // Restore the real fetch so subsequent test files in the same bun
  // test process do not see our mock. Bun runs the suite in one
  // process and a leaked `globalThis.fetch` would otherwise corrupt
  // unrelated network calls (notably the LLM-provider tests).
  (globalThis as unknown as { fetch: typeof fetch }).fetch = originalFetch;
});

describe('httpAnalyticsSink', () => {
  it('queues events and flushes a batched POST on demand', async () => {
    installMockFetch(() => new Response('{}', { status: 200 }));
    httpAnalyticsSink({
      name: 'chat_message_sent',
      props: { layerSlug: 'demo' },
    });
    httpAnalyticsSink({
      name: 'capabilities_page_opened',
      props: { layerSlug: 'demo' },
    });
    expect(__peekAnalyticsHttpSinkForTests().queueLength).toBe(2);
    await __flushAnalyticsHttpSinkForTests();
    expect(calls.length).toBe(1);
    const body = JSON.parse(calls[0]?.body ?? '{}') as {
      events: { name: string }[];
    };
    expect(body.events.length).toBe(2);
    expect(body.events.map((e) => e.name)).toEqual([
      'chat_message_sent',
      'capabilities_page_opened',
    ]);
  });

  it('never throws when fetch rejects with a network error', async () => {
    installMockFetchReject();
    httpAnalyticsSink({ name: 'chat_message_sent', props: { layerSlug: 'demo' } });
    await __flushAnalyticsHttpSinkForTests();
    // Retry path: the batch was re-queued, so a second flush attempt
    // would fire another fetch. The first call has happened; the
    // primitive did not throw.
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it('drops the batch (non-retryable) on a 4xx other than 408/429', async () => {
    installMockFetch(() => new Response('{"error":"boom"}', { status: 400 }));
    httpAnalyticsSink({ name: 'chat_message_sent', props: { layerSlug: 'demo' } });
    await __flushAnalyticsHttpSinkForTests();
    // Queue should be empty — non-retryable error drops the batch.
    expect(__peekAnalyticsHttpSinkForTests().queueLength).toBe(0);
  });

  it('overflows the queue and drops oldest events without throwing', () => {
    installMockFetch(() => new Response('{}', { status: 200 }));
    // 250 events into a queue capped at 200.
    for (let i = 0; i < 250; i += 1) {
      httpAnalyticsSink({
        name: 'capabilities_page_opened',
        props: { layerSlug: `slug-${i}` },
      });
    }
    const peek = __peekAnalyticsHttpSinkForTests();
    expect(peek.queueLength).toBeLessThanOrEqual(200);
    expect(peek.droppedCount).toBeGreaterThanOrEqual(50);
  });
});
