import { z } from 'zod';

/**
 * Cross-package zod schemas for the generic scheduled-task domain
 * (phase 5.0).
 *
 * Server-internal row types live in
 * `apps/server/src/scheduled/repo.ts`; these schemas describe the
 * safe shape that crosses the HTTP boundary and is shared with the
 * web client. Timestamps are ISO-8601 strings, like the rest of the
 * shared package.
 *
 * Two schedule modes are accepted, mirrored 1:1 against the SQL
 * `schedule_kind` CHECK in `0012_scheduled_tasks.sql`:
 *
 *   - `cron`     — a 5-field cron string + IANA timezone. The
 *                  scheduler service evaluates the next firing time
 *                  with `croner`; `next_run_at` is persisted in UTC.
 *   - `interval` — every N minutes from `last_run_at` (or
 *                  `created_at` for the first run).
 *
 * The two are mutually exclusive at the zod discriminated-union
 * boundary AND at the SQL CHECK. A zod parse cannot produce a row
 * that violates the CHECK; the CHECK is a defensive backstop for
 * a stray bypass (e.g. a future migration or a direct SQL probe).
 *
 * Run statuses mirror the bus event lifecycle declared in the
 * phase-5 plan §7. The seven values are the closed set; the
 * runner cannot emit anything else.
 */

// ---------- schedule ---------------------------------------------------

/**
 * 5-field cron. Validated only superficially here (5 whitespace-
 * separated tokens) — the authoritative parse lives in `croner` on
 * the server. We avoid re-implementing cron in the schema because
 * DST + leap-year edge cases belong to one library.
 */
export const CronExpressionSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^\s*\S+(\s+\S+){4,5}\s*$/, 'cron must be 5 or 6 whitespace-separated fields');

/**
 * IANA timezone — we accept any non-empty short-to-mid string and
 * let `croner` reject invalid zones at runtime; pre-validating
 * against an embedded zone list would bloat the shared package.
 */
export const TimezoneSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9+\-_/.]+$/, 'timezone must be an IANA tz string');

export const ScheduleKindSchema = z.enum(['cron', 'interval']);
export type ScheduleKind = z.infer<typeof ScheduleKindSchema>;

export const CronScheduleSchema = z
  .object({
    kind: z.literal('cron'),
    cronExpression: CronExpressionSchema,
    cronTimezone: TimezoneSchema,
  })
  .strict();
export type CronSchedule = z.infer<typeof CronScheduleSchema>;

export const IntervalScheduleSchema = z
  .object({
    kind: z.literal('interval'),
    intervalMinutes: z
      .number()
      .int()
      .min(1)
      .max(60 * 24 * 365),
  })
  .strict();
export type IntervalSchedule = z.infer<typeof IntervalScheduleSchema>;

export const ScheduledTaskScheduleSchema = z.discriminatedUnion('kind', [
  CronScheduleSchema,
  IntervalScheduleSchema,
]);
export type ScheduledTaskSchedule = z.infer<typeof ScheduledTaskScheduleSchema>;

// ---------- task summary -----------------------------------------------

export const ScheduledTaskStatusSchema = z.enum(['active', 'paused', 'canceled']);
export type ScheduledTaskStatus = z.infer<typeof ScheduledTaskStatusSchema>;

/**
 * Reason a task is in the `paused` state. `manual` is a user/admin
 * action; `max_attempts` is the runner auto-pausing after the
 * retry budget is exhausted. Stored on the task row so the UI can
 * surface the right copy without joining the run history.
 */
export const ScheduledTaskPauseReasonSchema = z.enum(['manual', 'max_attempts']);
export type ScheduledTaskPauseReason = z.infer<typeof ScheduledTaskPauseReasonSchema>;

export const ScheduledTaskSummarySchema = z
  .object({
    id: z.string().uuid(),
    layerId: z.string().uuid(),
    slug: z.string().min(1),
    kind: z.string().min(1),
    name: z.string().min(1),
    status: ScheduledTaskStatusSchema,
    pauseReason: ScheduledTaskPauseReasonSchema.nullable(),
    schedule: ScheduledTaskScheduleSchema,
    maxAttempts: z.number().int().positive(),
    backoffBaseMs: z.number().int().positive(),
    backoffMaxMs: z.number().int().positive(),
    nextRunAt: z.string(),
    lastRunAt: z.string().nullable(),
    attempt: z.number().int().min(0),
    version: z.number().int().positive(),
    createdAt: z.string(),
    createdBy: z.string().uuid(),
    updatedAt: z.string(),
    updatedBy: z.string().uuid(),
    deletedAt: z.string().nullable(),
  })
  .strict();
