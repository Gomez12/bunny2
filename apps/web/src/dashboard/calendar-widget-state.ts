import type { CalendarEventStatsResponse } from '../lib/api';

/**
 * Phase 4c.4 — pure state-machine for the Calendar dashboard widget.
 *
 * Mirrors `companies-widget-state.ts` / `contacts-widget-state.ts` so
 * the matrix of render branches (loading / error / empty / ready) is
 * testable without a DOM runtime. The component delegates branch
 * selection to this reducer so a future DOM-driven render test (parked
 * behind `docs/dev/follow-ups/web-component-tests.md`) does not have to
 * fork the logic.
 *
 * The reducer is intentionally exhaustive: any input pair the component
 * can hand it MUST yield a `CalendarWidgetView` the renderer knows how
 * to draw.
 */
export type CalendarWidgetInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly stats: CalendarEventStatsResponse };

export type CalendarWidgetView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly stats: CalendarEventStatsResponse };

export function calendarWidgetView(input: CalendarWidgetInput): CalendarWidgetView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  // `ready` — when no events exist at all, draw the empty-state CTA.
  if (input.stats.total === 0) return { kind: 'empty' };
  return { kind: 'ready', stats: input.stats };
}
