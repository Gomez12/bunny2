import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Dialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { createTodo, getTodo, listTodos, updateTodo } from '../lib/api';
import type { EntitySummary, Todo, TodoStatus } from '../lib/api-types';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import { slugifyTodoTitle, webTodoNewPath, webTodoPath, webTodosPath } from '../lib/todos-routes';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  TODO_STATUS_ORDER,
  applyClientStatusTransition,
  buildCreateTodoRequest,
  buildUpdateTodoRequest,
  draftFromTodo,
  emptyTodoFormDraft,
  groupTodosByStatus,
  kanbanColumnLabelKey,
  priorityLabelKey,
  statusLabelKey,
  todosListView,
  validateTodoForm,
  type TodoFormDraft,
  type TodosListInput,
  type TodosViewMode,
} from './todos-page-state';

/**
 * `/l/:layerSlug/todos` — todos list + simple per-status kanban
 * (phase 4d.5).
 *
 * Fetches `GET /l/:layerSlug/todo` (singular per the §4.0 router; the
 * singular ↔ plural seam lives in
 * `apps/web/src/lib/todos-routes.ts`). The list endpoint returns
 * `EntitySummary[]` which lacks `status` / `priority` / `dueAt` — the
 * kanban grouping needs them, so the page hydrates each summary via
 * `getTodo(...)` in parallel. Same N+1 trade-off as `CalendarPage`;
 * the `summaryColumns` follow-up cited in the 4a.5 close-out tracks
 * the gap.
 *
 * Two view modes are selectable via a button toolbar (no segmented
 * control shadcn primitive in this repo; two buttons with
 * `aria-pressed` match the existing project aesthetic, cf. the
 * email / phone "Primary" toggle on the contact detail page):
 *
 *  - **List view** (default): a table with title / status / priority /
 *    dueAt / linked entity columns. Click the title to navigate to
 *    the detail page.
 *  - **Kanban view**: five columns (Open, In Progress, Blocked, Done,
 *    Cancelled), each listing cards sorted by priority (1 first) then
 *    dueAt. NO drag-and-drop in v1 — the plan §4d.5 calls for a
 *    "simple kanban"; the full Kanban-entity lands later in §6. The
 *    v1 interaction is a status-change `<select>` on each card; the
 *    page calls `updateTodo` and re-fetches the list. The handler
 *    goes through `applyClientStatusTransition` so `completedAt` is
 *    normalized identically to the detail page.
 *
 * "New todo" opens an inline dialog (same pattern as the prior three
 * list pages). The `/l/:layerSlug/todos/new` deep link (used by the
 * 4d.4 dashboard widget) auto-opens the dialog on mount.
 *
 * Accessibility:
 *  - Single `<h1>` via the card title.
 *  - View toggle uses real `<button>` elements with
 *    `aria-pressed={true|false}` so screen readers announce state.
 *  - The table uses `<th scope="col">` headers; rows are
 *    keyboard-navigable via the `<Link>` on the title cell.
 *  - Kanban cards are `<article>` containers wrapping a `<Link>` (the
 *    card-level affordance); the status `<select>` is keyboard-
 *    accessible out of the box.
 *  - Loading: `role="status" aria-live="polite"`; error: `role="alert"`.
 *  - The create dialog inherits the native `<dialog>` focus trap from
 *    `components/ui/dialog.tsx`.
 */
