/**
 * Phase 4 (ui-exposure-gaps) — smoke + state-projection tests for
 * `AdminScheduledTaskRunsPage`.
 *
 * Same shape as `admin-user-detail-page.test.ts` /
 * `scheduled-tasks-page.test.ts`: pure-logic exercise of the view
 * reducer + helpers the component delegates branch selection and row
 * expansion to. The repo has no DOM runtime
 * (`docs/dev/follow-ups/web-component-tests.md`); these tests are the
 * "happy-path render" proxy.
 */
import { describe, expect, it } from 'bun:test';
import {
  adminScheduledTaskRunsView,
  runDetailsJson,
  toggleExpandedRun,
  type AdminScheduledTaskRunsInput,
} from '../src/pages/admin/admin-scheduled-task-runs-page-state';
import type {
  AdminScheduledTaskRow,
  ScheduledTaskRunSummary,
  ScheduledTaskRunStatus,
} from '../src/lib/api-types';

function makeRun(overrides: Partial<ScheduledTaskRunSummary> = {}): ScheduledTaskRunSummary {
  return {
    id: 'run-1',
    taskId: 'task-1',
    status: 'succeeded' as ScheduledTaskRunStatus,
    attempt: 1,
    triggeredBy: 'schedule',
    requestedAt: '2026-05-25T00:00:00.000Z',
    startedAt: '2026-05-25T00:00:01.000Z',
    finishedAt: '2026-05-25T00:00:02.000Z',
    durationMs: 1000,
    error: null,
    correlationId: 'corr-1',
    ...overrides,
  };
}

function makeTask(overrides: Partial<AdminScheduledTaskRow> = {}): AdminScheduledTaskRow {
  return {
    id: 'task-1',
    layerId: 'layer-1',
    slug: 'sync-pim',
    kind: 'pim.sync',
    name: 'Sync PIM',
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 60 },
    maxAttempts: 3,
    backoffBaseMs: 60000,
    backoffMaxMs: 3600000,
    nextRunAt: '2026-05-25T01:00:00.000Z',
    lastRunAt: null,
    attempt: 0,
    version: 1,
    createdAt: '2026-05-25T00:00:00.000Z',
    createdBy: 'user-1',
    updatedAt: '2026-05-25T00:00:00.000Z',
    updatedBy: 'user-1',
    deletedAt: null,
    layerSlug: 'demo',
    ...overrides,
  };
}

describe('adminScheduledTaskRunsView', () => {
  it('returns the loading branch for a loading input', () => {
    const input: AdminScheduledTaskRunsInput = { status: 'loading' };
    expect(adminScheduledTaskRunsView(input)).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    const input: AdminScheduledTaskRunsInput = {
      status: 'error',
      errorKey: 'errors.network',
    };
    expect(adminScheduledTaskRunsView(input)).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the empty branch when the runs list is empty', () => {
    const task = makeTask();
    const out = adminScheduledTaskRunsView({ status: 'ready', runs: [], task });
    expect(out).toEqual({ kind: 'empty', task });
  });

  it('returns the ready branch with the run rows in order', () => {
    const runs = [makeRun({ id: 'a' }), makeRun({ id: 'b' })];
    const out = adminScheduledTaskRunsView({ status: 'ready', runs, task: null });
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.runs.map((r) => r.id)).toEqual(['a', 'b']);
      expect(out.task).toBeNull();
    }
  });
});

describe('toggleExpandedRun', () => {
  it('adds an id that was not present', () => {
    const next = toggleExpandedRun(new Set<string>(), 'run-1');
    expect(Array.from(next)).toEqual(['run-1']);
  });

  it('removes an id that was present', () => {
    const next = toggleExpandedRun(new Set(['run-1', 'run-2']), 'run-1');
    expect(Array.from(next).sort()).toEqual(['run-2']);
  });

  it('returns a fresh Set so React reference checks fire', () => {
    const prev = new Set(['run-1']);
    const next = toggleExpandedRun(prev, 'run-2');
    expect(next).not.toBe(prev);
  });
});

describe('runDetailsJson', () => {
  it('exposes the run fields admins need without surprise keys', () => {
    const json = runDetailsJson(makeRun({ error: 'boom' }));
    expect(Object.keys(json).sort()).toEqual(
      [
        'attempt',
        'correlationId',
        'durationMs',
        'error',
        'finishedAt',
        'id',
        'requestedAt',
        'startedAt',
        'status',
        'taskId',
        'triggeredBy',
      ].sort(),
    );
    expect(json.error).toBe('boom');
    expect(json.status).toBe('succeeded');
  });

  it('passes through nulls for an in-flight run', () => {
    const json = runDetailsJson(
      makeRun({
        status: 'requested' as ScheduledTaskRunStatus,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
      }),
    );
    expect(json.startedAt).toBeNull();
    expect(json.finishedAt).toBeNull();
    expect(json.durationMs).toBeNull();
  });
});
