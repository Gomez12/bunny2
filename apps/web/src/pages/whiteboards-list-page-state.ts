/**
 * Phase 11.5 — pure-logic helpers for the whiteboards list page.
 *
 * Mirrors `companies-page-state.ts` / `calendar-page-state.ts`:
 * the web repo has no DOM runtime, so the reducer is factored into
 * pure functions exercised by `bun test`. The render branches the
 * list page draws are derived here so the test surface stays small.
 */
import type { WhiteboardListWithThumbnailItem } from '../lib/api-types';

export type WhiteboardsListInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly items: readonly WhiteboardListWithThumbnailItem[] };

export type WhiteboardsListView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly items: readonly WhiteboardListWithThumbnailItem[] };

export function whiteboardsListView(input: WhiteboardsListInput): WhiteboardsListView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  if (input.items.length === 0) return { kind: 'empty' };
  return { kind: 'ready', items: input.items };
}