export function TodosPage(): JSX.Element {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentLayer();
  const [input, setInput] = useState<TodosListInput>({ status: 'loading' });
  const [hydrated, setHydrated] = useState<readonly Todo[]>([]);
  const [viewMode, setViewMode] = useState<TodosViewMode>('list');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [kanbanBusySlug, setKanbanBusySlug] = useState<string | null>(null);

  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const summaries = await listTodos(layerSlug);
      setInput({ status: 'ready', todos: summaries });
      const full = await Promise.all(
        summaries.map(async (s) => {
          try {
            return await getTodo(layerSlug, s.slug);
          } catch {
            return null;
          }
        }),
      );
      const items: Todo[] = [];
      for (const todo of full) {
        if (todo !== null) items.push(todo);
      }
      setHydrated(items);
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Auto-open the create dialog on the `/todos/new` deep link.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (window.location.pathname.endsWith('/todos/new') && !dialogOpen) {
      setDialogOpen(true);
    }
    // Intentional single-mount effect; the empty dep-list matches the
    // pattern used by CompaniesListPage / ContactsListPage / CalendarPage.
    // The repo's eslint config has no `react-hooks/exhaustive-deps` rule.
  }, []);

  const grouped = useMemo(() => groupTodosByStatus(hydrated), [hydrated]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const view = todosListView(input);
  const originalLocale = i18n.resolvedLanguage ?? 'en';
  const layer = current.layer;

  async function handleKanbanStatusChange(todo: Todo, nextStatus: TodoStatus): Promise<void> {
    if (layerSlug === null || kanbanBusySlug !== null) return;
    if (todo.payload.status === nextStatus) return;
    setKanbanBusySlug(todo.slug);
    try {
      const draft = draftFromTodo(todo);
      const nowIso = new Date().toISOString();
      const next = applyClientStatusTransition(draft, nextStatus, nowIso);
      const body = buildUpdateTodoRequest(next);
      await updateTodo(layerSlug, todo.slug, body);
      pushToast({
        kind: 'success',
        message: t('entity.todos.statusChangedTo', {
          status: t(statusLabelKey(nextStatus)),
        }),
      });
      await refresh();
    } catch (err: unknown) {
      pushToast({
        kind: 'error',
        message: t(errorKeyOf(err), { defaultValue: t('errors.entity.todos.saveFailed') }),
      });
    } finally {
      setKanbanBusySlug(null);
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <CardTitle>{t('entity.todos.listTitle', { name: layer.name })}</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex gap-1" role="group" aria-label={t('entity.todos.fieldStatus')}>
              <Button
                type="button"
                size="sm"
                variant={viewMode === 'list' ? 'default' : 'ghost'}
                aria-pressed={viewMode === 'list'}
                onClick={() => setViewMode('list')}
              >
                {t('entity.todos.viewList')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant={viewMode === 'kanban' ? 'default' : 'ghost'}
                aria-pressed={viewMode === 'kanban'}
                onClick={() => setViewMode('kanban')}
              >
                {t('entity.todos.viewKanban')}
              </Button>
            </div>
            <Button type="button" onClick={() => setDialogOpen(true)}>
              {t('entity.todos.createCta')}
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {view.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('entity.todos.listLoading')}
            </p>
          ) : null}
          {view.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(view.errorKey, { defaultValue: t('entity.todos.listError') })}
            </p>
          ) : null}
          {view.kind === 'empty' ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">{t('entity.todos.listEmpty')}</p>
              <Button type="button" onClick={() => setDialogOpen(true)}>
                {t('entity.todos.createCta')}
              </Button>
            </div>
          ) : null}
          {view.kind === 'ready' && viewMode === 'list' ? (
            <TodosListView layerSlug={layer.slug} todos={hydrated} summaries={view.todos} />
          ) : null}
          {view.kind === 'ready' && viewMode === 'kanban' ? (
            <TodosKanbanView
              layerSlug={layer.slug}
              grouped={grouped}
              busySlug={kanbanBusySlug}
              onChangeStatus={(todo, nextStatus) => void handleKanbanStatusChange(todo, nextStatus)}
            />
          ) : null}
        </CardContent>
      </Card>

      {dialogOpen ? (
        <CreateTodoDialog
          layerSlug={layer.slug}
          originalLocale={originalLocale}
          onClose={() => setDialogOpen(false)}
          onCreated={async (todoSlug) => {
            setDialogOpen(false);
            pushToast({ kind: 'success', message: t('entity.todos.created') });
            await refresh();
            navigate(webTodoPath(layer.slug, todoSlug));
          }}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface TodosListViewProps {
  readonly layerSlug: string;
  readonly todos: readonly Todo[];
  readonly summaries: readonly EntitySummary[];
}

/**
 * List view — table with the columns the spec calls for: title, status
 * badge, priority badge, dueAt, linked entity chip. When the full todo
 * for a given summary hasn't hydrated yet (e.g. the per-row
 * `getTodo(...)` failed) we still render the summary's title + slug so
 * the row never disappears.
 */
function TodosListView(props: TodosListViewProps): JSX.Element {
  const { t } = useTranslation();
  // Keep the on-screen order stable using the summary list. The hydrated
  // todos contain `payload.status`/`priority`/`dueAt`, so we map by id.
  const fullById = new Map<string, Todo>();
  for (const todo of props.todos) {
    fullById.set(todo.id, todo);
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="px-2 py-2 font-medium">
              {t('entity.todos.fieldTitle')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('entity.todos.fieldStatus')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('entity.todos.fieldPriority')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('entity.todos.fieldDueAt')}
            </th>
            <th scope="col" className="px-2 py-2 font-medium">
              {t('entity.todos.fieldLinkedEntity')}
            </th>
          </tr>
        </thead>
        <tbody>
          {props.summaries.map((s) => {
            const full = fullById.get(s.id);
            return (
              <tr key={s.id} className="border-b last:border-0">
                <td className="px-2 py-2 font-medium">
                  <Link
                    to={webTodoPath(props.layerSlug, s.slug)}
                    className="text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {s.title}
                  </Link>
                </td>
                <td className="px-2 py-2 text-muted-foreground">
                  {full !== undefined ? (
                    <span
                      className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs"
                      aria-label={t('entity.todos.fieldStatus')}
                    >
                      {t(statusLabelKey(full.payload.status))}
                    </span>
                  ) : (
                    <span className="text-xs">{t('common.loading')}</span>
                  )}
                </td>
                <td className="px-2 py-2 text-muted-foreground">
                  {full !== undefined ? (
                    <span
                      className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs"
                      aria-label={t('entity.todos.fieldPriority')}
                    >
                      {t(priorityLabelKey(full.payload.priority))}
                    </span>
                  ) : null}
                </td>
                <td className="px-2 py-2 text-muted-foreground">{full?.payload.dueAt ?? ''}</td>
                <td className="px-2 py-2 text-muted-foreground">
                  {full?.payload.linkedEntityRef !== undefined ? (
                    <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs">
                      {full.payload.linkedEntityRef.kind === 'company'
                        ? t('entity.todos.fieldLinkedKindCompany')
                        : t('entity.todos.fieldLinkedKindContact')}
                    </span>
                  ) : (
                    <span className="text-xs">{t('entity.todos.fieldLinkedKindNone')}</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface TodosKanbanViewProps {
  readonly layerSlug: string;
  readonly grouped: ReadonlyMap<TodoStatus, readonly Todo[]>;
  readonly busySlug: string | null;
  readonly onChangeStatus: (todo: Todo, nextStatus: TodoStatus) => void;
}

/**
 * Simple per-status kanban — five columns, cards listed top-to-bottom.
 *
 * v1 ships WITHOUT drag-and-drop: the plan calls for a "simple
 * kanban" and the full Kanban-entity arrives later in §6 of the
 * phase-4 plan. The per-card interaction is a status `<select>` whose
 * onChange routes through `applyClientStatusTransition` so the
 * `completedAt` normalization mirrors the detail page.
 */
function TodosKanbanView(props: TodosKanbanViewProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-5">
      {TODO_STATUS_ORDER.map((status) => {
        const cards = props.grouped.get(status) ?? [];
        return (
          <section
            key={status}
            aria-label={t(kanbanColumnLabelKey(status))}
            className="space-y-2 rounded-md border bg-muted/30 p-2"
          >
            <header className="flex items-center justify-between px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span>{t(kanbanColumnLabelKey(status))}</span>
              <span aria-hidden>{cards.length}</span>
            </header>
            {cards.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">{t('entity.todos.listEmpty')}</p>
            ) : (
              <ul className="space-y-2">
                {cards.map((todo) => (
                  <li key={todo.id}>
                    <article className="space-y-1 rounded-md border bg-background p-2">
                      <Link
                        to={webTodoPath(props.layerSlug, todo.slug)}
                        className="block font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {todo.title}
                      </Link>
                      <p className="text-xs text-muted-foreground">
                        {t(priorityLabelKey(todo.payload.priority))}
                        {todo.payload.dueAt !== undefined && todo.payload.dueAt.length > 0
                          ? ` · ${todo.payload.dueAt}`
                          : ''}
                      </p>
                      <div className="flex items-center gap-2 pt-1">
                        <Label htmlFor={`kanban-status-${todo.id}`} className="sr-only">
                          {t('entity.todos.fieldStatus')}
                        </Label>
                        <select
                          id={`kanban-status-${todo.id}`}
                          value={todo.payload.status}
                          onChange={(e) => props.onChangeStatus(todo, e.target.value as TodoStatus)}
                          disabled={props.busySlug === todo.slug}
                          className="h-8 w-full rounded-md border bg-background px-2 text-xs"
                        >
                          {TODO_STATUS_ORDER.map((s) => (
                            <option key={s} value={s}>
                              {t(statusLabelKey(s))}
                            </option>
                          ))}
                        </select>
                      </div>
                    </article>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------

interface CreateTodoDialogProps {
  readonly layerSlug: string;
  readonly originalLocale: string;
  readonly onClose: () => void;
  readonly onCreated: (todoSlug: string) => Promise<void>;
}

function CreateTodoDialog(props: CreateTodoDialogProps): JSX.Element {
  const { t } = useTranslation();
  const [draft, setDraft] = useState<TodoFormDraft>(() => emptyTodoFormDraft());
  const [slugTouched, setSlugTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  function setField<K extends keyof TodoFormDraft>(key: K, value: TodoFormDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleTitleChange(value: string): void {
    setDraft((prev) => ({
      ...prev,
      title: value,
      slug: slugTouched ? (prev.slug ?? '') : slugifyTodoTitle(value),
    }));
  }

  async function handleSubmit(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (pending) return;
    setErrorKey(null);
    const validation = validateTodoForm(draft);
    if (validation !== null) {
      setErrorKey(validation);
      return;
    }
    setPending(true);
    try {
      const body = buildCreateTodoRequest(draft, props.originalLocale);
      const created = await createTodo(props.layerSlug, body);
      await props.onCreated(created.slug);
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
      title={t('entity.todos.createDialogTitle')}
      closeLabel={t('common.close')}
    >
      <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4" noValidate>
        <div className="space-y-2">
          <Label htmlFor="newt-title">{t('entity.todos.fieldTitle')}</Label>
          <Input
            id="newt-title"
            value={draft.title}
            onChange={(e) => handleTitleChange(e.target.value)}
            disabled={pending}
            required
            autoComplete="off"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newt-slug">{t('entity.todos.slug')}</Label>
          <Input
            id="newt-slug"
            value={draft.slug ?? ''}
            onChange={(e) => {
              setField('slug', e.target.value);
              setSlugTouched(true);
            }}
            disabled={pending}
            autoComplete="off"
            aria-describedby="newt-slug-hint"
          />
          <p id="newt-slug-hint" className="text-xs text-muted-foreground">
            {t('entity.todos.slugHint')}
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="newt-description">{t('entity.todos.fieldDescription')}</Label>
          <Textarea
            id="newt-description"
            value={draft.description}
            onChange={(e) => setField('description', e.target.value)}
            disabled={pending}
            rows={3}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="newt-dueAt">{t('entity.todos.fieldDueAt')}</Label>
          <Input
            id="newt-dueAt"
            type="date"
            value={draft.dueAt}
            onChange={(e) => setField('dueAt', e.target.value)}
            disabled={pending}
          />
        </div>
        {errorKey !== null ? (
          <p role="alert" aria-live="polite" className="text-sm text-destructive">
            {t(errorKey, { defaultValue: t('errors.entity.todos.saveFailed') })}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={pending}>
            {t('entity.todos.cancel')}
          </Button>
          <Button type="submit" disabled={pending}>
            {t('entity.todos.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

// Re-export the page as the `/todos/new` route landing point — same
// component; the dialog opens automatically when the path matches.
export { TodosPage as TodosNewPage };
export { webTodoNewPath, webTodoPath, webTodosPath };
