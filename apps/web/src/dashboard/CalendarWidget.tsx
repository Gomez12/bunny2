import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { getCalendarEventStats, type CalendarEventStatsResponse } from '../lib/api';
import { errorKeyOf } from '../lib/errors';
import { calendarWidgetView, type CalendarWidgetInput } from './calendar-widget-state';
import { registerWidget, type WidgetProps } from './widget-registry';

/**
 * Phase 4c.4 — Calendar dashboard widget.
 *
 * Third consumer of the §4a.4 `statsProvider` slot. Reads aggregate
 * stats from `GET /l/:slug/calendar_event/_stats`. The endpoint lives
 * behind the generic entity router (singular `/calendar_event` segment
 * per the §4.0 router naming); the widget's "View calendar" CTA links
 * to the friendlier plural-segment page that lands in 4c.5. "New event"
 * targets the same plural-segment URL with a `/new` suffix — both
 * routes are placeholders until 4c.5 mounts the actual calendar grid.
 *
 * Loading / empty / error / ready branches are projected by the pure
 * reducer in `./calendar-widget-state.ts` so the matrix is testable
 * without a DOM runtime (see `apps/web/tests/calendar-widget.test.ts`).
 *
 * Accessibility:
 *  - The card uses `<section>` semantics via `role="region"` + a
 *    labelled heading hookup (`aria-labelledby`).
 *  - The loading branch sets `role="status" aria-live="polite"`.
 *  - The error branch sets `role="alert"`.
 *  - Every stat line uses `<dt>` / `<dd>` so screen readers announce
 *    the label/value pairing.
 *  - Buttons inherit the shared `<Button>` focus ring.
 */
export function CalendarWidget({ layerSlug }: WidgetProps): JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState<CalendarWidgetInput>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setInput({ status: 'loading' });
    getCalendarEventStats(layerSlug)
      .then((stats: CalendarEventStatsResponse) => {
        if (cancelled) return;
        setInput({ status: 'ready', stats });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setInput({ status: 'error', errorKey: errorKeyOf(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [layerSlug]);

  const view = calendarWidgetView(input);
  // The 4c.5 web UI will mount `/l/:slug/calendar` (grid view). Until
  // that ships the link resolves through the App router's 404; the
  // widget never produces a dead link in the loaded-and-ready state
  // because that state implies at least one event already exists in
  // the layer (which today is reachable through the 4c.2 Google
  // connector ingest).
  const viewAllHref = `/l/${layerSlug}/calendar`;
  const newEventHref = `/l/${layerSlug}/calendar/new`;
  const titleId = `calendar-widget-title-${layerSlug}`;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId}>{t('layer.dashboard.widgets.calendar.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {view.kind === 'loading' ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('layer.dashboard.widgets.calendar.loading')}
          </div>
        ) : null}
        {view.kind === 'error' ? (
          <div role="alert" className="text-sm text-destructive">
            {t('layer.dashboard.widgets.calendar.error')}
            <span className="sr-only">{` (${view.errorKey})`}</span>
          </div>
        ) : null}
        {view.kind === 'empty' ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {t('layer.dashboard.widgets.calendar.empty')}
            </p>
            <Button asChild size="sm" type="button">
              <Link to={newEventHref}>{t('layer.dashboard.widgets.calendar.newEventCta')}</Link>
            </Button>
          </div>
        ) : null}
        {view.kind === 'ready' ? (
          <div className="space-y-3">
            <p
              className="text-3xl font-semibold leading-none"
              aria-label={t('layer.dashboard.widgets.calendar.statTotal')}
            >
              {view.stats.total}
            </p>
            <dl className="grid grid-cols-1 gap-1 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.calendar.statUpcoming')}
                </dt>
                <dd className="font-medium">{view.stats.upcomingNext7d}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.calendar.statWithAttendeesLinked')}
                </dt>
                <dd className="font-medium">{view.stats.withAttendeesLinked}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.calendar.statRecentlyEnriched')}
                </dt>
                <dd className="font-medium">{view.stats.recentlyEnriched}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={viewAllHref}>{t('layer.dashboard.widgets.calendar.viewAllCta')}</Link>
              </Button>
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={newEventHref}>{t('layer.dashboard.widgets.calendar.newEventCta')}</Link>
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// Side-effect registration on module evaluation. The dashboard imports
// the barrel `./widgets` once, which imports this file once, which
// performs exactly one registry insertion per process. `order: 300`
// puts the Calendar widget right after Contacts (`order: 200`); the
// 4d.4 Todos widget will pick 400.
registerWidget({
  kind: 'calendar',
  titleKey: 'layer.dashboard.widgets.calendar.title',
  renderer: CalendarWidget,
  order: 300,
});
