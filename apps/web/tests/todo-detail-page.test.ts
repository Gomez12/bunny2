/**
 * Phase 4d.5 — pure-logic tests for the Todo detail page.
 *
 * Mirrors `companies-detail-page.test.ts` / `contacts-detail-page.test.ts`
 * / `calendar-event-detail-page.test.ts`: covers the reducers,
 * draft↔payload bridge, validators, payload builders, and the
 * todos-specific helpers — linked-entity picker, status transition
 * with client-side `completedAt` normalization, tags editor.
 */
import { describe, expect, it } from 'bun:test';
import type { Todo } from '../src/lib/api-types';
import {
  addTag,
  applyClientStatusTransition,
  buildCreateTodoRequest,
  buildUpdateTodoRequest,
  clearLinkedEntity,
  draftFromTodo,
  emptyTodoFormDraft,
  kanbanColumnLabelKey,
  priorityLabelKey,
  removeTag,
  setLinkedEntityId,
  setLinkedEntityKind,
  statusLabelKey,
  todoDetailView,
  validateTodoForm,
} from '../src/pages/todos-page-state';

function makeTodo(overrides: Partial<Todo> = {}, payload: Partial<Todo['payload']> = {}): Todo {
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

describe('todoDetailView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(todoDetailView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(todoDetailView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the ready branch with the todo envelope', () => {
    const todo = makeTodo();
    const view = todoDetailView({ status: 'ready', todo });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.todo.slug).toBe('call-ami');
    }
  });
});

describe('draftFromTodo', () => {
  it('populates the draft from the loaded payload', () => {
    const draft = draftFromTodo(
      makeTodo(
        {},
        {
          status: 'in_progress',
          priority: 2,
          description: 'Volg op met de directeur',
          dueAt: '2026-05-30',
          tags: ['urgent', 'sales'],
          linkedEntityRef: {
            kind: 'company',
            entityId: '00000000-0000-0000-0000-000000000099',
          },
        },
      ),
    );
    expect(draft.title).toBe('Call AMI BV');
    expect(draft.status).toBe('in_progress');
    expect(draft.priority).toBe(2);
    expect(draft.description).toBe('Volg op met de directeur');
    expect(draft.dueAt).toBe('2026-05-30');
    expect(draft.tags).toEqual(['urgent', 'sales']);
    expect(draft.linkedKind).toBe('company');
    expect(draft.linkedEntityId).toBe('00000000-0000-0000-0000-000000000099');
  });

  it('defaults linkedKind to "none" when the payload has no link', () => {
    const draft = draftFromTodo(makeTodo());
    expect(draft.linkedKind).toBe('none');
    expect(draft.linkedEntityId).toBeNull();
    expect(draft.tags).toEqual([]);
  });
});

describe('applyClientStatusTransition', () => {
  const nowIso = '2026-05-24T13:00:00.000Z';

  it('stamps completedAt when transitioning into done with an empty slot', () => {
    const next = applyClientStatusTransition(emptyTodoFormDraft(), 'done', nowIso);
    expect(next.status).toBe('done');
    expect(next.completedAt).toBe(nowIso);
  });

  it('preserves an existing completedAt when transitioning into done', () => {
    const previousIso = '2026-05-20T10:00:00.000Z';
    const draft = { ...emptyTodoFormDraft(), status: 'open' as const, completedAt: previousIso };
    const next = applyClientStatusTransition(draft, 'done', nowIso);
    expect(next.status).toBe('done');
    // The slot was already set — don't overwrite.
    expect(next.completedAt).toBe(previousIso);
  });

  it('clears completedAt when transitioning out of done', () => {
    const draft = {
      ...emptyTodoFormDraft(),
      status: 'done' as const,
      completedAt: nowIso,
    };
    const next = applyClientStatusTransition(draft, 'open', nowIso);
    expect(next.status).toBe('open');
    expect(next.completedAt).toBe('');
  });

  it('is idempotent on no-op same-status transitions', () => {
    const draft = { ...emptyTodoFormDraft(), status: 'open' as const };
    const next = applyClientStatusTransition(draft, 'open', nowIso);
    expect(next).toBe(draft);
  });

  it('does not stamp completedAt for non-done transitions from open', () => {
    const draft = { ...emptyTodoFormDraft(), status: 'open' as const };
    const next = applyClientStatusTransition(draft, 'in_progress', nowIso);
    expect(next.status).toBe('in_progress');
    expect(next.completedAt).toBe('');
  });
});

