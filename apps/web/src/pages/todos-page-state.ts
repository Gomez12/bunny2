/**
 * Phase 4d.5 — pure helpers for the todos pages.
 *
 * Same rationale as `companies-page-state.ts` / `contacts-page-state.ts`
 * / `calendar-page-state.ts`: the web repo has no DOM runtime (see
 * `docs/dev/follow-ups/web-component-tests.md`), so per-page logic is
 * factored into pure functions exercised by `bun test`.
 *
 *  - `todosListView` / `todoDetailView` — load-state reducers.
 *  - `groupTodosByStatus` — kanban grouping. Given an array of full
 *    todos, returns a `Map<TodoStatus, Todo[]>` ordered by priority
 *    (1 first) then `dueAt` (earlier first; missing `dueAt` last).
 *    Pure; safe for `useMemo`.
 *  - `validateTodoForm` — inline form validation mirroring
 *    `TodoPayloadSchema`. Returns the i18n key of the first failure,
 *    or `null` when the draft is shippable.
 *  - `buildCreateTodoRequest` / `buildUpdateTodoRequest` — produce the
 *    JSON bodies the server expects.
 *  - `applyClientStatusTransition` — handles the `completedAt`
 *    client-side normalization. Per the 4d.1 close-out the server does
 *    NOT auto-fill `completedAt` (the `onUpdate` hook fires after the
 *    row write). The UI normalizes here: status -> 'done' fills
 *    `completedAt` with `nowIso` if not already set; status off 'done'
 *    clears it. Idempotent on no-op transitions.
 *  - `setLinkedEntityKind` / `setLinkedEntityId` / `clearLinkedEntity`
 *    — picker reducer logic. Kind change clears the entity id (since
 *    a company id is not valid for kind=contact, etc); kind=none
 *    clears both.
 *  - `addTag` / `removeTag` — tags editor.
 *  - `statusLabelKey` / `priorityLabelKey` — i18n key derivation for
 *    badges. Pure; the component renders.
 */
import type {
  CreateTodoPayload,
  EntitySummary,
  Todo,
  TodoLinkedEntityKind,
  TodoLinkedEntityRef,
  TodoPayload,
  TodoPriority,
  TodoStatus,
  UpdateTodoPayload,
} from '../lib/api-types';

// ---------- list page ------------------------------------------------------

export type TodosListInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly todos: readonly EntitySummary[] };

export type TodosListView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly todos: readonly EntitySummary[] };

export function todosListView(input: TodosListInput): TodosListView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  if (input.todos.length === 0) return { kind: 'empty' };
  return { kind: 'ready', todos: input.todos };
}

// ---------- detail page ----------------------------------------------------

export type TodoDetailInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly todo: Todo };

export type TodoDetailView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly todo: Todo };

export function todoDetailView(input: TodoDetailInput): TodoDetailView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  return { kind: 'ready', todo: input.todo };
}

// ---------- view toggle ----------------------------------------------------

export type TodosViewMode = 'list' | 'kanban';

// ---------- kanban grouping ------------------------------------------------

/**
 * Stable ordering for the kanban columns. The component iterates this
 * list to render columns left-to-right; the grouping map keeps the
 * cards-per-column ordered by priority then dueAt.
 */
export const TODO_STATUS_ORDER: readonly TodoStatus[] = [
  'open',
  'in_progress',
  'blocked',
  'done',
  'cancelled',
];

/**
 * Group an array of full todos by status. Each bucket is sorted by
 * priority ascending (1 = highest first), then `dueAt` ascending
 * (earlier first; missing `dueAt` sorts last so dated todos surface
 * above undated ones), then `title` ascending as a stable tiebreaker.
 *
 * Returns a fresh `Map`; safe for `useMemo`. Every key in
 * `TODO_STATUS_ORDER` is present in the map (possibly empty) so the
 * caller does not need to defend against missing buckets.
 */
export function groupTodosByStatus(
  todos: readonly Todo[],
): ReadonlyMap<TodoStatus, readonly Todo[]> {
  const buckets = new Map<TodoStatus, Todo[]>();
  for (const status of TODO_STATUS_ORDER) {
    buckets.set(status, []);
  }
  for (const todo of todos) {
    const bucket = buckets.get(todo.payload.status);
    if (bucket !== undefined) {
      bucket.push(todo);
    }
  }
  for (const list of buckets.values()) {
    list.sort(compareTodosForKanban);
  }
  return buckets;
}

function compareTodosForKanban(a: Todo, b: Todo): number {
  const pa = a.payload.priority;
  const pb = b.payload.priority;
  if (pa !== pb) return pa - pb;
  const da = a.payload.dueAt ?? '';
  const db = b.payload.dueAt ?? '';
  if (da.length === 0 && db.length > 0) return 1;
  if (db.length === 0 && da.length > 0) return -1;
  if (da !== db) return da < db ? -1 : 1;
  return a.title.localeCompare(b.title);
}

