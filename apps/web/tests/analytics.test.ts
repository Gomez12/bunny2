/**
 * Unit tests for the `trackEvent` analytics primitive.
 *
 * The module is intentionally tiny — no DOM, no React, no
 * environment-specific behaviour besides the dev opt-in console
 * mirror. We exercise the public surface (`trackEvent`,
 * `configureAnalytics`, `__resetAnalyticsForTests`) and the
 * `localStorage`-gated dev branch through small shims, mirroring the
 * shape used by `theme.test.ts`.
 *
 * Closes `docs/dev/follow-ups/web-analytics-primitive.md`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  __resetAnalyticsForTests,
  configureAnalytics,
  DEBUG_FLAG_KEY,
  trackEvent,
  type AnalyticsEvent,
} from '../src/lib/analytics';

// --- localStorage shim (copied shape from theme.test.ts) -----------------

function installFakeStorage(): Storage {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
  return storage;
}

function uninstallFakeStorage(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

/**
 * Patch `import.meta.env.DEV` to `true` for the duration of one test.
 * Bun lets us mutate `import.meta.env` (it's a plain object); the
 * primitive reads it lazily, so the patch only needs to outlive the
 * `trackEvent` call.
 */
function patchDevTrue(): () => void {
  const env = import.meta.env as Record<string, unknown>;
  const prev = env.DEV;
  env.DEV = true;
  return (): void => {
    if (prev === undefined) delete env.DEV;
    else env.DEV = prev;
  };
}

/**
 * Stand-in for `console.log`, used by the dev-flag mirror test. We
 * restore the original in `afterEach` so other tests aren't affected.
 */
function patchConsoleLog(): { calls: Array<readonly unknown[]>; restore: () => void } {
  const original = console.log;
  const calls: Array<readonly unknown[]> = [];
  console.log = (...args: unknown[]): void => {
    calls.push(args);
  };
  return {
    calls,
    restore: (): void => {
      console.log = original;
    },
  };
}

// --- specs ----------------------------------------------------------------

describe('trackEvent (no sink configured)', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
  });
  afterEach(() => {
    __resetAnalyticsForTests();
  });

  it('is a no-op when no sink is configured', () => {
    expect(() => {
      trackEvent('chat_message_sent', { layerSlug: 'demo' });
    }).not.toThrow();
  });

  it('does not throw when called with no props at all', () => {
    expect(() => {
      trackEvent('proposals_page_opened');
    }).not.toThrow();
  });
});

describe('trackEvent (sink configured)', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
  });
  afterEach(() => {
    __resetAnalyticsForTests();
  });

  it('invokes the sink exactly once per call', () => {
    const events: AnalyticsEvent[] = [];
    configureAnalytics({ sink: (e) => events.push(e) });

    trackEvent('chat_message_sent', { layerSlug: 'demo', lengthBucket: 's' });

    expect(events).toHaveLength(1);
    expect(events[0]?.name).toBe('chat_message_sent');
    expect(events[0]?.props).toEqual({ layerSlug: 'demo', lengthBucket: 's' });
  });

  it('passes through every distinct call', () => {
    const events: AnalyticsEvent[] = [];
    configureAnalytics({ sink: (e) => events.push(e) });

    trackEvent('proposals_page_opened', { layerSlug: 'a' });
    trackEvent('proposal_approved', { layerSlug: 'a', proposalId: 'p1', outcome: 'activated' });
    trackEvent('capability_deactivated', { layerSlug: 'a', capabilityId: 'c1' });

    expect(events.map((e) => e.name)).toEqual([
      'proposals_page_opened',
      'proposal_approved',
      'capability_deactivated',
    ]);
  });

  it('never throws when the sink itself throws', () => {
    configureAnalytics({
      sink: () => {
        throw new Error('boom');
      },
    });
    expect(() => trackEvent('chat_message_sent', { layerSlug: 'demo' })).not.toThrow();
  });

  it('freezes the event so a malicious sink cannot mutate it after the fact', () => {
    let captured: AnalyticsEvent | null = null;
    configureAnalytics({ sink: (e) => (captured = e) });

    trackEvent('chat_feedback_submitted', { value: 'up' });

    expect(captured).not.toBeNull();
    // Asserting Object.isFrozen on the event AND its props matches the
    // primitive's documented "frozen for safety" guarantee.
    expect(Object.isFrozen(captured)).toBe(true);
    expect(Object.isFrozen((captured as unknown as AnalyticsEvent).props)).toBe(true);
  });
});

