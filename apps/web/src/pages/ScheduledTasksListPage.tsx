import { Fragment, useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog, Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import {
  createScheduledTask,
  deleteScheduledTask,
  listScheduledTaskKinds,
  listScheduledTaskRuns,
  listScheduledTasks,
  pauseScheduledTask,
  resumeScheduledTask,
  runScheduledTaskNow,
} from '../lib/api';
import type {
  ScheduledTaskHandlerInfo,
  ScheduledTaskRunSummary,
  ScheduledTaskSummary,
} from '../lib/api-types';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  buildCreateScheduledTaskRequest,
  emptyScheduledTaskFormDraft,
  runStatusLabelKey,
  scheduledTasksListView,
  slugifyScheduledTaskName,
  statusLabelKey,
  triggerLabelKey,
  validateScheduledTaskForm,
  type ScheduledTaskFormDraft,
  type ScheduledTasksListInput,
} from './scheduled-tasks-page-state';

/**
 * `/l/:layerSlug/scheduled-tasks` — phase 5.6.
 *
 * Mirrors the contacts / todos / calendar list pages: header with a
 * create CTA, table body, expandable-row run history, action buttons
 * (Pause/Resume/Run-now/Delete). The create dialog mounts on demand.
 *
 * Authorization shape:
 *  - Anyone in the layer's effective set can READ (list + per-task runs).
 *  - `useCurrentLayer().canEdit` gates the edit affordances client-side.
 *    The server still re-checks every mutation; on 403 we surface the
 *    server's localized error key. This matches the pattern in
 *    `LayerSettingsPage` where edit controls render disabled rather
 *    than hidden so the surface stays discoverable (§4.1 of the
 *    phase-03 plan).
 *
 * Run history (plan §4.1 row 5.6, item D): each row toggles an
 * expandable panel that lazily fetches `GET .../runs?limit=50`. This
 * mirrors the entity detail pages' "tabs that fetch on first open"
 * pattern and avoids an N+1 on the initial list load.
 */