export type ScheduledTaskSummary = z.infer<typeof ScheduledTaskSummarySchema>;

// ---------- run summary ------------------------------------------------

export const ScheduledTaskRunStatusSchema = z.enum([
  'requested',
  'started',
  'succeeded',
  'failed',
  'skipped_offline',
  'skipped_no_handler',
  'skipped_crashed',
]);
export type ScheduledTaskRunStatus = z.infer<typeof ScheduledTaskRunStatusSchema>;

export const ScheduledTaskRunTriggerSchema = z.enum(['schedule', 'manual', 'retry']);
export type ScheduledTaskRunTrigger = z.infer<typeof ScheduledTaskRunTriggerSchema>;

export const ScheduledTaskRunSummarySchema = z
  .object({
    id: z.string().uuid(),
    taskId: z.string().uuid(),
    status: ScheduledTaskRunStatusSchema,
    attempt: z.number().int().min(0),
    triggeredBy: ScheduledTaskRunTriggerSchema,
    requestedAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    durationMs: z.number().int().min(0).nullable(),
    error: z.string().nullable(),
    correlationId: z.string().nullable(),
  })
  .strict();
export type ScheduledTaskRunSummary = z.infer<typeof ScheduledTaskRunSummarySchema>;

// ---------- HTTP request shapes (consumed in phase 5.4) ----------------

/**
 * `POST /l/:slug/scheduled-tasks`. The route resolves the layer and
 * the acting user; the body carries the registered handler `kind`,
 * a human-readable `name`, the schedule, optional retry tuning, and
 * an opaque handler-specific `config`.
 *
 * `slug` is optional: when omitted the server derives it from `name`
 * (mirrors the 4d.1 / 4c.1 precedent). Validated against the same
 * URL-safe pattern entity slugs use.
 */
export const CreateScheduledTaskRequestSchema = z
  .object({
    name: z.string().min(1).max(160),
    slug: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and dashes')
      .optional(),
    kind: z.string().min(1).max(128),
    schedule: ScheduledTaskScheduleSchema,
    config: z.record(z.unknown()).optional(),
    maxAttempts: z.number().int().positive().max(100).optional(),
    backoffBaseMs: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1000)
      .optional(),
    backoffMaxMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1000)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.backoffBaseMs !== undefined &&
      v.backoffMaxMs !== undefined &&
      v.backoffMaxMs < v.backoffBaseMs
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backoffMaxMs'],
        message: 'backoffMaxMs must be >= backoffBaseMs',
      });
    }
  });
export type CreateScheduledTaskRequest = z.infer<typeof CreateScheduledTaskRequestSchema>;

/**
 * `PATCH /l/:slug/scheduled-tasks/:taskSlug`. Every field is
 * optional; an empty PATCH is a no-op. The runner-only fields
 * (`attempt`, `claimedAt`, `nextRunAt`, `lastRunAt`) are not
 * editable via the HTTP API — they're managed by the scheduler
 * service in phase 5.3. `status` accepts only `active|paused`
 * (manual resume / pause); `canceled` is reached via DELETE.
 */
export const UpdateScheduledTaskRequestSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    schedule: ScheduledTaskScheduleSchema.optional(),
    status: z.enum(['active', 'paused']).optional(),
    config: z.record(z.unknown()).optional(),
    maxAttempts: z.number().int().positive().max(100).optional(),
    backoffBaseMs: z
      .number()
      .int()
      .positive()
      .max(60 * 60 * 1000)
      .optional(),
    backoffMaxMs: z
      .number()
      .int()
      .positive()
      .max(24 * 60 * 60 * 1000)
      .optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (
      v.backoffBaseMs !== undefined &&
      v.backoffMaxMs !== undefined &&
      v.backoffMaxMs < v.backoffBaseMs
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['backoffMaxMs'],
        message: 'backoffMaxMs must be >= backoffBaseMs',
      });
    }
  });
export type UpdateScheduledTaskRequest = z.infer<typeof UpdateScheduledTaskRequestSchema>;
