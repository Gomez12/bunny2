import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { getTodoStats, type TodoStatsResponse } from '../lib/api';
import { errorKeyOf } from '../lib/errors';
import { todosWidgetView, type TodosWidgetInput } from './todos-widget-state';
import { registerWidget, type WidgetProps } from './widget-registry';

/**
 * Phase 4d.4 — Todos dashboard widget.
 *
 * Fourth consumer of the §4a.4 `statsProvider` slot. Reads aggregate
 * stats from `GET /l/:slug/todo/_stats`. The endpoint lives behind
 * the generic entity router (singular `/todo` segment per the §4.0
 * router naming); the widget's "View todos" CTA links to the
 * friendlier plural-segment page that lands in 4d.5. "New todo"
 * targets the same plural-segment URL with a `/new` suffix — both
 * routes are placeholders until 4d.5 mounts the actual todos list
 * + kanban.
 *
 * Loading / empty / error / ready branches are projected by the pure
 * reducer in `./todos-widget-state.ts` so the matrix is testable
 * without a DOM runtime (see `apps/web/tests/todos-widget.test.ts`).
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
export function TodosWidget({ layerSlug }: WidgetProps): JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState<TodosWidgetInput>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setInput({ status: 'loading' });
    getTodoStats(layerSlug)
      .then((stats: TodoStatsResponse) => {
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

  const view = todosWidgetView(input);
  // The 4d.5 web UI will mount `/l/:slug/todos` (list + simple
  // kanban). Until that ships the link resolves through the App
  // router's 404; the widget never produces a dead link in the
  // loaded-and-ready state because that state implies at least one
  // OPEN todo already exists in the layer.
  const viewAllHref = `/l/${layerSlug}/todos`;
  const newTodoHref = `/l/${layerSlug}/todos/new`;
  const titleId = `todos-widget-title-${layerSlug}`;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId}>{t('layer.dashboard.widgets.todos.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {view.kind === 'loading' ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('layer.dashboard.widgets.todos.loading')}
          </div>
        ) : null}
        {view.kind === 'error' ? (
          <div role="alert" className="text-sm text-destructive">
            {t('layer.dashboard.widgets.todos.error')}
            <span className="sr-only">{` (${view.errorKey})`}</span>
          </div>
        ) : null}
        {view.kind === 'empty' ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {t('layer.dashboard.widgets.todos.empty')}
            </p>
            <Button asChild size="sm" type="button">
              <Link to={newTodoHref}>{t('layer.dashboard.widgets.todos.newTodoCta')}</Link>
            </Button>
          </div>
        ) : null}
        {view.kind === 'ready' ? (
          <div className="space-y-3">
            <p
              className="text-3xl font-semibold leading-none"
              aria-label={t('layer.dashboard.widgets.todos.statTotalOpen')}
            >
              {view.stats.totalOpen}
            </p>
            <dl className="grid grid-cols-1 gap-1 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.todos.statDueToday')}
                </dt>
                <dd className="font-medium">{view.stats.dueToday}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.todos.statOverdue')}
                </dt>
                <dd className="font-medium">{view.stats.overdue}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.todos.statHighPriorityOpen')}
                </dt>
                <dd className="font-medium">{view.stats.highPriorityOpen}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={viewAllHref}>{t('layer.dashboard.widgets.todos.viewAllCta')}</Link>
              </Button>
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={newTodoHref}>{t('layer.dashboard.widgets.todos.newTodoCta')}</Link>
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
// performs exactly one registry insertion per process. `order: 400`
// puts the Todos widget right after Calendar (`order: 300`) —
// Companies = 100, Contacts = 200, Calendar = 300, Todos = 400.
registerWidget({
  kind: 'todos',
  titleKey: 'layer.dashboard.widgets.todos.title',
  renderer: TodosWidget,
  order: 400,
});
