import type { CompanyStatsResponse } from '../lib/api';

/**
 * Phase 4a.4 — pure state-machine for the Companies dashboard widget.
 *
 * Extracted from the React component so the matrix of render branches
 * (loading / error / empty / ready) is testable without a DOM runtime.
 * See `docs/dev/follow-ups/web-component-tests.md` for the broader
 * follow-up that will let us also exercise the rendered output.
 *
 * The reducer is intentionally exhaustive: any input pair the component
 * can hand it MUST yield a `WidgetView` the renderer knows how to draw.
 */
export type CompaniesWidgetInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly stats: CompanyStatsResponse };

export type CompaniesWidgetView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly stats: CompanyStatsResponse };

export function companiesWidgetView(input: CompaniesWidgetInput): CompaniesWidgetView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  // `ready` — when no companies exist at all, draw the empty-state CTA.
  if (input.stats.total === 0) return { kind: 'empty' };
  return { kind: 'ready', stats: input.stats };
}
