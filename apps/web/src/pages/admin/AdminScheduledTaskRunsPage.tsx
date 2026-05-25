/**
 * Phase 4 (ui-exposure-gaps) — `/admin/scheduled-tasks/:taskId/runs`.
 *
 * Cross-layer per-task runs drilldown. Reachable from each row of
 * `AdminScheduledTasksPage`. Read-only — no telemetry, no analytics
 * (plan §5 Phase 4: pure read view, admin-only diagnostics).
 *
 * The runs endpoint returns runs only; we also call
 * `listAdminScheduledTasks()` to recover the task name + owning
 * layer slug so the page can show a useful title and a deep-link
 * back into the per-layer page. The task lookup is tolerated if it
 * fails — the runs table still renders.
 *
 * a11y per plan §9: column headers, expandable row via a button
 * (not row click), focus returns to the trigger on collapse.
 */
import { Fragment, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AdminPageShell } from '../../components/admin/AdminPageShell';
import { Button } from '../../components/ui/button';
import { listAdminScheduledTaskRuns, listAdminScheduledTasks } from '../../lib/api';
import type { AdminScheduledTaskRow } from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';
import { runStatusLabelKey, triggerLabelKey } from '../scheduled-tasks-page-state';
import {
  adminScheduledTaskRunsView,
  runDetailsJson,
  toggleExpandedRun,
  type AdminScheduledTaskRunsInput,
} from './admin-scheduled-task-runs-page-state';

export function AdminScheduledTaskRunsPage(): JSX.Element {
  const { t } = useTranslation();
  const { taskId } = useParams<{ readonly taskId: string }>();
  const navigate = useNavigate();
  const [input, setInput] = useState<AdminScheduledTaskRunsInput>({ status: 'loading' });
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());

  const refresh = useCallback(async (): Promise<void> => {
    if (taskId === undefined || taskId === '') {
      setInput({ status: 'error', errorKey: 'errors.network' });
      return;
    }
    setInput({ status: 'loading' });
    try {
      const [runs, tasks] = await Promise.all([
        listAdminScheduledTaskRuns(taskId),
        // Best-effort: the task lookup is not load-bearing. If the
        // admin tasks list fails, we still render the runs table with
        // an unknown-task header.
        listAdminScheduledTasks().catch(
          (): readonly AdminScheduledTaskRow[] => [] as readonly AdminScheduledTaskRow[],
        ),
      ]);
      const task = tasks.find((row) => row.id === taskId) ?? null;
      setInput({ status: 'ready', runs, task });
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [taskId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const view = adminScheduledTaskRunsView(input);

  function toggle(runId: string): void {
    setExpanded((prev) => toggleExpandedRun(prev, runId));
  }

  const title = (): string => {
    if (view.kind === 'ready' || view.kind === 'empty') {
      if (view.task !== null) {
        return t('admin.scheduledTasks.runs.title', { name: view.task.name });
      }
    }
    return t('admin.scheduledTasks.runs.titlePlaceholder');
  };

  return (
    <AdminPageShell
      title={title()}
      back={{
        label: t('admin.scheduledTasks.runs.back'),
        onBack: () => navigate('/admin/scheduled-tasks'),
      }}
      actions={
        <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
          {t('scheduledTasks.list.refresh')}
        </Button>
      }
    >
      {view.kind === 'loading' ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : null}

      {view.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t(view.errorKey, { defaultValue: t('errors.network') })}
        </p>
      ) : null}

      {view.kind === 'empty' ? (
        <div className="space-y-3">
          {view.task !== null && view.task.layerSlug.length > 0 ? (
            <p className="text-sm">
              <Link
                to={`/l/${view.task.layerSlug}/scheduled-tasks`}
                className="font-mono underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('admin.scheduledTasks.runs.openInLayer', { slug: view.task.layerSlug })}
              </Link>
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">{t('admin.scheduledTasks.runs.empty')}</p>
        </div>
      ) : null}

      {view.kind === 'ready' ? (
        <div className="space-y-3">
          {view.task !== null && view.task.layerSlug.length > 0 ? (
            <p className="text-sm">
              <Link
                to={`/l/${view.task.layerSlug}/scheduled-tasks`}
                className="font-mono underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t('admin.scheduledTasks.runs.openInLayer', { slug: view.task.layerSlug })}
              </Link>
            </p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left">
                  <th scope="col" className="px-2 py-2 font-medium">
                    {t('admin.scheduledTasks.runs.columns.requestedAt')}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    {t('admin.scheduledTasks.runs.columns.status')}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    {t('admin.scheduledTasks.runs.columns.trigger')}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    {t('admin.scheduledTasks.runs.columns.attempt')}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    {t('admin.scheduledTasks.runs.columns.duration')}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    {t('admin.scheduledTasks.runs.columns.error')}
                  </th>
                  <th scope="col" className="px-2 py-2 font-medium">
                    <span className="sr-only">
                      {t('admin.scheduledTasks.runs.columns.details')}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {view.runs.map((run) => {
                  const isOpen = expanded.has(run.id);
                  return (
                    <Fragment key={run.id}>
                      <tr className="border-b last:border-0">
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {run.requestedAt}
                        </td>
                        <td className="px-2 py-2">
                          <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
                            {t(runStatusLabelKey(run.status))}
                          </span>
                        </td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {t(triggerLabelKey(run.triggeredBy))}
                        </td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">{run.attempt}</td>
                        <td className="px-2 py-2 text-xs text-muted-foreground">
                          {run.durationMs === null
                            ? t('admin.scheduledTasks.runs.durationPending')
                            : t('admin.scheduledTasks.runs.durationMs', { ms: run.durationMs })}
                        </td>
                        <td className="px-2 py-2 text-xs text-destructive">
                          {run.error !== null ? run.error : ''}
                        </td>
                        <td className="px-2 py-2 text-right">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            aria-expanded={isOpen}
                            aria-controls={`run-${run.id}-details`}
                            onClick={() => toggle(run.id)}
                          >
                            {isOpen
                              ? t('admin.scheduledTasks.runs.collapse')
                              : t('admin.scheduledTasks.runs.expand')}
                          </Button>
                        </td>
                      </tr>
                      {isOpen ? (
                        <tr className="border-b last:border-0 bg-muted/40">
                          <td colSpan={7} className="px-2 py-2">
                            <pre
                              id={`run-${run.id}-details`}
                              className="overflow-x-auto rounded-md bg-background p-3 text-xs"
                            >
                              {JSON.stringify(runDetailsJson(run), null, 2)}
                            </pre>
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </AdminPageShell>
  );
}