// ---------- form draft -----------------------------------------------------

export interface TodoFormDraft {
  readonly title: string;
  readonly slug?: string;
  readonly description: string;
  readonly status: TodoStatus;
  readonly priority: TodoPriority;
  readonly dueAt: string;
  readonly linkedKind: TodoLinkedEntityKind | 'none';
  readonly linkedEntityId: string | null;
  readonly tags: readonly string[];
  readonly completedAt: string;
}

export function emptyTodoFormDraft(): TodoFormDraft {
  return {
    title: '',
    slug: '',
    description: '',
    status: 'open',
    priority: 3,
    dueAt: '',
    linkedKind: 'none',
    linkedEntityId: null,
    tags: [],
    completedAt: '',
  };
}

export function draftFromTodo(todo: Todo): TodoFormDraft {
  const p = todo.payload;
  return {
    title: todo.title,
    slug: todo.slug,
    description: p.description ?? '',
    status: p.status,
    priority: p.priority,
    dueAt: p.dueAt ?? '',
    linkedKind: p.linkedEntityRef?.kind ?? 'none',
    linkedEntityId: p.linkedEntityRef?.entityId ?? null,
    tags: p.tags ?? [],
    completedAt: p.completedAt ?? '',
  };
}

// ---------- linked-entity picker -------------------------------------------

/**
 * Change the kind selector. Switching kinds clears the previously-picked
 * entity id because a contact id is not valid for kind=company and vice
 * versa. Selecting 'none' clears both kind and id.
 */
export function setLinkedEntityKind(
  draft: TodoFormDraft,
  kind: TodoLinkedEntityKind | 'none',
): TodoFormDraft {
  if (kind === draft.linkedKind) return draft;
  if (kind === 'none') {
    return { ...draft, linkedKind: 'none', linkedEntityId: null };
  }
  return { ...draft, linkedKind: kind, linkedEntityId: null };
}

export function setLinkedEntityId(draft: TodoFormDraft, entityId: string | null): TodoFormDraft {
  if (draft.linkedKind === 'none') return draft;
  return { ...draft, linkedEntityId: entityId };
}

export function clearLinkedEntity(draft: TodoFormDraft): TodoFormDraft {
  return { ...draft, linkedKind: 'none', linkedEntityId: null };
}

// ---------- status transition (completedAt normalization) ------------------

/**
 * Apply a status transition to the draft, normalizing `completedAt`
 * client-side per the 4d.1 close-out (the server's `onUpdate` lifecycle
 * fires after the row write and cannot mutate the persisted payload, so
 * the UI is the sole writer of `completedAt`).
 *
 *  - `status -> 'done'` and no existing `completedAt` → set to `nowIso`.
 *  - `status -> 'done'` and `completedAt` already set → preserved
 *    (re-marking a done todo "done" should not reset the timestamp).
 *  - `status` moves OFF `'done'` → clear `completedAt`.
 *  - Same status → no-op (idempotent).
 *
 * Pure; tested in `todo-detail-page.test.ts`.
 */
export function applyClientStatusTransition(
  draft: TodoFormDraft,
  newStatus: TodoStatus,
  nowIso: string,
): TodoFormDraft {
  if (draft.status === newStatus) {
    // Same status — only re-fill completedAt when transitioning into 'done'
    // and the slot is empty. This branch keeps callers that "reaffirm" the
    // current status from accidentally re-stamping completedAt.
    return draft;
  }
  if (newStatus === 'done') {
    const completedAt = draft.completedAt.length > 0 ? draft.completedAt : nowIso;
    return { ...draft, status: newStatus, completedAt };
  }
  // Moving off 'done' clears completedAt.
  if (draft.status === 'done') {
    return { ...draft, status: newStatus, completedAt: '' };
  }
  return { ...draft, status: newStatus };
}

// ---------- tags editor ----------------------------------------------------

export function addTag(draft: TodoFormDraft, raw: string): TodoFormDraft {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return draft;
  if (draft.tags.length >= 16) return draft;
  if (draft.tags.some((t) => t.toLowerCase() === trimmed)) return draft;
  return { ...draft, tags: [...draft.tags, trimmed] };
}

export function removeTag(draft: TodoFormDraft, index: number): TodoFormDraft {
  if (index < 0 || index >= draft.tags.length) return draft;
  return { ...draft, tags: draft.tags.filter((_, i) => i !== index) };
}

// ---------- validation -----------------------------------------------------

