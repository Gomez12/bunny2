/**
 * Phase 6.6 — pure logic backing `RecentChatsWidget.tsx`.
 *
 * The widget reads `listLayerChatConversations(...)` directly — the
 * 6.6 server change added aggregated `feedbackUpCount` /
 * `feedbackDownCount` to the same payload, so no extra round-trip is
 * required. This module hosts the per-conversation feedback ratio
 * formatter and the "latest 5" trim, both exercised by
 * `apps/web/tests/recent-chats-widget.test.ts`.
 */

import type { LayerChatConversation } from '../lib/api';

export const RECENT_CHATS_LIMIT = 5;

export interface FeedbackRatioView {
  /** Pretty-printed ratio (e.g. `3 / 1`). */
  readonly text: string;
  /** Total feedback rows; `0` → the empty placeholder applies. */
  readonly total: number;
  readonly up: number;
  readonly down: number;
}

/**
 * Build the small feedback summary that the widget renders next to
 * each conversation row. Returns `null` when no feedback exists; the
 * widget uses that to fall back to an em-dash placeholder.
 */
export function feedbackRatioView(c: LayerChatConversation): FeedbackRatioView | null {
  const up = c.feedbackUpCount;
  const down = c.feedbackDownCount;
  const total = up + down;
  if (total === 0) return null;
  return {
    text: `${up} / ${down}`,
    total,
    up,
    down,
  };
}

/**
 * Trim a conversation list to the latest five rows. The list endpoint
 * already returns them newest-first by `updatedAt`, so we just slice.
 */
export function pickRecent(
  conversations: readonly LayerChatConversation[],
): readonly LayerChatConversation[] {
  return conversations.slice(0, RECENT_CHATS_LIMIT);
}
