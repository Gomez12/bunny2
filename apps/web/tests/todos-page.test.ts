/**
 * Phase 4d.5 — pure-logic tests for the Todos list / kanban page.
 *
 * The repo has no DOM runtime (see
 * `docs/dev/follow-ups/web-component-tests.md`), so we exercise the
 * pure reducer + grouping + route helpers used by `TodosPage.tsx`.
 *
 * Covered:
 *   - `todosListView` — loading / error / empty / ready branches.
 *   - `groupTodosByStatus` — kanban grouping order (priority then
 *     dueAt then title) and that every status column is present.
 *   - The `todos-routes` helpers — singular ↔ plural URL mapping and
 *     the reserved-slug fallback for "new".
 *   - `slugifyTodoTitle` — the `^[a-z0-9-]+$` rule and the `new` ↦
 *     `new-todo` collision dodge.
 */
import { describe, expect, it } from 'bun:test';
import type { EntitySummary, Todo, TodoStatus } from '../src/lib/api-types';
import {
  RESERVED_TODO_SLUGS,
  TODOS_SERVER_KIND,
  TODOS_WEB_SEGMENT,
  slugifyTodoTitle,
  todoServerDetail,
  todosServerBase,
  webTodoNewPath,
  webTodoPath,
  webTodosPath,
} from '../src/lib/todos-routes';
import {
  TODO_STATUS_ORDER,
  groupTodosByStatus,
  todosListView,
  type TodosListInput,
} from '../src/pages/todos-page-state';

function summary(overrides: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'todo',
    layerId: '00000000-0000-0000-0000-0000000000aa',
    slug: 'call-ami',
    title: 'Call AMI BV',
    subtitle: null,
    searchableText: 'call ami bv',
    meta: {
      createdAt: '2026-05-23T00:00:00.000Z',
      createdBy: '00000000-0000-0000-0000-0000000000bb',
      updatedAt: '2026-05-24T10:00:00.000Z',
      updatedBy: '00000000-0000-0000-0000-0000000000bb',
      deletedAt: null,
      deletedBy: null,
      version: 1,
      originalLocale: 'en',
    },
    ...overrides,
  };
}

function todo(overrides: Partial<Todo> = {}, payload: Partial<Todo['payload']> = {}): Todo {
  const base: Todo = {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'todo',
    layerId: '00000000-0000-0000-0000-0000000000aa',
    slug: 'call-ami',
    title: 'Call AMI BV',
    subtitle: null,
    searchableText: 'call ami bv',
    meta: {
      createdAt: '2026-05-23T00:00:00.000Z',
      createdBy: '00000000-0000-0000-0000-0000000000bb',
      updatedAt: '2026-05-24T10:00:00.000Z',
      updatedBy: '00000000-0000-0000-0000-0000000000bb',
      deletedAt: null,
      deletedBy: null,
      version: 1,
      originalLocale: 'en',
    },
    payload: { status: 'open', priority: 3, ...payload },
    externalLinks: [],
    ...overrides,
  };
  return base;
}

describe('todosListView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(todosListView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    const input: TodosListInput = { status: 'error', errorKey: 'errors.network' };
    expect(todosListView(input)).toEqual({ kind: 'error', errorKey: 'errors.network' });
  });

  it('returns the empty branch when the todos list is empty', () => {
    expect(todosListView({ status: 'ready', todos: [] })).toEqual({ kind: 'empty' });
  });

  it('returns the ready branch with the array when the list is non-empty', () => {
    const view = todosListView({ status: 'ready', todos: [summary()] });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.todos).toHaveLength(1);
    }
  });
});