describe('linked-entity picker reducer', () => {
  it('switching kind clears the previously-picked id', () => {
    const draft = {
      ...emptyTodoFormDraft(),
      linkedKind: 'company' as const,
      linkedEntityId: '00000000-0000-0000-0000-000000000001',
    };
    const next = setLinkedEntityKind(draft, 'contact');
    expect(next.linkedKind).toBe('contact');
    expect(next.linkedEntityId).toBeNull();
  });

  it('setting kind to "none" clears both kind and id', () => {
    const draft = {
      ...emptyTodoFormDraft(),
      linkedKind: 'company' as const,
      linkedEntityId: '00000000-0000-0000-0000-000000000001',
    };
    const next = setLinkedEntityKind(draft, 'none');
    expect(next.linkedKind).toBe('none');
    expect(next.linkedEntityId).toBeNull();
  });

  it('setLinkedEntityId is a no-op when kind is "none"', () => {
    const draft = emptyTodoFormDraft();
    const next = setLinkedEntityId(draft, '00000000-0000-0000-0000-000000000001');
    expect(next).toBe(draft);
  });

  it('setLinkedEntityId updates the id when a kind is selected', () => {
    const draft = { ...emptyTodoFormDraft(), linkedKind: 'contact' as const };
    const next = setLinkedEntityId(draft, '00000000-0000-0000-0000-000000000002');
    expect(next.linkedKind).toBe('contact');
    expect(next.linkedEntityId).toBe('00000000-0000-0000-0000-000000000002');
  });

  it('clearLinkedEntity returns a draft with no link', () => {
    const draft = {
      ...emptyTodoFormDraft(),
      linkedKind: 'contact' as const,
      linkedEntityId: '00000000-0000-0000-0000-000000000002',
    };
    const next = clearLinkedEntity(draft);
    expect(next.linkedKind).toBe('none');
    expect(next.linkedEntityId).toBeNull();
  });
});

describe('tags editor', () => {
  it('adds a trimmed, lowercased tag', () => {
    const next = addTag(emptyTodoFormDraft(), '  Urgent  ');
    expect(next.tags).toEqual(['urgent']);
  });

  it('rejects duplicates by case-insensitive value', () => {
    let d = addTag(emptyTodoFormDraft(), 'urgent');
    d = addTag(d, 'URGENT');
    expect(d.tags).toEqual(['urgent']);
  });

  it('rejects empty tags', () => {
    const d = addTag(emptyTodoFormDraft(), '   ');
    expect(d.tags).toEqual([]);
  });

  it('caps the tag list at 16 entries', () => {
    let d = emptyTodoFormDraft();
    for (let i = 0; i < 20; i += 1) d = addTag(d, `tag-${i}`);
    expect(d.tags).toHaveLength(16);
  });

  it('removes the tag at the given index', () => {
    let d = addTag(emptyTodoFormDraft(), 'a');
    d = addTag(d, 'b');
    d = addTag(d, 'c');
    const next = removeTag(d, 1);
    expect(next.tags).toEqual(['a', 'c']);
  });

  it('removeTag is a no-op on out-of-range indices', () => {
    const d = addTag(emptyTodoFormDraft(), 'a');
    expect(removeTag(d, -1)).toBe(d);
    expect(removeTag(d, 5)).toBe(d);
  });
});

