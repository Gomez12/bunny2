/**
 * Phase 6.6 — pure-logic tests for the `RecentChatsWidget`.
 *
 * The widget itself just wires `useState` / `useEffect` around two
 * tiny helpers in `recent-chats-widget-state.ts`; the helpers do
 * the actual work. We exercise them directly here, same shape as
 * every other web-side widget test (`todos-widget.test.ts`,
 * `companies-widget.test.ts`).
 */

import { describe, expect, it } from 'bun:test';
import type { LayerChatConversation } from '../src/lib/api';
import {
  feedbackRatioView,
  pickRecent,
  RECENT_CHATS_LIMIT,
} from '../src/dashboard/recent-chats-widget-state';

function makeConv(overrides: Partial<LayerChatConversation> = {}): LayerChatConversation {
  return {
    id: crypto.randomUUID(),
    layerId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    title: 'demo',
    locale: 'en',
    createdAt: '2026-05-24T10:00:00.000Z',
    updatedAt: '2026-05-24T12:00:00.000Z',
    deletedAt: null,
    deletedBy: null,
    feedbackUpCount: 0,
    feedbackDownCount: 0,
    ...overrides,
  };
}

describe('feedbackRatioView', () => {
  it('returns null when there is no feedback', () => {
    expect(feedbackRatioView(makeConv())).toBeNull();
  });

  it('formats a ratio with both counts', () => {
    const view = feedbackRatioView(makeConv({ feedbackUpCount: 3, feedbackDownCount: 1 }));
    expect(view).not.toBeNull();
    expect(view?.text).toBe('3 / 1');
    expect(view?.up).toBe(3);
    expect(view?.down).toBe(1);
    expect(view?.total).toBe(4);
  });

  it('handles thumbs-up-only and thumbs-down-only views', () => {
    expect(feedbackRatioView(makeConv({ feedbackUpCount: 2 }))?.text).toBe('2 / 0');
    expect(feedbackRatioView(makeConv({ feedbackDownCount: 5 }))?.text).toBe('0 / 5');
  });
});

describe('pickRecent', () => {
  it('returns up to RECENT_CHATS_LIMIT conversations', () => {
    expect(RECENT_CHATS_LIMIT).toBe(5);
    const seven: LayerChatConversation[] = [];
    for (let i = 0; i < 7; i += 1) {
      seven.push(makeConv({ title: `conv-${i}` }));
    }
    const trimmed = pickRecent(seven);
    expect(trimmed.length).toBe(5);
    // Preserves order — the server hands us newest-first already.
    expect(trimmed[0]?.title).toBe('conv-0');
    expect(trimmed[4]?.title).toBe('conv-4');
  });

  it('returns the whole list when it has fewer than the cap', () => {
    const two: LayerChatConversation[] = [makeConv(), makeConv()];
    expect(pickRecent(two).length).toBe(2);
  });

  it('returns an empty list when the input is empty', () => {
    expect(pickRecent([])).toEqual([]);
  });
});
