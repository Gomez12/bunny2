/**
 * Phase 6.6 — pure-logic tests for the layer chat board page.
 *
 * Mirrors the 6.5 `layer-chat-page.test.ts` pattern: the bucketing
 * and polling logic that the page wires through `useState` /
 * `useEffect` lives in `layer-chat-board-page-state.ts` so it can
 * be tested directly against fixtures.
 *
 * Covers:
 *  - `bucketBoardItem` produces the right column for every status
 *    + step shape (done / failed / queued / each pipeline step).
 *  - Cards within each column are sorted newest-first by `createdAt`.
 *  - Empty columns survive `groupBoardItemsByColumn`.
 *  - `startBoardPolling` pauses while `isVisible()` returns false
 *    and resumes when it returns true.
 *  - `jumpToConversationPath` produces the right deep-link shape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ChatBoardItem } from '@bunny2/shared';
import {
  BOARD_COLUMN_ORDER,
  bucketBoardItem,
  columnTitleKey,
  groupBoardItemsByColumn,
  jumpToConversationPath,
  startBoardPolling,
} from '../src/pages/layer-chat-board-page-state';

function makeItem(overrides: Partial<ChatBoardItem> = {}): ChatBoardItem {
  return {
    messageId: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    conversationTitle: 'demo',
    role: 'assistant',
    status: 'running',
    contentPreview: 'preview',
    createdAt: '2026-05-24T12:00:00.000Z',
    finishedAt: null,
    run: { id: crypto.randomUUID(), status: 'running' },
    steps: [],
    ...overrides,
  };
}

describe('bucketBoardItem', () => {
  it('places done messages in the done column', () => {
    expect(bucketBoardItem(makeItem({ status: 'done' }))).toBe('done');
  });

  it('places failed messages in the failed column', () => {
    expect(bucketBoardItem(makeItem({ status: 'failed' }))).toBe('failed');
  });

  it('places messages with no run yet in the queued column', () => {
    expect(bucketBoardItem(makeItem({ status: 'queued', run: null }))).toBe('queued');
  });

  it('places messages with a pending run in the queued column', () => {
    expect(
      bucketBoardItem(
        makeItem({
          status: 'queued',
          run: { id: 'r1', status: 'pending' },
          steps: [],
        }),
      ),
    ).toBe('queued');
  });

  it('places messages whose intent step is running in the intent column', () => {
    expect(
      bucketBoardItem(
        makeItem({
          status: 'running',
          run: { id: 'r1', status: 'running' },
          steps: [{ kind: 'intent', status: 'running' }],
        }),
      ),
    ).toBe('intent');
  });

  it('places messages whose entities step is running in the entities column', () => {
    expect(
      bucketBoardItem(
        makeItem({
          status: 'running',
          run: { id: 'r1', status: 'running' },
          steps: [
            { kind: 'intent', status: 'succeeded' },
            { kind: 'entities', status: 'running' },
          ],
        }),
      ),
    ).toBe('entities');
  });

  it('places messages whose retrieval step is running in the retrieval column', () => {
    expect(
      bucketBoardItem(
        makeItem({
          status: 'running',
          run: { id: 'r1', status: 'running' },
          steps: [
            { kind: 'intent', status: 'succeeded' },
            { kind: 'entities', status: 'succeeded' },
            { kind: 'retrieval', status: 'running' },
          ],
        }),
      ),
    ).toBe('retrieval');
  });

  it('places messages whose answer step is running in the answering column', () => {
    expect(
      bucketBoardItem(
        makeItem({
          status: 'running',
          run: { id: 'r1', status: 'running' },
          steps: [
            { kind: 'intent', status: 'succeeded' },
            { kind: 'entities', status: 'succeeded' },
            { kind: 'retrieval', status: 'succeeded' },
            { kind: 'answer', status: 'running' },
          ],
        }),
      ),
    ).toBe('answering');
  });

  it('places messages whose last touched step is succeeded into that step column', () => {
    // Between-step transition: no running, but the last succeeded
    // step is `retrieval` (so the message is "between retrieval and
    // answer" — surface it under retrieval).
    expect(
      bucketBoardItem(
        makeItem({
          status: 'running',
          run: { id: 'r1', status: 'running' },
          steps: [
            { kind: 'intent', status: 'succeeded' },
            { kind: 'entities', status: 'succeeded' },
            { kind: 'retrieval', status: 'succeeded' },
          ],
        }),
      ),
    ).toBe('retrieval');
  });
});

describe('groupBoardItemsByColumn', () => {
  it('puts every column in the map, even empty ones', () => {
    const grouped = groupBoardItemsByColumn([]);
    expect(grouped.size).toBe(BOARD_COLUMN_ORDER.length);
    for (const col of BOARD_COLUMN_ORDER) {
      expect(grouped.get(col)).toEqual([]);
    }
  });

  it('sorts cards within each column newest-first', () => {
    const older = makeItem({
      status: 'done',
      createdAt: '2026-05-24T10:00:00.000Z',
    });
    const newer = makeItem({
      status: 'done',
      createdAt: '2026-05-24T12:00:00.000Z',
    });
    const grouped = groupBoardItemsByColumn([older, newer]);
    const done = grouped.get('done') ?? [];
    expect(done.map((c) => c.createdAt)).toEqual([newer.createdAt, older.createdAt]);
  });

  it('splits items across the right columns', () => {
    const items: readonly ChatBoardItem[] = [
      makeItem({ status: 'done' }),
      makeItem({ status: 'failed' }),
      makeItem({
        status: 'running',
        run: { id: 'r', status: 'running' },
        steps: [{ kind: 'entities', status: 'running' }],
      }),
    ];
    const grouped = groupBoardItemsByColumn(items);
    expect(grouped.get('done')?.length).toBe(1);
    expect(grouped.get('failed')?.length).toBe(1);
    expect(grouped.get('entities')?.length).toBe(1);
  });
});

describe('columnTitleKey', () => {
  it('builds the localisation key for every column', () => {
    expect(columnTitleKey('queued')).toBe('chat.board.columns.queued');
    expect(columnTitleKey('done')).toBe('chat.board.columns.done');
    expect(columnTitleKey('answering')).toBe('chat.board.columns.answering');
  });
});

describe('jumpToConversationPath', () => {
  it('builds the conversation deep link without a message id', () => {
    expect(jumpToConversationPath('alice-p1', 'conv-1')).toBe(
      '/l/alice-p1/chat?conversation=conv-1',
    );
  });

  it('includes the message id when one is given', () => {
    const path = jumpToConversationPath('alice-p1', 'conv-1', 'msg-2');
    expect(path).toContain('conversation=conv-1');
    expect(path).toContain('message=msg-2');
  });

  it('escapes special characters in the slugs', () => {
    const path = jumpToConversationPath('slug with space', 'conv/1');
    expect(path).toContain('slug%20with%20space');
    expect(path).toContain('conv%2F1');
  });
});

describe('startBoardPolling', () => {
  // A deterministic timer pump: tests `setTimer` returns a numeric
  // handle and the helper invokes the callback synchronously when
  // we `flush()`.
  interface PendingTimer {
    readonly handle: number;
    readonly cb: () => void;
  }
  let pending: PendingTimer[];
  let nextHandle: number;

  const setTimer = (cb: () => void): number => {
    nextHandle += 1;
    pending.push({ handle: nextHandle, cb });
    return nextHandle;
  };
  const clearTimer = (handle: number): void => {
    pending = pending.filter((t) => t.handle !== handle);
  };

  const flush = (): void => {
    while (pending.length > 0) {
      const next = pending.shift();
      if (next === undefined) break;
      next.cb();
    }
  };

  beforeEach(() => {
    pending = [];
    nextHandle = 0;
  });
  afterEach(() => {
    pending = [];
  });

  it('runs the first poll immediately and schedules the next tick', async () => {
    let polls = 0;
    const handle = startBoardPolling({
      intervalMs: 5000,
      isVisible: () => true,
      poll: () => {
        polls += 1;
      },
      setTimer,
      clearTimer,
    });
    // Initial poll runs synchronously inside `tick`. Wait one
    // microtask for the inner `await` to resolve.
    await Promise.resolve();
    expect(polls).toBe(1);
    expect(pending.length).toBe(1); // next tick is queued
    handle.stop();
  });

  it('skips the poll while isVisible() is false (page hidden)', async () => {
    let polls = 0;
    let visible = false;
    const handle = startBoardPolling({
      intervalMs: 5000,
      isVisible: () => visible,
      poll: () => {
        polls += 1;
      },
      setTimer,
      clearTimer,
    });
    await Promise.resolve();
    expect(polls).toBe(0);

    // Flip to visible + fire the next scheduled tick: poll runs.
    visible = true;
    flush();
    await Promise.resolve();
    expect(polls).toBe(1);
    handle.stop();
  });

  it('stop() clears the next scheduled tick', async () => {
    let polls = 0;
    const handle = startBoardPolling({
      intervalMs: 5000,
      isVisible: () => true,
      poll: () => {
        polls += 1;
      },
      setTimer,
      clearTimer,
    });
    await Promise.resolve();
    expect(pending.length).toBe(1);
    handle.stop();
    expect(pending.length).toBe(0);
    // A flush against the empty list does nothing; poll count stays.
    flush();
    expect(polls).toBe(1);
  });
});
