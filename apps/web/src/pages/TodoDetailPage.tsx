import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { ConfirmDialog } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import { getTodo, listCompanies, listContacts, softDeleteTodo, updateTodo } from '../lib/api';
import type {
  EntitySummary,
  TodoLinkedEntityKind,
  TodoPriority,
  TodoStatus,
} from '../lib/api-types';
import { companyDetailWebRoute } from '../lib/companies-routes';
import { contactDetailWebRoute } from '../lib/contacts-routes';
import { errorKeyOf } from '../lib/errors';
import { pushToast } from '../lib/toast';
import { webTodosPath } from '../lib/todos-routes';
import { useCurrentLayer } from '../lib/use-current-layer';
import {
  TODO_STATUS_ORDER,
  addTag,
  applyClientStatusTransition,
  buildUpdateTodoRequest,
  clearLinkedEntity,
  draftFromTodo,
  emptyTodoFormDraft,
  priorityLabelKey,
  removeTag,
  setLinkedEntityId,
  setLinkedEntityKind,
  statusLabelKey,
  todoDetailView,
  validateTodoForm,
  type TodoDetailInput,
  type TodoFormDraft,
} from './todos-page-state';

/**
 * `/l/:layerSlug/todos/:todoSlug` — todo detail + edit page (phase 4d.5).
 *
 * Fetches the full todo plus the layer's companies and contacts (for
 * the linked-entity picker). The picker is a two-step control:
 *
 *  1. A kind selector (`<select>` — None / Company / Contact).
 *  2. A second `<select>` listing the matching entities in the layer
 *     once a kind is picked. "None" clears the link.
 *
 * The selected display shows the entity's title and links to the
 * matching detail page (`/companies/:slug` or `/contacts/:slug`).
 *
 * `completedAt` is read-only — set by the page automatically when the
 * user transitions status to 'done' (see
 * `applyClientStatusTransition`). Per the 4d.1 close-out the server
 * does NOT auto-fill this field, so the UI is the sole writer.
 *
 * Accessibility:
 *  - Single `<h1>` via the card title.
 *  - Status segmented control: real `<button>` elements with
 *    `aria-pressed` so screen readers announce state.
 *  - Every input has a `<label htmlFor>`.
 *  - Pickers use plain `<select>` — accessible out of the box.
 *  - Soft-delete: `ConfirmDialog` (focus-trap).
 *  - Errors render with `role="alert" aria-live="polite"`.
 */
