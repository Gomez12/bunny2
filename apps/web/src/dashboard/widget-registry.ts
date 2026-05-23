import type { ComponentType } from 'react';

/**
 * Phase 4a.4 — minimal client-side widget registry.
 *
 * Phase 3.5 shipped the dashboard route + the `layer_dashboard_widgets`
 * SQL table but no client-side mechanism for actually rendering
 * widgets — the dashboard rendered the "no widgets yet" empty state
 * unconditionally. 4a.4 introduces the smallest surface that lets each
 * per-kind sub-phase (companies here, contacts in 4b.4, calendar in
 * 4c.4, todos in 4d.4) declare a widget without modifying the
 * dashboard page itself.
 *
 * Registration is a side effect on import: each widget module calls
 * `registerWidget({ ... })` at module-evaluation time, and the
 * dashboard imports the barrel so every registered widget shows up.
 *
 * The registry is intentionally NOT backed by `layer_dashboard_widgets`
 * yet. Phase 3 seeds no rows, so reading the table would always give
 * the empty set; persisted layout / position / per-layer toggling is a
 * follow-up. Until then the dashboard renders the entire registry on
 * every layer in a deterministic order (lower `order` wins, ties broken
 * by registration order).
 */

export interface WidgetProps {
  readonly layerSlug: string;
}

export interface DashboardWidget {
  readonly kind: string;
  readonly titleKey: string;
  readonly renderer: ComponentType<WidgetProps>;
  /**
   * Lower numbers render earlier. Same number → registration order.
   * No widget should rely on a specific neighbour's number; this is a
   * stable sort key, not a layout coordinate.
   */
  readonly order: number;
}

const widgets = new Map<string, DashboardWidget>();
const order: string[] = [];

export function registerWidget(widget: DashboardWidget): void {
  if (widgets.has(widget.kind)) return;
  widgets.set(widget.kind, widget);
  order.push(widget.kind);
}

export function listDashboardWidgets(): readonly DashboardWidget[] {
  return order
    .map((k) => {
      const w = widgets.get(k);
      if (w === undefined) throw new Error(`widget-registry: missing widget ${k}`);
      return w;
    })
    .sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      return order.indexOf(a.kind) - order.indexOf(b.kind);
    });
}

/** Test-only escape hatch. Never call from production code. */
export function __resetDashboardWidgetsForTests(): void {
  widgets.clear();
  order.length = 0;
}
