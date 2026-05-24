import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { ScheduledTaskSchedule } from '@bunny2/shared';
import type { LlmClient } from '../llm';
import type { ScheduledTask, ScheduledTaskRun } from './repo';

/**
 * Phase 5.3 — process-local registry of scheduled-task handlers.
 *
 * Same shape as `entities/registry.ts`:
 *  - module-level Map
 *  - `register…` throws on kind collision (registration is meant
 *    to be idempotent — second call with the same kind is a
 *    programming error, not a no-op)
 *  - test-only reset hook with an underscored name so production
 *    code cannot legitimately depend on it
 *
 * Handlers are pure runtime — they do not own any persistent
 * state. The registry stores the function plus a few hints
 * (`defaultSchedule`, future: `defaultLayerScope`) that the
 * 5.4 create-task UI/route uses for sensible pre-fill. Resolves
 * plan §15 open question #1 (yes, accept optional
 * `defaultSchedule`).
 */

export interface ScheduledTaskRunContext {
  /** The full task row at the moment the runner claimed it. */
  readonly task: ScheduledTask;
  /** The run row this invocation belongs to (status === 'started'). */
  readonly run: ScheduledTaskRun;
  /**
   * Stable correlation id stamped by the scheduler tick. Forwarded on
   * every `scheduledtask.run.*` event the subscriber emits and
   * available here so handler-side LLM calls can join the LLM call
   * log against the events table.
   */
  readonly correlationId: string;
  /**
   * Wallclock at handler invocation. Always a string ISO timestamp
   * so handler code never accidentally drifts from the timestamps
   * the rest of the system uses. Stored as a `() => string` so the
   * subscriber can hand a fixed clock in tests.
   */
  readonly now: () => string;
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  /** Per-handler scoped logger. Falls back to `console` shape. */
  readonly logger: ScheduledTaskHandlerLogger;
}

export interface ScheduledTaskHandlerLogger {
  info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
}

export interface ScheduledTaskHandler {
  /**
   * Globally unique handler key, e.g. `'scheduled.runs.prune'`,
   * `'llm.calls.prune'`, `'reports.weekly-digest'`. The kind goes
   * onto the `scheduled_tasks.kind` column and the scheduler tick
   * uses it to find the handler. Must match
   * `/^[a-z][a-z0-9.\-_]*$/` by convention; the registry does not
   * enforce a regex so test fixtures can register weird kinds.
   */
  readonly kind: string;

  /**
   * Optional sensible default the 5.4 create-dialog can pre-fill.
   * Resolves plan §15 open question #1. Handlers that are designed
   * to fire on a specific cron / interval set this; ad-hoc
   * handlers without an opinion leave it `undefined` and let the
   * user pick.
   */
  readonly defaultSchedule?: ScheduledTaskSchedule;

  /**
   * Runs the work. Throws to signal failure; the run subscriber
   * catches and routes the throw into the retry/backoff state
   * machine. Resolution rules (plan §4.2 step 5):
   *  - Throw with `Error('reason')` — the message is clipped to
   *    ~500 chars, stack lands in `console.error` only.
   *  - Throw a non-Error — coerced via `String(err)`.
   *  - Returning normally is success; the return value is
   *    discarded (handlers can publish their own bus events for
   *    structured side effects).
   */
  run(ctx: ScheduledTaskRunContext): Promise<void>;
}

export interface RegisteredScheduledTaskHandlerInfo {
  readonly kind: string;
  readonly defaultSchedule?: ScheduledTaskSchedule;
}

const handlersByKind = new Map<string, ScheduledTaskHandler>();

/**
 * Registers a handler. Throws on kind collision — kinds are global,
 * and a duplicate registration almost always means two modules
 * accidentally chose the same key. Mirrors `registerEntityModule`.
 */
export function registerScheduledTaskHandler(handler: ScheduledTaskHandler): void {
  const existing = handlersByKind.get(handler.kind);
  if (existing !== undefined) {
    throw new Error(
      `scheduled-task-registry: kind '${handler.kind}' is already registered. ` +
        `Pick a unique kind or reset the registry in tests.`,
    );
  }
  handlersByKind.set(handler.kind, handler);
}

/**
 * Looks up a handler by kind. Returns `null` when no handler is
 * registered — the run subscriber treats this as `skipped_no_handler`
 * rather than throwing, because a missing handler is a known
 * deployment-config gap (e.g. a row from a migrated DB whose
 * handler module has not been wired yet) rather than a programming
 * error.
 */
export function getScheduledTaskHandler(kind: string): ScheduledTaskHandler | null {
  return handlersByKind.get(kind) ?? null;
}

/**
 * Snapshot of every registered handler. Order is registration
 * order. Powers the future job-inventory test (5.7) — the test
 * walks this list and asserts each `kind` has a row in
 * `docs/dev/architecture/job-inventory.md`.
 */
export function listRegisteredScheduledTaskHandlers(): readonly RegisteredScheduledTaskHandlerInfo[] {
  return Array.from(handlersByKind.values()).map((h) => {
    const out: RegisteredScheduledTaskHandlerInfo = { kind: h.kind };
    if (h.defaultSchedule !== undefined) {
      (out as { defaultSchedule?: ScheduledTaskSchedule }).defaultSchedule = h.defaultSchedule;
    }
    return out;
  });
}

/**
 * Test-only reset. Production code MUST NOT call this — kinds are
 * registered once per process at boot. Tests that register fixture
 * handlers call this in their teardown to keep registrations
 * isolated. Mirrors `__resetEntityRegistryForTests`.
 */
export function __resetScheduledTaskRegistryForTests(): void {
  handlersByKind.clear();
}