/**
 * Mirrors `TodoPayloadSchema` enough to surface obvious form errors
 * before the round-trip. Returns the i18n error key of the first
 * failure or `null` when the draft is shippable.
 */
export function validateTodoForm(draft: TodoFormDraft): string | null {
  if (draft.title.trim().length === 0) {
    return 'errors.entity.todos.validation';
  }
  if (draft.description.length > 4000) {
    return 'errors.entity.todos.validation';
  }
  if (draft.dueAt.trim().length > 0 && !ISO_DATE_OR_DATETIME_PATTERN.test(draft.dueAt.trim())) {
    return 'errors.entity.todos.validation';
  }
  if (
    draft.completedAt.trim().length > 0 &&
    !ISO_DATE_OR_DATETIME_PATTERN.test(draft.completedAt.trim())
  ) {
    return 'errors.entity.todos.validation';
  }
  if (draft.linkedKind !== 'none') {
    if (draft.linkedEntityId === null || draft.linkedEntityId.length === 0) {
      return 'errors.entity.todos.validation';
    }
  }
  const seenTags = new Set<string>();
  for (const tag of draft.tags) {
    const key = tag.toLowerCase();
    if (seenTags.has(key)) {
      return 'errors.entity.todos.tagDuplicate';
    }
    seenTags.add(key);
  }
  if (draft.tags.length > 16) {
    return 'errors.entity.todos.validation';
  }
  return null;
}

const ISO_DATE_OR_DATETIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

// ---------- payload builders -----------------------------------------------

function buildPayload(draft: TodoFormDraft): TodoPayload {
  const payload: {
    description?: string;
    status: TodoStatus;
    priority: TodoPriority;
    dueAt?: string;
    completedAt?: string;
    linkedEntityRef?: TodoLinkedEntityRef;
    tags?: readonly string[];
  } = {
    status: draft.status,
    priority: draft.priority,
  };
  const description = draft.description.trim();
  if (description.length > 0) payload.description = description;
  const dueAt = draft.dueAt.trim();
  if (dueAt.length > 0) payload.dueAt = dueAt;
  const completedAt = draft.completedAt.trim();
  if (completedAt.length > 0) payload.completedAt = completedAt;
  if (
    draft.linkedKind !== 'none' &&
    draft.linkedEntityId !== null &&
    draft.linkedEntityId.length > 0
  ) {
    payload.linkedEntityRef = { kind: draft.linkedKind, entityId: draft.linkedEntityId };
  }
  if (draft.tags.length > 0) {
    // De-duplicate by lowercase, drop empties.
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of draft.tags) {
      const trimmed = t.trim().toLowerCase();
      if (trimmed.length === 0) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
    }
    if (out.length > 0) payload.tags = out;
  }
  return payload as TodoPayload;
}

export function buildCreateTodoRequest(
  draft: TodoFormDraft,
  originalLocale: string,
): CreateTodoPayload {
  const out: {
    title: string;
    slug?: string;
    originalLocale: string;
    payload: TodoPayload;
  } = {
    title: draft.title.trim(),
    originalLocale,
    payload: buildPayload(draft),
  };
  if (draft.slug !== undefined && draft.slug.trim().length > 0) {
    out.slug = draft.slug.trim();
  }
  return out;
}

export function buildUpdateTodoRequest(draft: TodoFormDraft): UpdateTodoPayload {
  return {
    title: draft.title.trim(),
    payload: buildPayload(draft),
  };
}

// ---------- badge i18n key derivation --------------------------------------

export function statusLabelKey(status: TodoStatus): string {
  switch (status) {
    case 'open':
      return 'entity.todos.statusOpen';
    case 'in_progress':
      return 'entity.todos.statusInProgress';
    case 'blocked':
      return 'entity.todos.statusBlocked';
    case 'done':
      return 'entity.todos.statusDone';
    case 'cancelled':
      return 'entity.todos.statusCancelled';
  }
}

export function kanbanColumnLabelKey(status: TodoStatus): string {
  switch (status) {
    case 'open':
      return 'entity.todos.kanbanColumnOpen';
    case 'in_progress':
      return 'entity.todos.kanbanColumnInProgress';
    case 'blocked':
      return 'entity.todos.kanbanColumnBlocked';
    case 'done':
      return 'entity.todos.kanbanColumnDone';
    case 'cancelled':
      return 'entity.todos.kanbanColumnCancelled';
  }
}

export function priorityLabelKey(priority: TodoPriority): string {
  switch (priority) {
    case 1:
      return 'entity.todos.priority1';
    case 2:
      return 'entity.todos.priority2';
    case 3:
      return 'entity.todos.priority3';
    case 4:
      return 'entity.todos.priority4';
    case 5:
      return 'entity.todos.priority5';
  }
}