describe('configureAnalytics', () => {
  beforeEach(() => {
    __resetAnalyticsForTests();
  });
  afterEach(() => {
    __resetAnalyticsForTests();
  });

  it('clears the active sink when called with no opts', () => {
    const events: AnalyticsEvent[] = [];
    configureAnalytics({ sink: (e) => events.push(e) });
    configureAnalytics();
    trackEvent('chat_message_sent', { layerSlug: 'demo' });
    expect(events).toHaveLength(0);
  });

  it('clears the active sink when called with { sink: undefined }', () => {
    const events: AnalyticsEvent[] = [];
    configureAnalytics({ sink: (e) => events.push(e) });
    configureAnalytics({ sink: undefined });
    trackEvent('chat_message_sent', { layerSlug: 'demo' });
    expect(events).toHaveLength(0);
  });

  it('replaces an existing sink rather than chaining', () => {
    const a: AnalyticsEvent[] = [];
    const b: AnalyticsEvent[] = [];
    configureAnalytics({ sink: (e) => a.push(e) });
    configureAnalytics({ sink: (e) => b.push(e) });
    trackEvent('proposals_page_opened', { layerSlug: 'demo' });
    expect(a).toHaveLength(0);
    expect(b).toHaveLength(1);
  });
});

describe('dev debug flag', () => {
  let logSpy: { calls: Array<readonly unknown[]>; restore: () => void };
  let restoreDev: () => void;

  beforeEach(() => {
    __resetAnalyticsForTests();
    installFakeStorage();
    logSpy = patchConsoleLog();
    restoreDev = patchDevTrue();
  });
  afterEach(() => {
    restoreDev();
    logSpy.restore();
    uninstallFakeStorage();
    __resetAnalyticsForTests();
  });

  it('does not write to console when the flag is absent', () => {
    trackEvent('chat_message_sent', { layerSlug: 'demo' });
    expect(logSpy.calls).toHaveLength(0);
  });

  it('writes exactly one console line per call when the flag is "1"', () => {
    localStorage.setItem(DEBUG_FLAG_KEY, '1');
    trackEvent('chat_message_sent', { layerSlug: 'demo' });
    expect(logSpy.calls).toHaveLength(1);
    expect(logSpy.calls[0]?.[0]).toBe('[analytics]');
    expect(logSpy.calls[0]?.[1]).toBe('chat_message_sent');
  });

  it('still mirrors to the console when a sink is also configured', () => {
    localStorage.setItem(DEBUG_FLAG_KEY, '1');
    const events: AnalyticsEvent[] = [];
    configureAnalytics({ sink: (e) => events.push(e) });
    trackEvent('proposal_approved', { layerSlug: 'demo', proposalId: 'p1', outcome: 'activated' });
    expect(logSpy.calls).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('does not write to console when the flag is set to a non-"1" value', () => {
    localStorage.setItem(DEBUG_FLAG_KEY, 'true');
    trackEvent('chat_message_sent', { layerSlug: 'demo' });
    expect(logSpy.calls).toHaveLength(0);
  });
});

describe('dev debug flag (DEV=false)', () => {
  let logSpy: { calls: Array<readonly unknown[]>; restore: () => void };

  beforeEach(() => {
    __resetAnalyticsForTests();
    installFakeStorage();
    logSpy = patchConsoleLog();
    // DEV is undefined / false in `bun test` by default. We do not
    // patch it here — that's the point.
  });
  afterEach(() => {
    logSpy.restore();
    uninstallFakeStorage();
    __resetAnalyticsForTests();
  });

  it('does not write to console even when the flag is "1" if DEV is not true', () => {
    localStorage.setItem(DEBUG_FLAG_KEY, '1');
    trackEvent('chat_message_sent', { layerSlug: 'demo' });
    expect(logSpy.calls).toHaveLength(0);
  });
});
