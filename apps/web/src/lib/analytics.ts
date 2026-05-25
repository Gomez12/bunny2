/**
 * Web analytics primitive — `trackEvent(name, props)`.
 *
 * Closes `docs/dev/follow-ups/web-analytics-primitive.md`.
 *
 * Background
 * ----------
 * Phase 6.5 sprinkled analytics call sites through the web app
 * (chat composer, feedback buttons, proposals list/detail,
 * capabilities) as `[chat.analytics]` console-log placeholders.
 * The actual sink (PostHog vs Plausible vs a server-side
 * `analytics_events` table) is a product decision that is not made
 * here. This module ships the primitive so call sites are stable and
 * uniform; wiring a real sink is a one-line change at app start.
 *
 * Default behavior
 * ----------------
 * `trackEvent` is a no-op when no sink is configured. This is
 * deliberate — we'd rather drop events silently than ship a partial
 * pipeline that pretends to record but doesn't. Production never
 * crashes because analytics is mis-wired.
 *
 * Dev opt-in
 * ----------
 * Local development can still surface events by setting
 * `localStorage['bunny2.debug.analytics'] = '1'` in the browser
 * console. When the flag is `'1'` and `import.meta.env.DEV` is true,
 * each event additionally emits a single `console.log('[analytics] …')`
 * line. The flag is read at each `trackEvent` call (no reload needed)
 * and is independent of the configured sink — both can coexist.
 *
 * Privacy
 * -------
 * Per `AGENTS.md §Analytics` and `§Privacy and Data Protection`:
 *   - Event names must be stable. The current catalogue lives in
 *     `docs/dev/observability/analytics.md`.
 *   - Properties must not contain raw user input, secrets, or PII.
 *     The audited call sites pass only stable IDs (`layerSlug`,
 *     `proposalId`, `capabilityId`), closed enums (`outcome`,
 *     thumbs `value`), and bucketed numerics (`lengthBucket`).
 *
 * Wiring a real sink later
 * ------------------------
 * Once the destination is chosen, call `configureAnalytics({ sink })`
 * exactly once during bootstrap (e.g. from `apps/web/src/main.tsx`
 * after `i18n` is ready). Replacements are idempotent; pass
 * `undefined` or omit the field to clear.
 *
 * See `docs/dev/observability/analytics.md` for the event catalogue
 * and `AGENTS.md §Analytics` for the project-wide rules.
 */

/**
 * The shape every sink receives. Keep this stable — third-party
 * adapters depend on it.
 */
export interface AnalyticsEvent {
  readonly name: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/** A sink consumes events. Sinks must not throw; we still guard. */
export type AnalyticsSink = (event: AnalyticsEvent) => void;

/** localStorage flag opting into the dev `console.log` mirror. */
export const DEBUG_FLAG_KEY = 'bunny2.debug.analytics';
const DEBUG_FLAG_VALUE = '1';

let currentSink: AnalyticsSink | null = null;

/**
 * Replace the active sink. Idempotent. Passing `undefined` (or
 * `{ sink: undefined }`) clears the sink and restores no-op
 * behaviour. Production wiring should call this exactly once at app
 * bootstrap.
 */
export function configureAnalytics(opts?: { sink?: AnalyticsSink }): void {
  currentSink = opts?.sink ?? null;
}

/**
 * Record a product / user-flow event.
 *
 * - No-op when no sink is configured.
 * - Mirrors to `console.log('[analytics] …')` once per call when
 *   `import.meta.env.DEV` is true *and* the localStorage debug flag
 *   is `'1'`.
 * - Never throws. Sink failures are swallowed so a broken adapter
 *   cannot crash the renderer.
 *
 * Callers must not pass raw user input. See the file header.
 */
export function trackEvent(name: string, props: Record<string, unknown> = {}): void {
  // Defensive copy — the sink should not be able to mutate the
  // caller's object, and a frozen event makes downstream misuse
  // visible in dev.
  const event: AnalyticsEvent = Object.freeze({ name, props: Object.freeze({ ...props }) });

  if (isDevDebugEnabled()) {
    try {
      // Explicit dev opt-in console mirror; see the file header.
      console.log('[analytics]', name, props);
    } catch {
      /* console can throw in odd embeddings; never propagate */
    }
  }

  const sink = currentSink;
  if (sink === null) return;
  try {
    sink(event);
  } catch {
    /* never let a broken sink crash the page */
  }
}

/**
 * `true` when both `import.meta.env.DEV` is set and the user has
 * opted in via `localStorage['bunny2.debug.analytics'] = '1'`.
 *
 * Both reads are wrapped: `import.meta.env` is `undefined` in some
 * non-Vite runtimes (test runner), and `localStorage` throws in
 * private mode / SSR / sandboxed iframes. A `false` fallback keeps
 * the primitive a no-op when in doubt.
 */
function isDevDebugEnabled(): boolean {
  let dev = false;
  try {
    // `import.meta.env` is an empty object under `bun test` (Vite
    // does not run); DEV is `undefined`, which falsies cleanly.
    dev = import.meta.env?.DEV === true;
  } catch {
    return false;
  }
  if (!dev) return false;
  try {
    if (typeof localStorage === 'undefined') return false;
    return localStorage.getItem(DEBUG_FLAG_KEY) === DEBUG_FLAG_VALUE;
  } catch {
    return false;
  }
}

/**
 * Test-only hook. Mirrors `__resetThemeForTests` in `theme.ts` —
 * module-level state needs a between-test reset. Production never
 * calls this.
 */
export function __resetAnalyticsForTests(): void {
  currentSink = null;
}
