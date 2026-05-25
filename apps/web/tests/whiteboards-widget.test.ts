/**
 * Phase 11.4 — pure-logic tests for the Whiteboards dashboard widget.
 *
 * Mirrors `todos-widget.test.ts` / `recent-chats-widget.test.ts`: the
 * repo has no DOM runtime yet (see
 * `docs/dev/follow-ups/web-component-tests.md`), so this file covers
 * the matrix the component renders by testing the pure state reducer
 * plus the widget registry contract. The rendered DOM matrix lands
 * once the follow-up wires a DOM runtime.
 *
 * Covered:
 *   - `whiteboardsWidgetView` maps loading / error / ready / empty-by-zero
 *     inputs to the exact render branch the component reads.
 *   - The widget registry accepts the Whiteboards widget shape used by
 *     the production registration and exposes a deterministic ordering
 *     for `LayerDashboardPage`.
 *   - A rename of the title key or registry kind is caught here before
 *     the dashboard drifts.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import type { RecentWhiteboardItem } from '../src/lib/api';
import {
  WHITEBOARDS_WIDGET_LIMIT,
  whiteboardsWidgetView,
  type WhiteboardsWidgetInput,
} from '../src/dashboard/whiteboards-widget-state';
import {
  listDashboardWidgets,
  registerWidget,
  __resetDashboardWidgetsForTests,
} from '../src/dashboard/widget-registry';

function fixtureItem(overrides: Partial<RecentWhiteboardItem> = {}): RecentWhiteboardItem {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    slug: 'q3-retro-board',
    title: 'Q3 retro board',
    updatedAt: '2026-05-25T10:00:00Z',
    updatedBy: '22222222-2222-2222-2222-222222222222',
    thumbnailBlobBase64: null,
    ...overrides,
  };
}

function readyInput(items: readonly RecentWhiteboardItem[]): WhiteboardsWidgetInput {
  return { status: 'ready', items };
}

describe('whiteboardsWidgetView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(whiteboardsWidgetView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(whiteboardsWidgetView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the empty branch when the recent list is empty', () => {
    expect(whiteboardsWidgetView(readyInput([]))).toEqual({ kind: 'empty' });
  });

  it('returns the ready branch with the items payload when at least one row exists', () => {
    const items = [fixtureItem()];
    const out = whiteboardsWidgetView(readyInput(items));
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.items).toHaveLength(1);
      expect(out.items[0]?.title).toBe('Q3 retro board');
      // Phase 11.4 dominant case: no whiteboards have been edited yet,
      // so every row's thumbnail is `null`. The reducer must pass
      // `null` through unchanged so the renderer can show the
      // placeholder glyph.
      expect(out.items[0]?.thumbnailBlobBase64).toBeNull();
    }
  });

  it('passes a populated base64 thumbnail through to the ready branch', () => {
    // Phase 11.5 will fill `thumbnailBlobBase64` on every save. The
    // reducer must not mutate the payload — the renderer reads the
    // exact bytes back from `view.items[i].thumbnailBlobBase64`.
    const items = [fixtureItem({ thumbnailBlobBase64: 'iVBORw0KGgo=' })];
    const out = whiteboardsWidgetView(readyInput(items));
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.items[0]?.thumbnailBlobBase64).toBe('iVBORw0KGgo=');
    }
  });

  it('exposes a stable widget-row limit', () => {
    // The widget asks the server for at most this many rows; the
    // server clamps at 20. Keep the default sized to fit the
    // dashboard card without scroll.
    expect(WHITEBOARDS_WIDGET_LIMIT).toBe(5);
  });
});

describe('whiteboards widget registry', () => {
  beforeEach(() => {
    __resetDashboardWidgetsForTests();
  });

  it('accepts the Whiteboards widget shape used by the production registration', () => {
    // Mirrors the literal `registerWidget({...})` call inside
    // `apps/web/src/dashboard/WhiteboardsWidget.tsx`. If the registry
    // ever rejects this shape (e.g. a new required field is added
    // without a default), this test catches it before the dashboard
    // renders an empty grid in production.
    const noop = (): null => null;
    registerWidget({
      kind: 'whiteboards',
      titleKey: 'entity.whiteboards.widget.title',
      renderer: noop,
      order: 800,
    });
    const widgets = listDashboardWidgets();
    const whiteboards = widgets.find((w) => w.kind === 'whiteboards');
    expect(whiteboards).toBeDefined();
    expect(whiteboards?.titleKey).toBe('entity.whiteboards.widget.title');
    expect(whiteboards?.order).toBe(800);
    expect(typeof whiteboards?.renderer).toBe('function');
  });

  it('renders after every existing widget when the full set is registered', () => {
    // `order` sort wins: Companies=100, Contacts=200, Calendar=300,
    // Todos=400, RecentRuns=500, RecentChats=600, Proposals=700,
    // Whiteboards=800. The whiteboards widget must come last so the
    // existing widgets stay visually stable.
    const noop = (): null => null;
    registerWidget({
      kind: 'whiteboards',
      titleKey: 'entity.whiteboards.widget.title',
      renderer: noop,
      order: 800,
    });
    registerWidget({ kind: 'proposals', titleKey: 't', renderer: noop, order: 700 });
    registerWidget({ kind: 'recent-chats', titleKey: 't', renderer: noop, order: 600 });
    registerWidget({ kind: 'recent-runs', titleKey: 't', renderer: noop, order: 500 });
    registerWidget({ kind: 'todos', titleKey: 't', renderer: noop, order: 400 });
    registerWidget({ kind: 'calendar', titleKey: 't', renderer: noop, order: 300 });
    registerWidget({ kind: 'contacts', titleKey: 't', renderer: noop, order: 200 });
    registerWidget({ kind: 'companies', titleKey: 't', renderer: noop, order: 100 });
    const order = listDashboardWidgets().map((w) => w.kind);
    expect(order).toEqual([
      'companies',
      'contacts',
      'calendar',
      'todos',
      'recent-runs',
      'recent-chats',
      'proposals',
      'whiteboards',
    ]);
  });
});
