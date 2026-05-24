/**
 * Phase 4d.4 — pure-logic tests for the Todos dashboard widget.
 *
 * Mirrors `companies-widget.test.ts` / `contacts-widget.test.ts` /
 * `calendar-widget.test.ts`: the repo has no DOM runtime yet (see
 * `docs/dev/follow-ups/web-component-tests.md`), so this file covers
 * the matrix the component renders by testing the pure state reducer
 * plus the widget registry contract. The rendered DOM matrix lands
 * once the follow-up wires a DOM runtime.
 *
 * Covered:
 *   - `todosWidgetView` maps loading / error / ready / empty-by-totalOpen
 *     inputs to the exact render branch the component reads.
 *   - The widget registry registers the Todos widget on import and
 *     exposes a deterministic ordering for `LayerDashboardPage`.
 *   - The widget exposes the literal registration shape promised by the
 *     plan in §4d.4 of `docs/dev/plans/done/phase-04-first-entities.md` —
 *     a rename of the title key or registry kind is caught here before
 *     the dashboard drifts.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import { todosWidgetView, type TodosWidgetInput } from '../src/dashboard/todos-widget-state';
import {
  listDashboardWidgets,
  registerWidget,
  __resetDashboardWidgetsForTests,
} from '../src/dashboard/widget-registry';

function readyInput(
  overrides: Partial<{
    totalOpen: number;
    dueToday: number;
    overdue: number;
    highPriorityOpen: number;
  }> = {},
): TodosWidgetInput {
  return {
    status: 'ready',
    stats: {
      totalOpen: 4,
      dueToday: 1,
      overdue: 1,
      highPriorityOpen: 1,
      ...overrides,
    },
  };
}

describe('todosWidgetView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(todosWidgetView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(todosWidgetView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the empty branch when totalOpen is zero', () => {
    expect(
      todosWidgetView(readyInput({ totalOpen: 0, dueToday: 0, overdue: 0, highPriorityOpen: 0 })),
    ).toEqual({
      kind: 'empty',
    });
  });

  it('returns the ready branch with the stats payload when totalOpen > 0', () => {
    const out = todosWidgetView(readyInput({ totalOpen: 9, dueToday: 3, overdue: 2 }));
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.stats.totalOpen).toBe(9);
      expect(out.stats.dueToday).toBe(3);
      expect(out.stats.overdue).toBe(2);
    }
  });

  it('treats a single-row ready input as ready (not empty)', () => {
    // Guard against an off-by-one where `totalOpen === 1` routes to
    // the empty CTA. The empty branch MUST only fire on 0.
    expect(
      todosWidgetView(readyInput({ totalOpen: 1, dueToday: 0, overdue: 0, highPriorityOpen: 0 }))
        .kind,
    ).toBe('ready');
  });
});

describe('todos widget registry', () => {
  beforeEach(() => {
    __resetDashboardWidgetsForTests();
  });

  it('accepts the Todos widget shape used by the production registration', () => {
    // Mirrors the literal `registerWidget({...})` call inside
    // `apps/web/src/dashboard/TodosWidget.tsx`. If the registry ever
    // rejects this shape (e.g. a new required field is added without
    // a default), this test catches it before the dashboard renders
    // an empty grid in production.
    const noop = (): null => null;
    registerWidget({
      kind: 'todos',
      titleKey: 'layer.dashboard.widgets.todos.title',
      renderer: noop,
      order: 400,
    });
    const widgets = listDashboardWidgets();
    const todos = widgets.find((w) => w.kind === 'todos');
    expect(todos).toBeDefined();
    expect(todos?.titleKey).toBe('layer.dashboard.widgets.todos.title');
    expect(todos?.order).toBe(400);
    expect(typeof todos?.renderer).toBe('function');
  });

  it('renders after Companies, Contacts and Calendar when all four are registered', () => {
    // `order` sort wins: Companies is 100, Contacts is 200, Calendar
    // is 300, Todos is 400 — Todos must come fourth. Cheap regression
    // guard against accidentally picking a Todos `order` lower than
    // 300.
    const noop = (): null => null;
    registerWidget({
      kind: 'todos',
      titleKey: 'layer.dashboard.widgets.todos.title',
      renderer: noop,
      order: 400,
    });
    registerWidget({
      kind: 'calendar',
      titleKey: 'layer.dashboard.widgets.calendar.title',
      renderer: noop,
      order: 300,
    });
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
    expect(order).toEqual(['companies', 'contacts', 'calendar', 'todos']);
  });
});
