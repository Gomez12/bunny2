import type { RecentWhiteboardItem } from '../lib/api';

/**
 * Phase 11.4 — pure state-machine for the Whiteboards dashboard widget.
 *
 * Mirrors `todos-widget-state.ts` / `recent-chats-widget-state.ts` so
 * the matrix of render branches (loading / empty / error / ready) is
 * testable without a DOM runtime (see
 * `apps/web/tests/whiteboards-widget.test.ts`). The component
 * delegates branch selection to this reducer so a future DOM-driven
 * render test (parked behind `docs/dev/follow-ups/web-component-tests.md`)
 * does not have to fork the logic.
 *
 * The empty branch fires when the recent-list endpoint returns zero
 * rows. The widget's CTAs ("New whiteboard" / "View all") link ahead
 * to routes that mount in 11.5 — that forward-linking is intentional
 * per plan §11.4.
 *
 * The reducer is intentionally exhaustive: any input pair the
 * component can hand it MUST yield a `WhiteboardsWidgetView` the
 * renderer knows how to draw.
 */

/** How many recent whiteboards the widget asks for. Capped server-side. */
export const WHITEBOARDS_WIDGET_LIMIT = 5;

export type WhiteboardsWidgetInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly items: readonly RecentWhiteboardItem[] };

export type WhiteboardsWidgetView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly items: readonly RecentWhiteboardItem[] };

export function whiteboardsWidgetView(input: WhiteboardsWidgetInput): WhiteboardsWidgetView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  if (input.items.length === 0) return { kind: 'empty' };
  return { kind: 'ready', items: input.items };
}
