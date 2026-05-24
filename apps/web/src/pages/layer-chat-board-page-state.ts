/**
 * Phase 6.6 — pure logic backing `LayerChatBoardPage.tsx`.
 *
 * Like its 6.5 sibling (`layer-chat-page-state.ts`), the web app has
 * no DOM test runtime, so the bucketing / polling logic the Kanban
 * board depends on lives here as pure functions. The unit tests
 * exercise this module directly (`apps/web/tests/layer-chat-board-page.test.ts`).
 *
 * Covered:
 *  - Bucket each `ChatBoardItem` into the right column based on its
 *    message status + run snapshot + step snapshot.
 *  - Sort items within each column newest-first.
 *  - Compute a localisation key per column.
 *  - A small polling scheduler that pauses while `isVisible()`
 *    returns false (the page wires it to `document.hidden`).
 */

import type { ChatBoardItem, ChatBoardStepSnapshot, PipelineStepKind } from '@bunny2/shared';

// ---------- column model -------------------------------------------------

export type BoardColumnKind =
  | 'queued'
  | 'intent'
  | 'entities'
  | 'retrieval'
  | 'answering'
  | 'done'
  | 'failed';

export const BOARD_COLUMN_ORDER: readonly BoardColumnKind[] = [
  'queued',
  'intent',
  'entities',
  'retrieval',
  'answering',
  'done',
  'failed',
];

/**
 * Map of intermediate pipeline step kinds → their board column. The
 * fixed mapping is the contract phase 6.7 docs lean on; do not
 * recompute it lazily inside the bucketing function.
 *
 * The `answer` step lands in the `answering` column for clarity —
 * "answering" is closer to user-facing English than the internal
 * `answer` token. (`done` / `failed` still come from the message
 * status, not the step kind.)
 */
const STEP_KIND_TO_COLUMN: Readonly<Record<PipelineStepKind, BoardColumnKind>> = {
  intent: 'intent',
  entities: 'entities',
  retrieval: 'retrieval',
  answer: 'answering',
};

/**
 * Decide which Kanban column an item belongs in.
 *
 * Decision tree (top wins):
 *  1. message `status='failed'` → `failed`.
 *  2. message `status='done'`   → `done`.
 *  3. no run yet OR run `status='pending'` → `queued`.
 *  4. find a `running` step → map via `STEP_KIND_TO_COLUMN`.
 *  5. find the last `running`-then-`succeeded` step (transition
 *     point) → its column (last running kind before transition).
 *  6. fallback: `queued`.
 */
export function bucketBoardItem(item: ChatBoardItem): BoardColumnKind {
  if (item.status === 'failed') return 'failed';
  if (item.status === 'done') return 'done';
  if (item.run === null || item.run.status === 'pending') return 'queued';

  // 4. currently `running` step.
  const runningStep = item.steps.find((s) => s.status === 'running');
  if (runningStep !== undefined) {
    return STEP_KIND_TO_COLUMN[runningStep.kind];
  }
  // 5. find last step that progressed (the step kind that was the
  // active pipeline stage before the run transitioned). Walk the
  // step list backwards; the last `succeeded` / `failed` is the
  // furthest the pipeline got.
  const lastTouched = findLastTouchedStep(item.steps);
  if (lastTouched !== undefined) {
    return STEP_KIND_TO_COLUMN[lastTouched.kind];
  }
  return 'queued';
}

function findLastTouchedStep(
  steps: readonly ChatBoardStepSnapshot[],
): ChatBoardStepSnapshot | undefined {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const step = steps[i];
    if (step === undefined) continue;
    if (step.status === 'succeeded' || step.status === 'failed' || step.status === 'running') {
      return step;
    }
  }
  return undefined;
}

/**
 * Group board items into the seven columns and sort each column
 * newest-first by `createdAt`. The returned `Map` is keyed by
 * `BoardColumnKind`; every column is present (empty arrays are
 * allowed).
 *
 * Total complexity is O(N log K) where N = items, K = column size;
 * for the board's default cap of 50 the constant factor dominates.
 */
export function groupBoardItemsByColumn(
  items: readonly ChatBoardItem[],
): ReadonlyMap<BoardColumnKind, readonly ChatBoardItem[]> {
  const out = new Map<BoardColumnKind, ChatBoardItem[]>();
  for (const col of BOARD_COLUMN_ORDER) out.set(col, []);
  for (const item of items) {
    const col = bucketBoardItem(item);
    out.get(col)?.push(item);
  }
  // Within each column, newest-first by `createdAt`.
  for (const arr of out.values()) {
    arr.sort((a, b) => compareIsoDesc(a.createdAt, b.createdAt));
  }
  return out;
}

function compareIsoDesc(a: string, b: string): number {
  // ISO-8601 strings sort lexicographically; reverse order = newest-first.
  if (a < b) return 1;
  if (a > b) return -1;
  return 0;
}

// ---------- column localisation keys -------------------------------------

export function columnTitleKey(col: BoardColumnKind): string {
  return `chat.board.columns.${col}`;
}

// ---------- polling scheduler -------------------------------------------

/**
 * A pure, deterministic-shape scheduler for the 5 s board poll. The
 * page wires `isVisible` to `() => !document.hidden`; tests inject
 * a fake visibility + a fake `setTimeout` to assert that the poll
 * pauses when the page is hidden.
 *
 * Why not just `setInterval`? `setInterval` fires whether the tab
 * is visible or not; the user (and `originalplan.md`) explicitly
 * doesn't want a hidden tab to keep beating the server. The
 * page-visibility API gives us the pause signal, and re-running
 * once after a `visibilitychange` event keeps the board fresh on
 * tab-focus without a wasted heartbeat.
 */
export interface PollingDeps {
  readonly intervalMs: number;
  readonly isVisible: () => boolean;
  readonly poll: () => void | Promise<void>;
  /** Defaults to `setTimeout`; tests inject a deterministic clock. */
  readonly setTimer?: (cb: () => void, ms: number) => number;
  /** Defaults to `clearTimeout`. */
  readonly clearTimer?: (handle: number) => void;
}

export interface PollingHandle {
  readonly stop: () => void;
  /** Test-only — force the next tick to run synchronously. */
  readonly runNow: () => void | Promise<void>;
}

export function startBoardPolling(deps: PollingDeps): PollingHandle {
  const setT = deps.setTimer ?? ((cb, ms): number => setTimeout(cb, ms) as unknown as number);
  const clearT =
    deps.clearTimer ?? ((h): void => clearTimeout(h as unknown as ReturnType<typeof setTimeout>));
  let stopped = false;
  let pending: number | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (deps.isVisible()) {
      await deps.poll();
    }
    if (stopped) return;
    pending = setT(() => {
      void tick();
    }, deps.intervalMs);
  };

  // First poll is immediate so the column shape lands on mount
  // without a 5-second wait.
  void tick();

  return {
    stop: (): void => {
      stopped = true;
      if (pending !== null) clearT(pending);
      pending = null;
    },
    runNow: (): void | Promise<void> => deps.poll(),
  };
}

// ---------- jump-back deep link helper ---------------------------------

export function jumpToConversationPath(
  layerSlug: string,
  conversationId: string,
  messageId?: string,
): string {
  const base = `/l/${encodeURIComponent(layerSlug)}/chat?conversation=${encodeURIComponent(conversationId)}`;
  if (messageId === undefined) return base;
  // The 6.5 thread page does NOT yet read `?message=`; we still
  // include the parameter so 6.7's follow-up can wire it through
  // without a URL contract change. A follow-up doc note tracks the gap.
  return `${base}&message=${encodeURIComponent(messageId)}`;
}
