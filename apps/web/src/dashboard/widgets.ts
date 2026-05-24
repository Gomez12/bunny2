/**
 * Phase 4a.4 — barrel that imports every widget module for its
 * registration side effect. `LayerDashboardPage` imports this barrel
 * once; every per-kind sub-phase (contacts in 4b.4, calendar in 4c.4,
 * todos in 4d.4) adds a single line here.
 */
import './CompaniesWidget';
import './ContactsWidget';
import './CalendarWidget';

export { listDashboardWidgets, type DashboardWidget, type WidgetProps } from './widget-registry';
