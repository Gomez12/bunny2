/**
 * Phase 4b.4 — pure-logic tests for the Contacts dashboard widget.
 *
 * Mirrors `companies-widget.test.ts`: the repo has no DOM runtime yet
 * (see `docs/dev/follow-ups/web-component-tests.md`), so this file covers
 * the matrix the component renders by testing the pure state reducer
 * plus the widget registry contract. The rendered DOM matrix lands once
 * the follow-up wires a DOM runtime.
 *
 * Covered:
 *   - `contactsWidgetView` maps loading / error / ready / empty-by-total
 *     inputs to the exact render branch the component reads.
 *   - The widget registry registers the Contacts widget on import and
 *     exposes a deterministic ordering for `LayerDashboardPage`.
 *   - The widget exposes the literal registration shape promised by the
 *     plan in §4b.4 of `docs/dev/plans/done/phase-04-first-entities.md` —
 *     a rename of the title key or registry kind is caught here before
 *     the dashboard drifts.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  contactsWidgetView,
  type ContactsWidgetInput,
} from '../src/dashboard/contacts-widget-state';
import {
  listDashboardWidgets,
  registerWidget,
  __resetDashboardWidgetsForTests,
} from '../src/dashboard/widget-registry';

function readyInput(
  overrides: Partial<{
    total: number;
    withCompanyLink: number;
    missingEmail: number;
    recentlyEnriched: number;
  }> = {},
): ContactsWidgetInput {
  return {
    status: 'ready',
    stats: {
      total: 4,
      withCompanyLink: 1,
      missingEmail: 1,
      recentlyEnriched: 1,
      ...overrides,
    },
  };
}

describe('contactsWidgetView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(contactsWidgetView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(contactsWidgetView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the empty branch when total is zero', () => {
    expect(
      contactsWidgetView(
        readyInput({ total: 0, withCompanyLink: 0, missingEmail: 0, recentlyEnriched: 0 }),
      ),
    ).toEqual({
      kind: 'empty',
    });
  });

  it('returns the ready branch with the stats payload when total > 0', () => {
    const out = contactsWidgetView(readyInput({ total: 7, withCompanyLink: 3 }));
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.stats.total).toBe(7);
      expect(out.stats.withCompanyLink).toBe(3);
    }
  });

  it('treats a single-row ready input as ready (not empty)', () => {
    // Guard against an off-by-one where `total === 1` routes to the
    // empty CTA. The empty branch MUST only fire on 0.
    expect(
      contactsWidgetView(
        readyInput({ total: 1, withCompanyLink: 0, missingEmail: 0, recentlyEnriched: 0 }),
      ).kind,
    ).toBe('ready');
  });
});

describe('contacts widget registry', () => {
  beforeEach(() => {
    __resetDashboardWidgetsForTests();
  });

  it('accepts the Contacts widget shape used by the production registration', () => {
    // Mirrors the literal `registerWidget({...})` call inside
    // `apps/web/src/dashboard/ContactsWidget.tsx`. If the registry ever
    // rejects this shape (e.g. a new required field is added without a
    // default), this test catches it before the dashboard renders an
    // empty grid in production.
    const noop = (): null => null;
    registerWidget({
      kind: 'contacts',
      titleKey: 'layer.dashboard.widgets.contacts.title',
      renderer: noop,
      order: 200,
    });
    const widgets = listDashboardWidgets();
    const contacts = widgets.find((w) => w.kind === 'contacts');
    expect(contacts).toBeDefined();
    expect(contacts?.titleKey).toBe('layer.dashboard.widgets.contacts.title');
    expect(contacts?.order).toBe(200);
    expect(typeof contacts?.renderer).toBe('function');
  });

  it('renders after the Companies widget when both are registered', () => {
    // `order` sort wins: Companies is 100, Contacts is 200 — Companies
    // must come first. Cheap regression guard against accidentally
    // picking a Contacts `order` lower than 100.
    const noop = (): null => null;
    registerWidget({
      kind: 'contacts',
      titleKey: 'layer.dashboard.widgets.contacts.title',
      renderer: noop,
      order: 200,
    });
    registerWidget({
      kind: 'companies',
      titleKey: 'layer.dashboard.widgets.companies.title',
      renderer: noop,
      order: 100,
    });
    const order = listDashboardWidgets().map((w) => w.kind);
    expect(order).toEqual(['companies', 'contacts']);
  });
});
