import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { AdminPageShell } from '../../components/admin/AdminPageShell';
import { Button } from '../../components/ui/button';
import { listAdminScheduledTasks } from '../../lib/api';
import type { AdminScheduledTaskRow } from '../../lib/api-types';
import { errorKeyOf } from '../../lib/errors';
import { statusLabelKey } from '../scheduled-tasks-page-state';

/**
 * Phase 5.6 — `/admin/scheduled-tasks`.
 *
 * Cross-layer read-only audit surface. Plan §4.1 row 5.6 keeps the
 * admin view non-mutating: edits route through the per-layer page,
 * where an admin already passes `canEditLayer` for the `everyone`
 * layer (system jobs) and for every project layer they belong to.
 *
 * Mirrors `AdminUsersPage` / `AdminGroupsPage` shape: title + table.
 * `layerSlug` column links straight to the corresponding per-layer
 * list page so the admin can perform the edit one click away.
 */
export function AdminScheduledTasksPage(): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'error'; readonly errorKey: string }
    | { readonly kind: 'ready'; readonly tasks: readonly AdminScheduledTaskRow[] }
  >({ kind: 'loading' });

  const refresh = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const tasks = await listAdminScheduledTasks();
      setState({ kind: 'ready', tasks });
    } catch (err: unknown) {
      setState({ kind: 'error', errorKey: errorKeyOf(err) });
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AdminPageShell
      title={t('admin.scheduledTasks.title')}
      actions={
        <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
          {t('scheduledTasks.list.refresh')}
        </Button>
      }
    >
      {state.kind === 'loading' ? (
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          {t('common.loading')}
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p role="alert" className="text-sm text-destructive">
          {t(state.errorKey, { defaultValue: t('errors.network') })}
        </p>
      ) : null}
      {state.kind === 'ready' && state.tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('admin.scheduledTasks.empty')}</p>
      ) : null}
      {state.kind === 'ready' && state.tasks.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.scheduledTasks.columns.name')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.scheduledTasks.columns.layer')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.scheduledTasks.columns.kind')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.scheduledTasks.columns.schedule')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.scheduledTasks.columns.nextRun')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.scheduledTasks.columns.lastRun')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  {t('admin.scheduledTasks.columns.status')}
                </th>
                <th scope="col" className="px-2 py-2 font-medium">
                  <span className="sr-only">{t('admin.scheduledTasks.columns.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {state.tasks.map((task) => (
                <tr key={task.id} className="border-b last:border-0">
                  <td className="px-2 py-2 font-medium">{task.name}</td>
                  <td className="px-2 py-2 text-xs">
                    {task.layerSlug.length > 0 ? (
                      <Link
                        to={`/l/${task.layerSlug}/scheduled-tasks`}
                        className="font-mono underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {task.layerSlug}
                      </Link>
                    ) : (
                      <span className="font-mono text-muted-foreground">{task.layerId}</span>
                    )}
                  </td>
                  <td className="px-2 py-2 font-mono text-xs text-muted-foreground">{task.kind}</td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">
                    {task.schedule.kind === 'cron'
                      ? t('scheduledTasks.schedule.cron', {
                          expression: task.schedule.cronExpression,
                          timezone: task.schedule.cronTimezone,
                        })
                      : t('scheduledTasks.schedule.interval', {
                          minutes: task.schedule.intervalMinutes,
                        })}
                  </td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">{task.nextRunAt}</td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">
                    {task.lastRunAt ?? t('scheduledTasks.list.lastRunNever')}
                  </td>
                  <td className="px-2 py-2">
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs">
                      {t(statusLabelKey(task.status))}
                    </span>
                  </td>
                  <td className="px-2 py-2 text-right">
                    <Link
                      to={`/admin/scheduled-tasks/${encodeURIComponent(task.id)}/runs`}
                      className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {t('admin.scheduledTasks.action.runs')}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </AdminPageShell>
  );
}