export function TodoDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const current = useCurrentLayer();
  const params = useParams<{ layerSlug: string; todoSlug: string }>();
  const todoSlug = params.todoSlug ?? '';

  const [input, setInput] = useState<TodoDetailInput>({ status: 'loading' });
  const [draft, setDraft] = useState<TodoFormDraft>(() => emptyTodoFormDraft());
  const [companies, setCompanies] = useState<readonly EntitySummary[]>([]);
  const [contacts, setContacts] = useState<readonly EntitySummary[]>([]);
  const [savePending, setSavePending] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [tagInput, setTagInput] = useState('');

  const layerSlug = current.status === 'ready' ? current.layer.slug : null;

  const refresh = useCallback(async (): Promise<void> => {
    if (layerSlug === null) return;
    setInput({ status: 'loading' });
    try {
      const [todo, cos, cts] = await Promise.all([
        getTodo(layerSlug, todoSlug),
        listCompanies(layerSlug).catch(() => [] as readonly EntitySummary[]),
        listContacts(layerSlug).catch(() => [] as readonly EntitySummary[]),
      ]);
      setCompanies(cos);
      setContacts(cts);
      setInput({ status: 'ready', todo });
      setDraft(draftFromTodo(todo));
    } catch (err: unknown) {
      setInput({ status: 'error', errorKey: errorKeyOf(err) });
    }
  }, [layerSlug, todoSlug]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const view = todoDetailView(input);

  function setField<K extends keyof TodoFormDraft>(key: K, value: TodoFormDraft[K]): void {
    setDraft((prev) => ({ ...prev, [key]: value }));
  }

  function handleStatusChange(nextStatus: TodoStatus): void {
    setDraft((prev) => applyClientStatusTransition(prev, nextStatus, new Date().toISOString()));
  }

  async function handleSave(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    if (savePending || layerSlug === null) return;
    setSaveError(null);
    const validation = validateTodoForm(draft);
    if (validation !== null) {
      setSaveError(validation);
      return;
    }
    setSavePending(true);
    try {
      const body = buildUpdateTodoRequest(draft);
      const updated = await updateTodo(layerSlug, todoSlug, body);
      setInput({ status: 'ready', todo: updated });
      setDraft(draftFromTodo(updated));
      pushToast({ kind: 'success', message: t('entity.todos.saved') });
    } catch (err: unknown) {
      setSaveError(errorKeyOf(err));
    } finally {
      setSavePending(false);
    }
  }

  function handleCancel(): void {
    if (view.kind !== 'ready') return;
    setDraft(draftFromTodo(view.todo));
    setSaveError(null);
  }

  async function handleDelete(): Promise<void> {
    if (deletePending || layerSlug === null) return;
    setDeletePending(true);
    setDeleteError(null);
    try {
      await softDeleteTodo(layerSlug, todoSlug);
      pushToast({ kind: 'success', message: t('entity.todos.deleted') });
      navigate(webTodosPath(layerSlug));
    } catch (err: unknown) {
      setDeleteError(errorKeyOf(err));
    } finally {
      setDeletePending(false);
    }
  }

  function handleAddTag(): void {
    if (tagInput.trim().length === 0) return;
    setDraft((prev) => addTag(prev, tagInput));
    setTagInput('');
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>
            {view.kind === 'ready'
              ? t('entity.todos.detailTitle', { title: view.todo.title })
              : t('entity.todos.detailFallbackTitle')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {view.kind === 'loading' ? (
            <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
              {t('entity.todos.listLoading')}
            </p>
          ) : null}
          {view.kind === 'error' ? (
            <p role="alert" className="text-sm text-destructive">
              {t(view.errorKey, { defaultValue: t('errors.entity.todos.loadFailed') })}
            </p>
          ) : null}
          {view.kind === 'ready' ? (
            <form onSubmit={(e) => void handleSave(e)} className="space-y-4" noValidate>
              <div className="space-y-2">
                <Label htmlFor="t-title">{t('entity.todos.fieldTitle')}</Label>
                <Input
                  id="t-title"
                  value={draft.title}
                  onChange={(e) => setField('title', e.target.value)}
                  disabled={savePending}
                  required
                  autoComplete="off"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="t-description">{t('entity.todos.fieldDescription')}</Label>
                <Textarea
                  id="t-description"
                  value={draft.description}
                  onChange={(e) => setField('description', e.target.value)}
                  disabled={savePending}
                  rows={4}
                />
              </div>

              <StatusSegmentedControl
                value={draft.status}
                disabled={savePending}
                onChange={handleStatusChange}
              />

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="t-priority">{t('entity.todos.fieldPriority')}</Label>
                  <select
                    id="t-priority"
                    value={draft.priority}
                    onChange={(e) =>
                      setField('priority', Number.parseInt(e.target.value, 10) as TodoPriority)
                    }
                    disabled={savePending}
                    className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  >
                    {[1, 2, 3, 4, 5].map((p) => (
                      <option key={p} value={p}>
                        {t(priorityLabelKey(p as TodoPriority))}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="t-dueAt">{t('entity.todos.fieldDueAt')}</Label>
                  <Input
                    id="t-dueAt"
                    type="date"
                    value={dueAtToDateInput(draft.dueAt)}
                    onChange={(e) => setField('dueAt', e.target.value)}
                    disabled={savePending}
                  />
                </div>
              </div>

              <LinkedEntityPicker
                kind={draft.linkedKind}
                entityId={draft.linkedEntityId}
                companies={companies}
                contacts={contacts}
                layerSlug={layerSlug ?? ''}
                disabled={savePending}
                onKindChange={(next) => setDraft((d) => setLinkedEntityKind(d, next))}
                onEntityChange={(next) => setDraft((d) => setLinkedEntityId(d, next))}
                onClear={() => setDraft((d) => clearLinkedEntity(d))}
              />

              <TagsEditor
                tags={draft.tags}
                input={tagInput}
                disabled={savePending}
                onInputChange={setTagInput}
                onAdd={handleAddTag}
                onRemove={(i) => setDraft((d) => removeTag(d, i))}
              />

              {draft.completedAt.length > 0 ? (
                <div className="space-y-1">
                  <Label htmlFor="t-completedAt">{t('entity.todos.fieldCompletedAt')}</Label>
                  <Input id="t-completedAt" value={draft.completedAt} readOnly disabled />
                </div>
              ) : null}

              {saveError !== null ? (
                <p role="alert" aria-live="polite" className="text-sm text-destructive">
                  {t(saveError, { defaultValue: t('errors.entity.todos.saveFailed') })}
                </p>
              ) : null}
              <div className="flex flex-wrap justify-between gap-2">
                <Button
                  type="button"
                  variant="destructive"
                  onClick={() => setDeleteConfirmOpen(true)}
                  disabled={savePending}
                >
                  {t('entity.todos.deleteCta')}
                </Button>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={handleCancel}
                    disabled={savePending}
                  >
                    {t('entity.todos.cancel')}
                  </Button>
                  <Button type="submit" disabled={savePending}>
                    {t('entity.todos.save')}
                  </Button>
                </div>
              </div>
            </form>
          ) : null}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={deleteConfirmOpen}
        title={t('entity.todos.deleteConfirmTitle')}
        body={t('entity.todos.deleteConfirmBody')}
        confirmLabel={t('entity.todos.deleteCta')}
        cancelLabel={t('entity.todos.cancel')}
        destructive
        busy={deletePending}
        errorKey={deleteError}
        onConfirm={() => void handleDelete()}
        onClose={() => {
          setDeleteConfirmOpen(false);
          setDeleteError(null);
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

interface StatusSegmentedControlProps {
  readonly value: TodoStatus;
  readonly disabled: boolean;
  readonly onChange: (next: TodoStatus) => void;
}

/**
 * Status segmented control. Five buttons with `aria-pressed`; visually
 * the active button takes the `default` variant, the rest stay `ghost`.
 * The buttons render in the same order as the kanban columns so the
 * left-to-right reading order matches the layer's kanban view.
 */
function StatusSegmentedControl(props: StatusSegmentedControlProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="space-y-2">
      <Label htmlFor="t-status-group">{t('entity.todos.fieldStatus')}</Label>
      <div
        id="t-status-group"
        role="group"
        aria-label={t('entity.todos.fieldStatus')}
        className="flex flex-wrap gap-1"
      >
        {TODO_STATUS_ORDER.map((s) => (
          <Button
            key={s}
            type="button"
            size="sm"
            variant={s === props.value ? 'default' : 'ghost'}
            aria-pressed={s === props.value}
            onClick={() => props.onChange(s)}
            disabled={props.disabled}
          >
            {t(statusLabelKey(s))}
          </Button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface LinkedEntityPickerProps {
  readonly kind: TodoLinkedEntityKind | 'none';
  readonly entityId: string | null;
  readonly companies: readonly EntitySummary[];
  readonly contacts: readonly EntitySummary[];
  readonly layerSlug: string;
  readonly disabled: boolean;
  readonly onKindChange: (next: TodoLinkedEntityKind | 'none') => void;
  readonly onEntityChange: (next: string | null) => void;
  readonly onClear: () => void;
}

/**
 * Two-step linked-entity picker. Kind selector first (None / Company /
 * Contact); when a kind is picked the matching list of entities in the
 * layer becomes selectable. When `entityId` is set, render a deep-link
 * to the entity's detail page so the user can verify the target.
 *
 * If the draft carries an `entityId` that is not in the loaded list
 * (deleted, hidden, or just not yet fetched) we still render it as a
 * disabled option labelled "unknown" so the user does not silently
 * lose the link on save — they can clear it explicitly.
 */
function LinkedEntityPicker(props: LinkedEntityPickerProps): JSX.Element {
  const { t } = useTranslation();
  const targetList = props.kind === 'company' ? props.companies : props.contacts;
  const inListed = targetList.some((e) => e.id === props.entityId);
  const selectedSummary =
    props.entityId !== null ? targetList.find((e) => e.id === props.entityId) : undefined;
  return (
    <fieldset className="space-y-3 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t('entity.todos.fieldLinkedEntity')}</legend>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="t-linkedKind">{t('entity.todos.fieldLinkedKind')}</Label>
          <select
            id="t-linkedKind"
            value={props.kind}
            onChange={(e) => props.onKindChange(e.target.value as TodoLinkedEntityKind | 'none')}
            disabled={props.disabled}
            className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          >
            <option value="none">{t('entity.todos.fieldLinkedKindNone')}</option>
            <option value="company">{t('entity.todos.fieldLinkedKindCompany')}</option>
            <option value="contact">{t('entity.todos.fieldLinkedKindContact')}</option>
          </select>
        </div>
        {props.kind !== 'none' ? (
          <div className="space-y-2">
            <Label htmlFor="t-linkedEntity">{t('entity.todos.fieldLinkedEntity')}</Label>
            <div className="flex flex-wrap items-center gap-2">
              <select
                id="t-linkedEntity"
                value={props.entityId ?? ''}
                onChange={(e) => {
                  const v = e.target.value;
                  props.onEntityChange(v.length === 0 ? null : v);
                }}
                disabled={props.disabled}
                className="h-9 flex-1 rounded-md border bg-background px-3 text-sm"
              >
                <option value="">{t('entity.todos.fieldLinkedEntityPlaceholder')}</option>
                {props.entityId !== null && !inListed ? (
                  <option value={props.entityId}>
                    {t('entity.todos.fieldLinkedEntityUnknown', { id: props.entityId })}
                  </option>
                ) : null}
                {targetList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
              {props.entityId !== null ? (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={props.onClear}
                  disabled={props.disabled}
                >
                  {t('entity.todos.fieldLinkedEntityClear')}
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
      {selectedSummary !== undefined && props.kind !== 'none' ? (
        <p className="text-sm text-muted-foreground">
          <Link
            to={
              props.kind === 'company'
                ? companyDetailWebRoute(props.layerSlug, selectedSummary.slug)
                : contactDetailWebRoute(props.layerSlug, selectedSummary.slug)
            }
            className="underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {selectedSummary.title}
          </Link>
        </p>
      ) : null}
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

interface TagsEditorProps {
  readonly tags: readonly string[];
  readonly input: string;
  readonly disabled: boolean;
  readonly onInputChange: (next: string) => void;
  readonly onAdd: () => void;
  readonly onRemove: (index: number) => void;
}

function TagsEditor(props: TagsEditorProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <fieldset className="space-y-2 rounded-md border p-3">
      <legend className="px-1 text-sm font-medium">{t('entity.todos.fieldTags')}</legend>
      {props.tags.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('entity.todos.tagsEmpty')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {props.tags.map((tag, i) => (
            <li
              key={`${tag}-${i}`}
              className="inline-flex items-center gap-2 rounded-full border px-2 py-0.5 text-xs"
            >
              <span>{tag}</span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => props.onRemove(i)}
                disabled={props.disabled}
                aria-label={t('entity.todos.fieldTagRemove')}
                className="h-5 px-1"
              >
                {t('entity.todos.fieldTagRemove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Label htmlFor="t-tag-input" className="sr-only">
          {t('entity.todos.fieldTagAdd')}
        </Label>
        <Input
          id="t-tag-input"
          value={props.input}
          onChange={(e) => props.onInputChange(e.target.value)}
          disabled={props.disabled}
          className="max-w-xs"
        />
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={props.onAdd}
          disabled={props.disabled}
        >
          {t('entity.todos.fieldTagAdd')}
        </Button>
      </div>
    </fieldset>
  );
}

// ---------------------------------------------------------------------------

/**
 * `<input type="date">` only accepts `YYYY-MM-DD`. If the loaded
 * payload's `dueAt` is a full ISO timestamp, the date portion is what
 * the user can edit; we project the timestamp to its date prefix here
 * and pass the raw string back on save.
 */
function dueAtToDateInput(value: string): string {
  if (value.length === 0) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return value.slice(0, 10);
  return value;
}