describe('validateTodoForm', () => {
  it('returns null for a minimal valid draft', () => {
    const d = { ...emptyTodoFormDraft(), title: 'Buy milk' };
    expect(validateTodoForm(d)).toBeNull();
  });

  it('flags an empty title', () => {
    expect(validateTodoForm(emptyTodoFormDraft())).toBe('errors.entity.todos.validation');
  });

  it('flags a malformed dueAt', () => {
    const d = { ...emptyTodoFormDraft(), title: 'x', dueAt: 'not-a-date' };
    expect(validateTodoForm(d)).toBe('errors.entity.todos.validation');
  });

  it('flags a missing linkedEntityId when a kind is picked', () => {
    const d = {
      ...emptyTodoFormDraft(),
      title: 'x',
      linkedKind: 'company' as const,
      linkedEntityId: null,
    };
    expect(validateTodoForm(d)).toBe('errors.entity.todos.validation');
  });

  it('flags duplicate tags', () => {
    const d = { ...emptyTodoFormDraft(), title: 'x', tags: ['a', 'a'] };
    expect(validateTodoForm(d)).toBe('errors.entity.todos.tagDuplicate');
  });
});

describe('payload builders', () => {
  it('produces a clean create body with the minimum required fields', () => {
    const d = { ...emptyTodoFormDraft(), title: 'Buy milk' };
    const body = buildCreateTodoRequest(d, 'en');
    expect(body.title).toBe('Buy milk');
    expect(body.originalLocale).toBe('en');
    expect(body.payload.status).toBe('open');
    expect(body.payload.priority).toBe(3);
    expect(body.payload.dueAt).toBeUndefined();
    expect(body.payload.linkedEntityRef).toBeUndefined();
    expect(body.payload.tags).toBeUndefined();
  });

  it('omits empty optional fields when building an update', () => {
    const d = { ...emptyTodoFormDraft(), title: 'Buy milk', description: '   ' };
    const body = buildUpdateTodoRequest(d);
    expect(body.payload.description).toBeUndefined();
  });

  it('includes the linked-entity ref when a kind + id are set', () => {
    const d = {
      ...emptyTodoFormDraft(),
      title: 'Call AMI',
      linkedKind: 'company' as const,
      linkedEntityId: '00000000-0000-0000-0000-000000000099',
    };
    const body = buildCreateTodoRequest(d, 'nl');
    expect(body.payload.linkedEntityRef).toEqual({
      kind: 'company',
      entityId: '00000000-0000-0000-0000-000000000099',
    });
  });

  it('dedupes and lowercases tags before sending', () => {
    const d = { ...emptyTodoFormDraft(), title: 'x', tags: ['Urgent', 'urgent', 'Sales'] };
    const body = buildUpdateTodoRequest(d);
    expect(body.payload.tags).toEqual(['urgent', 'sales']);
  });
});

describe('label key derivation', () => {
  it('maps every status to a stable i18n key', () => {
    expect(statusLabelKey('open')).toBe('entity.todos.statusOpen');
    expect(statusLabelKey('in_progress')).toBe('entity.todos.statusInProgress');
    expect(statusLabelKey('blocked')).toBe('entity.todos.statusBlocked');
    expect(statusLabelKey('done')).toBe('entity.todos.statusDone');
    expect(statusLabelKey('cancelled')).toBe('entity.todos.statusCancelled');
  });

  it('maps every kanban column to a stable i18n key', () => {
    expect(kanbanColumnLabelKey('open')).toBe('entity.todos.kanbanColumnOpen');
    expect(kanbanColumnLabelKey('cancelled')).toBe('entity.todos.kanbanColumnCancelled');
  });

  it('maps every priority to a stable i18n key', () => {
    expect(priorityLabelKey(1)).toBe('entity.todos.priority1');
    expect(priorityLabelKey(3)).toBe('entity.todos.priority3');
    expect(priorityLabelKey(5)).toBe('entity.todos.priority5');
  });
});
