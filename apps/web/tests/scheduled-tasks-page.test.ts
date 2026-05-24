/**
 * Phase 5.6 — pure-logic tests for `ScheduledTasksListPage` +
 * `CreateScheduledTaskDialog`.
 *
 * The repo has no DOM runtime yet (see `docs/dev/follow-ups/
 * web-component-tests.md`), so this file mirrors the other widget /
 * page tests: exercise the pure reducer + the validation function
 * the page delegates branch selection / form rules to.
 *
 * Covers:
 *   - `scheduledTasksListView` maps loading / error / empty / ready
 *     inputs to the render branch the component reads.
 *   - `validateScheduledTaskForm` enforces the same rules
 *     `CreateScheduledTaskRequestSchema` does on the server side —
 *     required name + kind, cron shape, interval positivity,
 *     backoffMax >= backoffBase.
 *   - `buildCreateScheduledTaskRequest` projects the form draft into
 *     the wire shape consumed by `createScheduledTask`, omitting
 *     `slug` when blank (server then derives one).
 *   - `slugifyScheduledTaskName` matches the server's slug derivation
 *     so the read-only preview never diverges from what the server
 *     will persist.
 */
import { describe, expect, it } from 'bun:test';
import {
  buildCreateScheduledTaskRequest,
  emptyScheduledTaskFormDraft,
  scheduledTasksListView,
  slugifyScheduledTaskName,
  validateScheduledTaskForm,
  type ScheduledTaskFormDraft,
  type ScheduledTasksListInput,
} from '../src/pages/scheduled-tasks-page-state';
import type { ScheduledTaskSummary } from '../src/lib/api-types';

function makeTask(slug: string): ScheduledTaskSummary {
  return {
    id: `id-${slug}`,
    layerId: 'layer-1',
    slug,
    kind: 'test.kind',
    name: slug,
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 60 },
    maxAttempts: 3,
    backoffBaseMs: 60000,
    backoffMaxMs: 3600000,
    nextRunAt: '2026-05-24T07:00:00.000Z',
    lastRunAt: null,
    attempt: 0,
    version: 1,
    createdAt: '2026-05-24T07:00:00.000Z',
    createdBy: 'user-1',
    updatedAt: '2026-05-24T07:00:00.000Z',
    updatedBy: 'user-1',
    deletedAt: null,
  };
}

describe('scheduledTasksListView', () => {
  it('returns the loading branch for a loading input', () => {
    const input: ScheduledTasksListInput = { status: 'loading' };
    expect(scheduledTasksListView(input)).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    const input: ScheduledTasksListInput = { status: 'error', errorKey: 'errors.network' };
    expect(scheduledTasksListView(input)).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the empty branch when the task list is empty', () => {
    const input: ScheduledTasksListInput = { status: 'ready', tasks: [] };
    expect(scheduledTasksListView(input)).toEqual({ kind: 'empty' });
  });

  it('returns the ready branch when the list has rows', () => {
    const input: ScheduledTasksListInput = {
      status: 'ready',
      tasks: [makeTask('a'), makeTask('b')],
    };
    const out = scheduledTasksListView(input);
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.tasks).toHaveLength(2);
      expect(out.tasks[0]?.slug).toBe('a');
    }
  });
});

