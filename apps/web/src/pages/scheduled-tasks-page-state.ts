/**
 * Phase 5.6 — pure state-machine for `ScheduledTasksListPage`.
 *
 * Mirrors `todos-page-state.ts` / the four other widget-state reducers
 * so the matrix of render branches (loading / error / empty / ready)
 * is testable without a DOM runtime — see `apps/web/tests/`. The
 * component delegates branch selection here so the list page's rich
 * row-level state (expanded panels, busy markers, action toggles)
 * stays on the component side and the pure projection on this side.
 *
 * Also home for the create-dialog form draft + client-side validation,
 * mirroring the `ScheduledTaskCreateRequestSchema` rules in
 * `packages/shared/src/scheduled-tasks.ts`. We deliberately do NOT
 * import zod here — `api-types.ts` is hand-mirrored to keep the web
 * bundle zod-free; the server's zod parse is the authoritative
 * validator and a 400 from the server lands in the form's error
 * region anyway.
 */

import type {
  CreateScheduledTaskPayload,
  ScheduledTaskSchedule,
  ScheduledTaskSummary,
} from '../lib/api-types';

// ---------- list view --------------------------------------------------

export type ScheduledTasksListInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly tasks: readonly ScheduledTaskSummary[] };

export type ScheduledTasksListView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly tasks: readonly ScheduledTaskSummary[] };

export function scheduledTasksListView(input: ScheduledTasksListInput): ScheduledTasksListView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  if (input.tasks.length === 0) return { kind: 'empty' };
  return { kind: 'ready', tasks: input.tasks };
}

// ---------- create-dialog form ----------------------------------------

export type ScheduleKindDraft = 'cron' | 'interval';

export interface ScheduledTaskFormDraft {
  readonly name: string;
  readonly slug: string;
  readonly kind: string;
  readonly scheduleKind: ScheduleKindDraft;
  readonly cronExpression: string;
  readonly cronTimezone: string;
  readonly intervalMinutes: string;
  readonly maxAttempts: string;
  readonly backoffBaseMs: string;
  readonly backoffMaxMs: string;
}

export function emptyScheduledTaskFormDraft(): ScheduledTaskFormDraft {
  return {
    name: '',
    slug: '',
    kind: '',
    scheduleKind: 'cron',
    // Default cron picks a benign Monday-morning slot that mirrors the
    // plan's worked example. `Europe/Amsterdam` is the system default
    // per ADR-0009.
    cronExpression: '0 7 * * MON',
    cronTimezone: 'Europe/Amsterdam',
    intervalMinutes: '60',
    maxAttempts: '3',
    backoffBaseMs: '60000',
    backoffMaxMs: '3600000',
  };
}

/**
 * Slug derivation, matching the server's `deriveSlug` logic in
 * `apps/server/src/http/routes/scheduled-tasks.ts`. Keeps the
 * "auto-fill slug from name" UI hint in sync with what the server
 * would persist when the field is left empty.
 */
export function slugifyScheduledTaskName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Validate a draft against the same rules `CreateScheduledTaskRequestSchema`
 * enforces server-side. Returns the first violating i18n key or
 * `null` on success.
 *
 * Why hand-rolled instead of `safeParse`-ing the shared zod schema:
 * `api-types.ts` documents the zero-zod-runtime rule for the web
 * bundle. The server stays the authoritative validator.
 */
export function validateScheduledTaskForm(draft: ScheduledTaskFormDraft): string | null {
  if (draft.name.trim().length === 0) {
    return 'scheduledTasks.dialog.validation.nameRequired';
  }
  if (draft.kind.trim().length === 0) {
    return 'scheduledTasks.dialog.validation.kindRequired';
  }
  if (draft.scheduleKind === 'cron') {
    const cron = draft.cronExpression.trim();
    if (cron.length === 0) return 'scheduledTasks.dialog.validation.cronEmpty';
    // Mirror the server-side superficial shape check (5–6 whitespace-
    // separated fields). Authoritative parse runs on the server via
    // croner.
    if (!/^\s*\S+(\s+\S+){4,5}\s*$/.test(cron)) {
      return 'scheduledTasks.dialog.validation.cronShape';
    }
    if (draft.cronTimezone.trim().length === 0) {
      return 'scheduledTasks.dialog.validation.cronTimezoneRequired';
    }
  } else {
    const n = Number(draft.intervalMinutes);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) {
      return 'scheduledTasks.dialog.validation.intervalPositive';
    }
  }
  const max = Number(draft.maxAttempts);
  if (!Number.isFinite(max) || !Number.isInteger(max) || max < 1) {
    return 'scheduledTasks.dialog.validation.maxAttemptsPositive';
  }
  const base = Number(draft.backoffBaseMs);
  if (!Number.isFinite(base) || !Number.isInteger(base) || base < 1) {
    return 'scheduledTasks.dialog.validation.backoffBasePositive';
  }
  const maxMs = Number(draft.backoffMaxMs);
  if (!Number.isFinite(maxMs) || !Number.isInteger(maxMs) || maxMs < 1) {
    return 'scheduledTasks.dialog.validation.backoffMaxPositive';
  }
  if (maxMs < base) {
    return 'scheduledTasks.dialog.validation.backoffOrder';
  }
  return null;
}

/** Build the create-request body from a validated draft. */
export function buildCreateScheduledTaskRequest(
  draft: ScheduledTaskFormDraft,
): CreateScheduledTaskPayload {
  const schedule: ScheduledTaskSchedule =
    draft.scheduleKind === 'cron'
      ? {
          kind: 'cron',
          cronExpression: draft.cronExpression.trim(),
          cronTimezone: draft.cronTimezone.trim(),
        }
      : {
          kind: 'interval',
          intervalMinutes: Number(draft.intervalMinutes),
        };
  const body: CreateScheduledTaskPayload = {
    name: draft.name.trim(),
    kind: draft.kind,
    schedule,
    maxAttempts: Number(draft.maxAttempts),
    backoffBaseMs: Number(draft.backoffBaseMs),
    backoffMaxMs: Number(draft.backoffMaxMs),
  };
  const slug = draft.slug.trim();
  if (slug.length > 0) {
    return { ...body, slug };
  }
  return body;
}

// ---------- formatting helpers ----------------------------------------

export function scheduleLabelKey(_schedule: ScheduledTaskSchedule): string {
  return _schedule.kind === 'cron'
    ? 'scheduledTasks.schedule.cron'
    : 'scheduledTasks.schedule.interval';
}

export function statusLabelKey(status: 'active' | 'paused' | 'canceled'): string {
  return `scheduledTasks.status.${status}`;
}

export function runStatusLabelKey(
  status:
    | 'requested'
    | 'started'
    | 'succeeded'
    | 'failed'
    | 'skipped_offline'
    | 'skipped_no_handler'
    | 'skipped_crashed',
): string {
  return `scheduledTasks.run.status.${status}`;
}

export function triggerLabelKey(trigger: 'schedule' | 'manual' | 'retry'): string {
  return `scheduledTasks.trigger.${trigger}`;
}
