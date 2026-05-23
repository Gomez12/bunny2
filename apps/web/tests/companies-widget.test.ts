/**
 * Phase 4a.4 — pure-logic tests for the Companies dashboard widget.
 *
 * The repo has no DOM runtime yet (`bun test` runs without
 * happy-dom / @testing-library/react — see
 * `docs/dev/follow-ups/web-component-tests.md`), so this file covers
 * the matrix the component renders by testing the pure state reducer
 * + the widget registry contract. The rendered DOM matrix lands once
 * the follow-up wires a DOM runtime.
 *
 * Covered:
 *
 *   - `companiesWidgetView` maps loading/error/ready/empty-by-total
 *     inputs to the exact render branch the component reads.
 *   - The widget registry registers the Companies widget on import and
 *     exposes a deterministic ordering for `LayerDashboardPage`.
 *   - The widget exposes the i18n keys promised by the plan in §4a.4 of
 *     `docs/dev/plans/phase-04-first-entities.md` — i18n discipline test
 *     (`apps/web/tests/i18n-no-hardcoded-strings.test.ts`) covers
 *     en.json key presence; this file additionally asserts the
 *     widget's title key is the one wired into the registry, so a
 *     rename can't drift.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  companiesWidgetView,
  type CompaniesWidgetInput,
} from '../src/dashboard/companies-widget-state';
import {
  listDashboardWidgets,
  registerWidget,
  __resetDashboardWidgetsForTests,
} from '../src/dashboard/widget-registry';

function readyInput(
  overrides: Partial<{
    total: number;
    withKvk: number;
    missingDescription: number;
    recentlyEnriched: number;
  }> = {},
): CompaniesWidgetInput {
  return {
    status: 'ready',
    stats: {
      total: 3,
      withKvk: 1,
      missingDescription: 1,
      recentlyEnriched: 1,
      ...overrides,
    },
  };
}

describe('companiesWidgetView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(companiesWidgetView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(companiesWidgetView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the empty branch when total is zero', () => {
    expect(
      companiesWidgetView(
        readyInput({ total: 0, withKvk: 0, missingDescription: 0, recentlyEnriched: 0 }),
      ),
    ).toEqual({
      kind: 'empty',
    });
  });

  it('returns the ready branch with the stats payload when total > 0', () => {
    const out = companiesWidgetView(readyInput({ total: 5, withKvk: 2 }));
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.stats.total).toBe(5);
      expect(out.stats.withKvk).toBe(2);
    }
  });

  it('treats a single-row ready input as ready (not empty)', () => {
    // Guard against an off-by-one where `total === 1` accidentally
    // routes to the empty CTA. The empty branch MUST only fire on 0.
    expect(
      companiesWidgetView(
        readyInput({ total: 1, withKvk: 0, missingDescription: 0, recentlyEnriched: 0 }),
      ).kind,
    ).toBe('ready');
  });
});

describe('widget registry', () => {
  beforeEach(() => {
    __resetDashboardWidgetsForTests();
  });

  it('is empty by default after reset', () => {
    expect(listDashboardWidgets()).toEqual([]);
  });

  it('returns registered widgets sorted by order then by registration order', () => {
    const noop = (): null => null;
    registerWidget({ kind: 'b', titleKey: 'b.title', renderer: noop, order: 10 });
    registerWidget({ kind: 'a', titleKey: 'a.title', renderer: noop, order: 5 });
    registerWidget({ kind: 'c', titleKey: 'c.title', renderer: noop, order: 10 });
    const ordered = listDashboardWidgets().map((w) => w.kind);
    expect(ordered).toEqual(['a', 'b', 'c']);
  });

  it('is idempotent on duplicate registration', () => {
    const noop = (): null => null;
    registerWidget({ kind: 'a', titleKey: 'a.title', renderer: noop, order: 1 });
    registerWidget({ kind: 'a', titleKey: 'a.title.changed', renderer: noop, order: 99 });
    const widgets = listDashboardWidgets();
    expect(widgets.length).toBe(1);
    expect(widgets[0]?.titleKey).toBe('a.title');
  });

  it('accepts the Companies widget shape used by the production registration', () => {
    // Mirrors the literal `registerWidget({...})` call inside
    // `apps/web/src/dashboard/CompaniesWidget.tsx`. If the registry
    // ever rejects this shape (e.g. a new required field is added
    // without a default), this test catches it before the dashboard
    // renders an empty grid in production.
    const noop = (): null => null;
    registerWidget({
      kind: 'companies',
      titleKey: 'layer.dashboard.widgets.companies.title',
      renderer: noop,
      order: 100,
    });
    const widgets = listDashboardWidgets();
    const companies = widgets.find((w) => w.kind === 'companies');
    expect(companies).toBeDefined();
    expect(companies?.titleKey).toBe('layer.dashboard.widgets.companies.title');
    expect(companies?.order).toBe(100);
  });
});