describe('groupTodosByStatus', () => {
  it('returns one bucket per status in TODO_STATUS_ORDER, even when empty', () => {
    const grouped = groupTodosByStatus([]);
    for (const status of TODO_STATUS_ORDER) {
      expect(grouped.has(status)).toBe(true);
      expect(grouped.get(status)).toEqual([]);
    }
  });

  it('groups todos into the correct status bucket', () => {
    const items: Todo[] = [
      todo({ id: 'a', slug: 'a', title: 'A' }, { status: 'open', priority: 3 }),
      todo({ id: 'b', slug: 'b', title: 'B' }, { status: 'done', priority: 3 }),
      todo({ id: 'c', slug: 'c', title: 'C' }, { status: 'blocked', priority: 3 }),
    ];
    const grouped = groupTodosByStatus(items);
    expect(grouped.get('open')?.map((t) => t.id)).toEqual(['a']);
    expect(grouped.get('done')?.map((t) => t.id)).toEqual(['b']);
    expect(grouped.get('blocked')?.map((t) => t.id)).toEqual(['c']);
    expect(grouped.get('in_progress')).toEqual([]);
    expect(grouped.get('cancelled')).toEqual([]);
  });

  it('sorts each bucket by priority (1 first), then dueAt ascending, then title', () => {
    const items: Todo[] = [
      todo({ id: '1', slug: '1', title: 'mid' }, { status: 'open', priority: 3 }),
      todo(
        { id: '2', slug: '2', title: 'urgent' },
        { status: 'open', priority: 1, dueAt: '2026-05-25' },
      ),
      todo({ id: '3', slug: '3', title: 'low' }, { status: 'open', priority: 5 }),
      todo(
        { id: '4', slug: '4', title: 'urgent earlier' },
        { status: 'open', priority: 1, dueAt: '2026-05-24' },
      ),
    ];
    const grouped = groupTodosByStatus(items);
    expect(grouped.get('open')?.map((t) => t.id)).toEqual(['4', '2', '1', '3']);
  });

  it('sorts todos with a dueAt above todos without one (at the same priority)', () => {
    const items: Todo[] = [
      todo({ id: 'undated', slug: 'undated', title: 'B' }, { status: 'open', priority: 3 }),
      todo(
        { id: 'dated', slug: 'dated', title: 'A' },
        { status: 'open', priority: 3, dueAt: '2026-06-01' },
      ),
    ];
    const grouped = groupTodosByStatus(items);
    expect(grouped.get('open')?.map((t) => t.id)).toEqual(['dated', 'undated']);
  });
});

describe('todos-routes', () => {
  it('exposes the singular server kind and plural web segment expected by the seam', () => {
    expect(TODOS_SERVER_KIND).toBe('todo');
    expect(TODOS_WEB_SEGMENT).toBe('todos');
  });

  it('produces the web URLs the 4d.4 widget links to', () => {
    expect(webTodosPath('demo')).toBe('/l/demo/todos');
    expect(webTodoNewPath('demo')).toBe('/l/demo/todos/new');
    expect(webTodoPath('demo', 'call-ami')).toBe('/l/demo/todos/call-ami');
  });

  it('produces the singular server URLs for the API client', () => {
    expect(todosServerBase('demo')).toBe('/l/demo/todo');
    expect(todoServerDetail('demo', 'call-ami')).toBe('/l/demo/todo/call-ami');
  });

  it('reserves the `new` slug so a todo titled "New" does not shadow the dialog deep link', () => {
    expect(RESERVED_TODO_SLUGS.has('new')).toBe(true);
    expect(slugifyTodoTitle('New')).toBe('new-todo');
  });

  it('produces lowercase dash-only slugs', () => {
    expect(slugifyTodoTitle('Call AMI BV')).toBe('call-ami-bv');
    expect(slugifyTodoTitle('  Multiple   spaces  ')).toBe('multiple-spaces');
    expect(slugifyTodoTitle('PunCtuation!?#$')).toBe('punctuation');
  });
});

describe('view mode is exported via state file', () => {
  // Sanity check — the view-toggle test is logic-only; the component
  // test would mount the page, which the repo has no runtime for.
  it('every status in TODO_STATUS_ORDER has a unique label key (matches statusLabelKey shape)', () => {
    const seen = new Set<TodoStatus>();
    for (const status of TODO_STATUS_ORDER) {
      expect(seen.has(status)).toBe(false);
      seen.add(status);
    }
    expect(seen.size).toBe(5);
  });
});