export function ScheduledTasksListPage(): JSX.Element {
  const { t } = useTranslation();
  const current = useCurrentLayer();
  const [input, setInput] = useState<ScheduledTasksListInput>({ status: 'loading' });
  const [kinds, setKinds] = useState<readonly ScheduledTaskHandlerInfo[]>([]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<ScheduledTaskSummary | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const tasks = await listScheduledTasks(layerSlug);
      setInput({ status: 'ready', tasks });
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Kinds are needed only for the create dialog; fetch once when the
  // page mounts so opening the dialog feels instant. Failures here are
  // non-fatal — the dropdown will show as empty and the user sees the
  // validation error.
  useEffect(() => {
    if (layerSlug === null) return;
    let cancelled = false;
    void (async () => {
      try {
        const items = await listScheduledTaskKinds(layerSlug);
        if (!cancelled) setKinds(items);
      } catch {
        // intentionally swallowed; the dialog tolerates an empty list
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [layerSlug]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const { layer, canEdit } = current;
  const view = scheduledTasksListView(input);

  async function handleRunNow(task: ScheduledTaskSummary): Promise<void> {
    if (layerSlug === null || busySlug !== null) return;
    setBusySlug(task.slug);
    try {
      await runScheduledTaskNow(layerSlug, task.slug);
      pushToast({ kind: 'success', message: t('scheduledTasks.toast.runQueued') });
      // Auto-refresh after 2s so the most recent run lands in the
      // history panel without a manual click. The user can also press
      // the page-level Refresh button.
      window.setTimeout(() => void refresh(), 2000);
    } catch (err: unknown) {
      pushToast({ kind: 'error', message: t(errorKeyOf(err)) });
    } finally {
      setBusySlug(null);
    }
  }

  async function handleTogglePause(task: ScheduledTaskSummary): Promise<void> {
    if (layerSlug === null || busySlug !== null) return;
    setBusySlug(task.slug);
    try {
      if (task.status === 'paused') {
        await resumeScheduledTask(layerSlug, task.slug);
        pushToast({ kind: 'success', message: t('scheduledTasks.toast.resumed') });
      } else {
        await pauseScheduledTask(layerSlug, task.slug);
        pushToast({ kind: 'success', message: t('scheduledTasks.toast.paused') });
      }
      await refresh();
    } catch (err: unknown) {
      pushToast({ kind: 'error', message: t(errorKeyOf(err)) });
    } finally {
      setBusySlug(null);
    }
  }

  async function handleConfirmDelete(): Promise<void> {
    if (layerSlug === null || deleteTarget === null) return;
    setDeleteError(null);
    setBusySlug(deleteTarget.slug);
    try {
      await deleteScheduledTask(layerSlug, deleteTarget.slug);
      pushToast({ kind: 'success', message: t('scheduledTasks.toast.deleted') });
      setDeleteTarget(null);
      await refresh();
    } catch (err: unknown) {
      setDeleteError(errorKeyOf(err));
    } finally {
      setBusySlug(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>{t('scheduledTasks.list.title', { name: layer.name })}</CardTitle>
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => void refresh()}>
              {t('scheduledTasks.list.refresh')}
            </Button>
            <Button type="button" disabled={!canEdit} onClick={() => setDialogOpen(true)}>
              {t('scheduledTasks.list.createCta')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {view.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('scheduledTasks.list.loading')}
            </p>
          ) : null}
          {view.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(view.errorKey, { defaultValue: t('scheduledTasks.list.error') })}
            </p>
          ) : null}
          {view.kind === 'empty' ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">{t('scheduledTasks.list.empty')}</p>
              <Button type="button" disabled={!canEdit} onClick={() => setDialogOpen(true)}>
                {t('scheduledTasks.list.createCta')}
              </Button>
            </div>
          ) : null}
          {view.kind === 'ready' ? (
            <ScheduledTasksTable
              layerSlug={layer.slug}
              canEdit={canEdit}
              tasks={view.tasks}
              busySlug={busySlug}
              onRunNow={(task) => void handleRunNow(task)}
              onTogglePause={(task) => void handleTogglePause(task)}
              onDelete={(task) => {
                setDeleteError(null);
                setDeleteTarget(task);
              }}
            />
          ) : null}
        </CardContent>
      </Card>

      {dialogOpen ? (
        <CreateScheduledTaskDialog
          layerSlug={layer.slug}
          kinds={kinds}
          onClose={() => setDialogOpen(false)}
          onCreated={async () => {
            setDialogOpen(false);
            pushToast({ kind: 'success', message: t('scheduledTasks.toast.created') });
            await refresh();
          }}
        />
      ) : null}

      {deleteTarget !== null ? (
        <ConfirmDialog
          open
          title={t('scheduledTasks.deleteConfirm.title')}
          body={t('scheduledTasks.deleteConfirm.body', { name: deleteTarget.name })}
          confirmLabel={t('scheduledTasks.deleteConfirm.cta')}
          destructive
          busy={busySlug === deleteTarget.slug}
          errorKey={deleteError}
          onConfirm={() => void handleConfirmDelete()}
          onClose={() => {
            if (busySlug !== null) return;
            setDeleteTarget(null);
            setDeleteError(null);
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ScheduledTasksTableProps {
  readonly layerSlug: string;
  readonly canEdit: boolean;
  readonly tasks: readonly ScheduledTaskSummary[];
  readonly busySlug: string | null;
  readonly onRunNow: (task: ScheduledTaskSummary) => void;
  readonly onTogglePause: (task: ScheduledTaskSummary) => void;
  readonly onDelete: (task: ScheduledTaskSummary) => void;
}

function ScheduledTasksTable(props: ScheduledTasksTableProps): JSX.Element {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState<string | null>(null);

  function toggleExpand(slug: string): void {
    setExpanded((prev) => (prev === slug ? null : slug));
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="px-2 py-2 font-medium">
              {t('scheduledTasks.list.columns.name')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('scheduledTasks.list.columns.kind')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('scheduledTasks.list.columns.schedule')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('scheduledTasks.list.columns.nextRun')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('scheduledTasks.list.columns.lastRun')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('scheduledTasks.list.columns.status')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('scheduledTasks.list.columns.actions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {props.tasks.map((task) => {
            const isExpanded = expanded === task.slug;
            const busy = props.busySlug === task.slug;
            const isPaused = task.status === 'paused';
            return (
              <Fragment key={task.id}>
                <tr className="border-b">
                  <td className="px-2 py-2 font-medium">
                    <button
                      type="button"
                      onClick={() => toggleExpand(task.slug)}
                      aria-expanded={isExpanded}
                      aria-controls={`task-runs-${task.id}`}
                      className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {task.name}
                    </button>
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
                  <td className="px-2 py-2">
                    <div className="flex flex-wrap gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={!props.canEdit || busy}
                        onClick={() => props.onRunNow(task)}
                      >
                        {t('scheduledTasks.actions.runNow')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={!props.canEdit || busy}
                        onClick={() => props.onTogglePause(task)}
                      >
                        {isPaused
                          ? t('scheduledTasks.actions.resume')
                          : t('scheduledTasks.actions.pause')}
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        disabled={!props.canEdit || busy}
                        onClick={() => props.onDelete(task)}
                      >
                        {t('scheduledTasks.actions.delete')}
                      </Button>
                    </div>
                  </td>
                </tr>
                {isExpanded ? (
                  <tr className="border-b">
                    <td colSpan={7} className="bg-muted/30 px-2 py-3">
                      <ScheduledTaskRunsPanel
                        layerSlug={props.layerSlug}
                        taskSlug={task.slug}
                        domId={`task-runs-${task.id}`}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface ScheduledTaskRunsPanelProps {
  readonly layerSlug: string;
  readonly taskSlug: string;
  readonly domId: string;
}

function ScheduledTaskRunsPanel(props: ScheduledTaskRunsPanelProps): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<
    | { readonly kind: 'loading' }
    | { readonly kind: 'error'; readonly errorKey: string }
    | { readonly kind: 'ready'; readonly runs: readonly ScheduledTaskRunSummary[] }
  >({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    listScheduledTaskRuns(props.layerSlug, props.taskSlug, 50)
      .then((runs) => {
        if (!cancelled) setState({ kind: 'ready', runs });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', errorKey: errorKeyOf(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [props.layerSlug, props.taskSlug]);

  return (
    <div id={props.domId} className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t('scheduledTasks.list.runsTitle')}
      </h3>
      {state.kind === 'loading' ? (
        <p role="status" aria-live="polite" className="text-xs text-muted-foreground">
          {t('scheduledTasks.list.runsLoading')}
        </p>
      ) : null}
      {state.kind === 'error' ? (
        <p role="alert" className="text-xs text-destructive">
          {t(state.errorKey, { defaultValue: t('scheduledTasks.list.runsError') })}
        </p>
      ) : null}
      {state.kind === 'ready' && state.runs.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('scheduledTasks.list.runsEmpty')}</p>
      ) : null}
      {state.kind === 'ready' && state.runs.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('scheduledTasks.list.runsColumns.status')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('scheduledTasks.list.runsColumns.started')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('scheduledTasks.list.runsColumns.duration')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('scheduledTasks.list.runsColumns.triggeredBy')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('scheduledTasks.list.runsColumns.attempt')}
                </th>
                <th scope="col" className="px-2 py-1 font-medium">
                  {t('scheduledTasks.list.runsColumns.error')}
                </th>
              </tr>
            </thead>
            <tbody>
              {state.runs.map((run) => (
                <tr key={run.id} className="border-b last:border-0">
                  <td className="px-2 py-1">
                    <span className="inline-flex items-center rounded-full border px-2 py-0.5">
                      {t(runStatusLabelKey(run.status))}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {run.startedAt ?? run.requestedAt}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {run.durationMs !== null
                      ? t('scheduledTasks.list.durationMs', { ms: run.durationMs })
                      : ''}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">
                    {t(triggerLabelKey(run.triggeredBy))}
                  </td>
                  <td className="px-2 py-1 text-muted-foreground">{run.attempt}</td>
                  <td className="px-2 py-1 text-muted-foreground" title={run.error ?? ''}>
                    {run.error !== null && run.error.length > 80
                      ? `${run.error.slice(0, 80)}…`
                      : (run.error ?? '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CreateScheduledTaskDialogProps {
  readonly layerSlug: string;
  readonly kinds: readonly ScheduledTaskHandlerInfo[];
  readonly onClose: () => void;
  readonly onCreated: () => Promise<void>;
}

function CreateScheduledTaskDialog(props: CreateScheduledTaskDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<ScheduledTaskFormDraft>(() => emptyScheduledTaskFormDraft());
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  function setField<K extends keyof ScheduledTaskFormDraft>(
    key: K,
    value: ScheduledTaskFormDraft[K],
  ): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleNameChange(value: string): void {
    setDraft((prev) => ({
      ...prev,
      name: value,
      slug: slugTouched ? prev.slug : slugifyScheduledTaskName(value),
    }));
  }

  function handleKindChange(kind: string): void {
    // When the picked handler advertises a `defaultSchedule`, pre-fill
    // the schedule fields. Resolves plan §15 #1 — surfaces the hint
    // the registry already carries.
    const meta = props.kinds.find((k) => k.kind === kind);
    if (meta?.defaultSchedule === undefined) {
      setField('kind', kind);
      return;
    }
    setDraft((prev) => {
      const next = { ...prev, kind };
      if (meta.defaultSchedule!.kind === 'cron') {
        next.scheduleKind = 'cron';
        next.cronExpression = meta.defaultSchedule!.cronExpression;
        next.cronTimezone = meta.defaultSchedule!.cronTimezone;
      } else {
        next.scheduleKind = 'interval';
        next.intervalMinutes = String(meta.defaultSchedule!.intervalMinutes);
      }
      return next;
    });
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    const validation = validateScheduledTaskForm(draft);
    if (validation !== null) {
      setErrorKey(validation);
      return;
    }
    setPending(true);
    try {
      const body = buildCreateScheduledTaskRequest(draft);
      await createScheduledTask(props.layerSlug, body);
      await props.onCreated();
    } catch (err: unknown) {
      setErrorKey(errorKeyOf(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open
      onClose={props.onClose}
      title={t('scheduledTasks.dialog.title')}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="sched-name">{t('scheduledTasks.dialog.nameLabel')}</Label>
          <Input
            id="sched-name"
            value={draft.name}
            onChange={(e) => handleNameChange(e.target.value)}
            disabled={pending}
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="sched-slug">{t('scheduledTasks.dialog.slugLabel')}</Label>
          <Input
            id="sched-slug"
            value={draft.slug}
            onChange={(e) => {
              setField('slug', e.target.value);
              setSlugTouched(true);
            }}
            disabled={pending}
            autoComplete="off"
            aria-describedby="sched-slug-hint"
          />
          <p id="sched-slug-hint" className="text-xs text-muted-foreground">
            {t('scheduledTasks.dialog.slugHint')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="sched-kind">{t('scheduledTasks.dialog.kindLabel')}</Label>
          <select
            id="sched-kind"
            className="block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            value={draft.kind}
            onChange={(e) => handleKindChange(e.target.value)}
            disabled={pending}
            required
          >
            <option value="">{t('scheduledTasks.dialog.kindPlaceholder')}</option>
            {props.kinds.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.kind}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="space-y-2" disabled={pending}>
          <legend className="text-sm font-medium">
            {t('scheduledTasks.list.columns.schedule')}
          </legend>
          <div className="flex gap-1" role="group">
            <Button
              type="button"
              size="sm"
              variant={draft.scheduleKind === 'cron' ? 'default' : 'ghost'}
              aria-pressed={draft.scheduleKind === 'cron'}
              onClick={() => setField('scheduleKind', 'cron')}
            >
              {t('scheduledTasks.dialog.scheduleKindCron')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant={draft.scheduleKind === 'interval' ? 'default' : 'ghost'}
              aria-pressed={draft.scheduleKind === 'interval'}
              onClick={() => setField('scheduleKind', 'interval')}
            >
              {t('scheduledTasks.dialog.scheduleKindInterval')}
            </Button>
          </div>
          {draft.scheduleKind === 'cron' ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="sched-cron-expr">{t('scheduledTasks.dialog.cronExpression')}</Label>
                <Input
                  id="sched-cron-expr"
                  value={draft.cronExpression}
                  onChange={(e) => setField('cronExpression', e.target.value)}
                  disabled={pending}
                  autoComplete="off"
                  aria-describedby="sched-cron-hint"
                />
                <p id="sched-cron-hint" className="text-xs text-muted-foreground">
                  {t('scheduledTasks.dialog.cronExpressionHint')}
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="sched-cron-tz">{t('scheduledTasks.dialog.cronTimezone')}</Label>
                <Input
                  id="sched-cron-tz"
                  value={draft.cronTimezone}
                  onChange={(e) => setField('cronTimezone', e.target.value)}
                  disabled={pending}
                  autoComplete="off"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="sched-interval">{t('scheduledTasks.dialog.intervalMinutes')}</Label>
              <Input
                id="sched-interval"
                type="number"
                min={1}
                value={draft.intervalMinutes}
                onChange={(e) => setField('intervalMinutes', e.target.value)}
                disabled={pending}
              />
            </div>
          )}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="sched-max-attempts">{t('scheduledTasks.dialog.maxAttempts')}</Label>
            <Input
              id="sched-max-attempts"
              type="number"
              min={1}
              value={draft.maxAttempts}
              onChange={(e) => setField('maxAttempts', e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sched-backoff-base">{t('scheduledTasks.dialog.backoffBaseMs')}</Label>
            <Input
              id="sched-backoff-base"
              type="number"
              min={1}
              value={draft.backoffBaseMs}
              onChange={(e) => setField('backoffBaseMs', e.target.value)}
              disabled={pending}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="sched-backoff-max">{t('scheduledTasks.dialog.backoffMaxMs')}</Label>
            <Input
              id="sched-backoff-max"
              type="number"
              min={1}
              value={draft.backoffMaxMs}
              onChange={(e) => setField('backoffMaxMs', e.target.value)}
              disabled={pending}
            />
          </div>
        </div>
        {errorKey !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(errorKey, { defaultValue: t('errors.scheduledTasks.badRequest') })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={pending}>
            {t('scheduledTasks.dialog.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('scheduledTasks.dialog.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