describe('validateScheduledTaskForm', () => {
  function validCron(): ScheduledTaskFormDraft {
    return { ...emptyScheduledTaskFormDraft(), name: 'My Job', kind: 'test.kind' };
  }
  function validInterval(): ScheduledTaskFormDraft {
    return { ...validCron(), scheduleKind: 'interval' };
  }

  it('rejects an empty name', () => {
    expect(validateScheduledTaskForm({ ...emptyScheduledTaskFormDraft(), kind: 'k' })).toBe(
      'scheduledTasks.dialog.validation.nameRequired',
    );
  });

  it('rejects an empty kind', () => {
    expect(
      validateScheduledTaskForm({ ...emptyScheduledTaskFormDraft(), name: 'X', kind: '' }),
    ).toBe('scheduledTasks.dialog.validation.kindRequired');
  });

  it('rejects an empty cron expression', () => {
    expect(validateScheduledTaskForm({ ...validCron(), cronExpression: '' })).toBe(
      'scheduledTasks.dialog.validation.cronEmpty',
    );
  });

  it('rejects a cron expression with the wrong number of fields', () => {
    expect(validateScheduledTaskForm({ ...validCron(), cronExpression: '* * *' })).toBe(
      'scheduledTasks.dialog.validation.cronShape',
    );
  });

  it('rejects an empty cron timezone', () => {
    expect(validateScheduledTaskForm({ ...validCron(), cronTimezone: '' })).toBe(
      'scheduledTasks.dialog.validation.cronTimezoneRequired',
    );
  });

  it('rejects a non-positive interval', () => {
    expect(validateScheduledTaskForm({ ...validInterval(), intervalMinutes: '0' })).toBe(
      'scheduledTasks.dialog.validation.intervalPositive',
    );
    expect(validateScheduledTaskForm({ ...validInterval(), intervalMinutes: '-3' })).toBe(
      'scheduledTasks.dialog.validation.intervalPositive',
    );
    expect(validateScheduledTaskForm({ ...validInterval(), intervalMinutes: 'abc' })).toBe(
      'scheduledTasks.dialog.validation.intervalPositive',
    );
  });

  it('rejects backoffMax smaller than backoffBase', () => {
    expect(
      validateScheduledTaskForm({
        ...validInterval(),
        backoffBaseMs: '10000',
        backoffMaxMs: '5000',
      }),
    ).toBe('scheduledTasks.dialog.validation.backoffOrder');
  });

  it('accepts a well-formed cron draft', () => {
    expect(validateScheduledTaskForm(validCron())).toBeNull();
  });

  it('accepts a well-formed interval draft', () => {
    expect(validateScheduledTaskForm(validInterval())).toBeNull();
  });
});

describe('buildCreateScheduledTaskRequest', () => {
  it('omits slug when the field is blank so the server derives one', () => {
    const draft: ScheduledTaskFormDraft = {
      ...emptyScheduledTaskFormDraft(),
      name: 'My Job',
      kind: 'test.kind',
      scheduleKind: 'interval',
    };
    const out = buildCreateScheduledTaskRequest(draft);
    expect(out.name).toBe('My Job');
    expect(out.kind).toBe('test.kind');
    expect(out.schedule).toEqual({ kind: 'interval', intervalMinutes: 60 });
    expect(out.maxAttempts).toBe(3);
    expect(out.backoffBaseMs).toBe(60000);
    expect(out.backoffMaxMs).toBe(3600000);
    expect('slug' in out).toBe(false);
  });

  it('passes through a user-provided slug', () => {
    const out = buildCreateScheduledTaskRequest({
      ...emptyScheduledTaskFormDraft(),
      name: 'My Job',
      kind: 'test.kind',
      slug: 'custom-slug',
      scheduleKind: 'interval',
    });
    expect(out.slug).toBe('custom-slug');
  });

  it('emits a cron schedule when scheduleKind is cron', () => {
    const out = buildCreateScheduledTaskRequest({
      ...emptyScheduledTaskFormDraft(),
      name: 'Monday',
      kind: 'test.kind',
      scheduleKind: 'cron',
      cronExpression: '0 7 * * MON',
      cronTimezone: 'Europe/Amsterdam',
    });
    expect(out.schedule).toEqual({
      kind: 'cron',
      cronExpression: '0 7 * * MON',
      cronTimezone: 'Europe/Amsterdam',
    });
  });
});

describe('slugifyScheduledTaskName', () => {
  it('lowercases + dashes + strips leading/trailing punctuation', () => {
    expect(slugifyScheduledTaskName('My Weekly Digest!')).toBe('my-weekly-digest');
  });

  it('caps at 64 characters', () => {
    expect(slugifyScheduledTaskName('a'.repeat(120)).length).toBeLessThanOrEqual(64);
  });
});
