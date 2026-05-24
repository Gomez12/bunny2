import type { TodoStatsResponse } from '../lib/api';

/**
 * Phase 4d.4 — pure state-machine for the Todos dashboard widget.
 *
 * Mirrors `companies-widget-state.ts` / `contacts-widget-state.ts` /
 * `calendar-widget-state.ts` so the matrix of render branches
 * (loading / error / empty / ready) is testable without a DOM runtime.
 * The component delegates branch selection to this reducer so a future
 * DOM-driven render test (parked behind
 * `docs/dev/follow-ups/web-component-tests.md`) does not have to fork
 * the logic.
 *
 * The empty branch fires when `totalOpen === 0` — a layer can still
 * have done / cancelled todos and we deliberately surface the empty
 * state because the dashboard's job is to highlight outstanding work.
 * If a user finishes their last open todo the widget switches to the
 * empty CTA on the next reload, which matches the "highlight work to
 * do" intent.
 *
 * The reducer is intentionally exhaustive: any input pair the component
 * can hand it MUST yield a `TodosWidgetView` the renderer knows how
 * to draw.
 */
export type TodosWidgetInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly stats: TodoStatsResponse };

export type TodosWidgetView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly stats: TodoStatsResponse };

export function todosWidgetView(input: TodosWidgetInput): TodosWidgetView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  // `ready` — when no OPEN todos exist, draw the empty-state CTA.
  if (input.stats.totalOpen === 0) return { kind: 'empty' };
  return { kind: 'ready', stats: input.stats };
}
