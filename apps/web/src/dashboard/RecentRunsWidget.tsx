import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { listRecentScheduledRuns } from '../lib/api';
import type { ScheduledTaskRecentRun } from '../lib/api-types';
import { errorKeyOf } from '../lib/errors';
import { runStatusLabelKey, triggerLabelKey } from '../pages/scheduled-tasks-page-state';
import { registerWidget, type WidgetProps } from './widget-registry';

/**
 * Phase 5.6 — "Recent runs" dashboard widget.
 *
 * Plan §15 open question #3 — "Dashboard widget format: cross-task
 * list of the last 10 runs in the current layer, or per-task compact
 * strip?". **Decision: cross-task list.** Rationale:
 *
 *  - At the dashboard level the user wants a single timeline of
 *    "what just happened in this layer", not per-task health blocks
 *    (the per-layer list page already serves the per-task view).
 *  - A cross-task list scales with the registry size — a per-task
 *    strip would balloon the widget vertically once a layer
 *    accumulates dozens of system + per-handler jobs.
 *  - Server-side support exists as a single endpoint
 *    (`GET /l/:slug/scheduled-tasks/_recent-runs`) added in 5.6 —
 *    one round-trip, ten rows, no N+1.
 *
 * Mirrors the four phase-4 widgets (Companies, Contacts, Calendar,
 * Todos): loading / error / empty / ready branches, `aria-live`
 * announcements on async state, a CTA linking out to the full list.
 */
type WidgetState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly runs: readonly ScheduledTaskRecentRun[] };

export function RecentRunsWidget({ layerSlug }: WidgetProps): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<WidgetState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    listRecentScheduledRuns(layerSlug, 10)
      .then((runs) => {
        if (!cancelled) setState({ kind: 'ready', runs });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', errorKey: errorKeyOf(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [layerSlug]);

  const titleId = `recent-runs-title-${layerSlug}`;
  const tasksHref = `/l/${layerSlug}/scheduled-tasks`;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId}>{t('layer.dashboard.widgets.recentRuns.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('layer.dashboard.widgets.recentRuns.loading')}
          </div>
        ) : null}
        {state.kind === 'error' ? (
          <div role="alert" className="text-sm text-destructive">
            {t('layer.dashboard.widgets.recentRuns.error')}
            <span className="sr-only">{` (${state.errorKey})`}</span>
          </div>
        ) : null}
        {state.kind === 'ready' && state.runs.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {t('layer.dashboard.widgets.recentRuns.empty')}
            </p>
            <Button asChild size="sm" type="button">
              <Link to={tasksHref}>{t('layer.dashboard.widgets.recentRuns.viewAllCta')}</Link>
            </Button>
          </div>
        ) : null}
        {state.kind === 'ready' && state.runs.length > 0 ? (
          <div className="space-y-3">
            <ul className="space-y-1 text-sm">
              {state.runs.map((run) => (
                <li
                  key={run.id}
                  className="flex flex-wrap items-center justify-between gap-2 border-b py-1 last:border-0"
                >
                  <Link
                    to={tasksHref}
                    className="font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {run.taskName}
                  </Link>
                  <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
                    {t(runStatusLabelKey(run.status))}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {run.finishedAt ?? run.requestedAt}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t(triggerLabelKey(run.triggeredBy))}
                  </span>
                </li>
              ))}
            </ul>
            <div>
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={tasksHref}>{t('layer.dashboard.widgets.recentRuns.viewAllCta')}</Link>
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// Side-effect registration on module evaluation; same pattern as the
// four phase-4 widgets. `order: 500` places this widget last (after
// Companies=100, Contacts=200, Calendar=300, Todos=400).
registerWidget({
  kind: 'recent-runs',
  titleKey: 'layer.dashboard.widgets.recentRuns.title',
  renderer: RecentRunsWidget,
  order: 500,
});
