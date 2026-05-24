import type { ContactStatsResponse } from '../lib/api';

/**
 * Phase 4b.4 — pure state-machine for the Contacts dashboard widget.
 *
 * Mirrors `companies-widget-state.ts` so the matrix of render branches
 * (loading / error / empty / ready) is testable without a DOM runtime.
 * The component delegates branch selection to this reducer so a future
 * DOM-driven render test (parked behind
 * `docs/dev/follow-ups/web-component-tests.md`) does not have to fork
 * the logic.
 *
 * The reducer is intentionally exhaustive: any input pair the component
 * can hand it MUST yield a `ContactsWidgetView` the renderer knows how
 * to draw.
 */
export type ContactsWidgetInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly stats: ContactStatsResponse };

export type ContactsWidgetView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly stats: ContactStatsResponse };

export function contactsWidgetView(input: ContactsWidgetInput): ContactsWidgetView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  // `ready` — when no contacts exist at all, draw the empty-state CTA.
  if (input.stats.total === 0) return { kind: 'empty' };
  return { kind: 'ready', stats: input.stats };
}
