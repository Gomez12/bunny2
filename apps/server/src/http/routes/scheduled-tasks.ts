import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import {
  CreateScheduledTaskRequestSchema,
  UpdateScheduledTaskRequestSchema,
  type ScheduledTaskRunSummary,
  type ScheduledTaskSchedule,
  type ScheduledTaskSummary,
} from '@bunny2/shared';
import { canEditLayer } from '../../layers/authz';
import { createRequireLayer } from '../middleware/layer';
import { ADMIN_GROUP_ID_KEY } from '../../auth/seed';
import { getMeta } from '../../storage/kv-meta';
import type { GroupResolver } from '../../auth/group-resolver';
import type { ScheduledTask, ScheduledTaskRun, ScheduledTasksRepo } from '../../scheduled/repo';
import { getScheduledTaskHandler } from '../../scheduled/registry';
import { computeNextRun } from '../../scheduled/schedule';
import type {
  ScheduledTaskCreatedPayload,
  ScheduledTaskDeletedPayload,
  ScheduledTaskPausedPayload,
  ScheduledTaskResumedPayload,
  ScheduledTaskRunRequestedPayload,
  ScheduledTaskUpdatedPayload,
} from '../../scheduled/events';
import type { HonoVariables } from '../types';

/**
 * Phase 5.4 — `/l/:slug/scheduled-tasks/*` routes.
 *
 * Sit behind the global `requireAuth` + `requirePasswordCurrent` +
 * `withEffectiveLayers` chain wired in `router.ts`. Per-route
 * mounting uses `createRequireLayer()` so a non-member gets
 * `404 errors.layer.notVisible` exactly like `/layers/*` — see
 * `apps/server/src/http/middleware/layer.ts` for the rationale.
 *
 * Authorization (plan §8):
 *  - Read (list, get, list runs): anyone in `effectiveLayers`.
 *  - Edit (create / update / pause / resume / run-now / delete):
 *    `canEditLayer` — owner of the layer or site-admin. System jobs
 *    live in the `everyone` layer, so only admins can edit them.
 *
 * Manual run-now resolution (plan §15 #4): `POST .../runs` does NOT
 * 409 if a tick already has the task in flight. It inserts a new
 * `requested` row with `triggeredBy='manual'` and publishes
 * `scheduledtask.run.requested`. The run subscriber on the worker
 * picks it up serially through the durable pump.
 */

const BAD_REQUEST = { error: 'errors.scheduledTasks.badRequest' } as const;
const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;
const FORBIDDEN = { error: 'errors.layer.forbidden' } as const;
const NOT_FOUND = { error: 'errors.scheduledTasks.notFound' } as const;
const SLUG_TAKEN = { error: 'errors.scheduledTasks.slugTaken' } as const;
const HANDLER_UNKNOWN = { error: 'errors.scheduledTasks.handlerUnknown' } as const;
const INVALID_CRON = { error: 'errors.scheduledTasks.invalidCron' } as const;
const INVALID_INTERVAL = { error: 'errors.scheduledTasks.invalidInterval' } as const;

const DEFAULT_RUNS_LIMIT = 50;
const MAX_RUNS_LIMIT = 200;
const SLUG_PATTERN = /^[a-z0-9-]+$/;

export interface ScheduledTasksRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  readonly repo: ScheduledTasksRepo;
  readonly resolver: GroupResolver;
  readonly now?: () => Date;
}

export function registerScheduledTasksRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: ScheduledTasksRouteDeps,
): void {
  const clock = deps.now ?? ((): Date => new Date());
  const requireLayer = createRequireLayer();

  function computeIsSiteAdmin(userId: string): boolean {
    const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY);
    if (adminGroupId === null || adminGroupId === '') return false;
    return deps.resolver.isUserInGroup(userId, adminGroupId);
  }

  // ---------- GET /l/:slug/scheduled-tasks --------------------------------

  app.get('/l/:slug/scheduled-tasks', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const tasks = deps.repo.listTasks({ layerId: layer.id });
    return c.json({ tasks: tasks.map(toSummary) });
  });

  // ---------- GET /l/:slug/scheduled-tasks/:taskSlug ----------------------

  app.get('/l/:slug/scheduled-tasks/:taskSlug', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const task = deps.repo.getTaskBySlug(layer.id, c.req.param('taskSlug'));
    if (task === null || task.deletedAt !== null) return c.json(NOT_FOUND, 404);
    return c.json({ task: toSummary(task) });
  });

  // ---------- POST /l/:slug/scheduled-tasks -------------------------------

  app.post('/l/:slug/scheduled-tasks', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = CreateScheduledTaskRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(scheduleErrorFromZod(parsed.error.issues), 400);
    }
    const body = parsed.data;

    if (getScheduledTaskHandler(body.kind) === null) {
      return c.json(HANDLER_UNKNOWN, 400);
    }

    const slug = body.slug ?? deriveSlug(body.name);
    if (!SLUG_PATTERN.test(slug)) {
      return c.json(BAD_REQUEST, 400);
    }
    if (deps.repo.getTaskBySlug(layer.id, slug) !== null) {
      return c.json(SLUG_TAKEN, 409);
    }

    const now = clock();
    let nextRunAt: string;
    try {
      nextRunAt = computeNextRun(body.schedule, now).toISOString();
    } catch (err) {
      console.error('[scheduled-tasks] computeNextRun failed:', err);
      // `croner` throws on invalid cron expressions at runtime even
      // though the zod schema accepted the string shape.
      return c.json(body.schedule.kind === 'cron' ? INVALID_CRON : INVALID_INTERVAL, 422);
    }

    const id = crypto.randomUUID();
    const nowIso = now.toISOString();
    let created: ScheduledTask;
    try {
      created = deps.repo.insertTask({
        id,
        layerId: layer.id,
        slug,
        kind: body.kind,
        name: body.name,
        schedule: body.schedule,
        ...(body.config === undefined ? {} : { config: body.config }),
        ...(body.maxAttempts === undefined ? {} : { maxAttempts: body.maxAttempts }),
        ...(body.backoffBaseMs === undefined ? {} : { backoffBaseMs: body.backoffBaseMs }),
        ...(body.backoffMaxMs === undefined ? {} : { backoffMaxMs: body.backoffMaxMs }),
        nextRunAt,
        createdBy: user.id,
        now: nowIso,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('unique')) {
        return c.json(SLUG_TAKEN, 409);
      }
      console.error('[scheduled-tasks] insertTask failed:', err);
      return c.json(BAD_REQUEST, 400);
    }

    const payload: ScheduledTaskCreatedPayload = {
      taskId: created.id,
      layerId: created.layerId,
      kind: created.kind,
      slug: created.slug,
      scheduleKind: created.schedule.kind,
      createdBy: user.id,
    };
    await deps.bus.publish({ type: 'scheduledtask.created', payload, correlationId });
    return c.json({ task: toSummary(created) }, 201);
  });

  // ---------- PATCH /l/:slug/scheduled-tasks/:taskSlug --------------------

  app.patch('/l/:slug/scheduled-tasks/:taskSlug', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    const existing = deps.repo.getTaskBySlug(layer.id, c.req.param('taskSlug'));
    if (existing === null || existing.deletedAt !== null) return c.json(NOT_FOUND, 404);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = UpdateScheduledTaskRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return c.json(scheduleErrorFromZod(parsed.error.issues), 400);
    }
    // `status` lives on the shared schema for future use, but pause /
    // resume own that transition — drop it here.
    const { status: _ignoredStatus, ...body } = parsed.data;
    void _ignoredStatus;

    // Build the patch via a spread so `exactOptionalPropertyTypes`
    // does not see a key with value `undefined`. Computing
    // `nextRunAt` lives next to the schedule branch so an invalid
    // cron / interval can short-circuit before any update fires.
    let computedNextRunAt: string | null = null;
    if (body.schedule !== undefined) {
      const now = clock();
      try {
        computedNextRunAt = computeNextRun(body.schedule, now).toISOString();
      } catch (err) {
        console.error('[scheduled-tasks] computeNextRun failed on patch:', err);
        return c.json(body.schedule.kind === 'cron' ? INVALID_CRON : INVALID_INTERVAL, 422);
      }
    }
    const patch = {
      ...(body.name === undefined ? {} : { name: body.name }),
      ...(body.config === undefined ? {} : { config: body.config }),
      ...(body.maxAttempts === undefined ? {} : { maxAttempts: body.maxAttempts }),
      ...(body.backoffBaseMs === undefined ? {} : { backoffBaseMs: body.backoffBaseMs }),
      ...(body.backoffMaxMs === undefined ? {} : { backoffMaxMs: body.backoffMaxMs }),
      ...(body.schedule === undefined ? {} : { schedule: body.schedule as ScheduledTaskSchedule }),
      ...(computedNextRunAt === null ? {} : { nextRunAt: computedNextRunAt }),
    };

    const updated = deps.repo.updateTask(existing.id, patch, user.id, clock().toISOString());

    const payload: ScheduledTaskUpdatedPayload = {
      taskId: updated.id,
      patch: serializePatchForEvent(body),
      updatedBy: user.id,
    };
    await deps.bus.publish({ type: 'scheduledtask.updated', payload, correlationId });
    return c.json({ task: toSummary(updated) });
  });

  // ---------- DELETE /l/:slug/scheduled-tasks/:taskSlug -------------------

  app.delete('/l/:slug/scheduled-tasks/:taskSlug', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    const existing = deps.repo.getTaskBySlug(layer.id, c.req.param('taskSlug'));
    if (existing === null || existing.deletedAt !== null) return c.json(NOT_FOUND, 404);

    deps.repo.softDeleteTask(existing.id, user.id, clock().toISOString());

    const payload: ScheduledTaskDeletedPayload = {
      taskId: existing.id,
      slug: existing.slug,
      deletedBy: user.id,
    };
    await deps.bus.publish({ type: 'scheduledtask.deleted', payload, correlationId });
    return c.json({ ok: true });
  });

  // ---------- POST /l/:slug/scheduled-tasks/:taskSlug/pause ---------------

  app.post('/l/:slug/scheduled-tasks/:taskSlug/pause', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    const existing = deps.repo.getTaskBySlug(layer.id, c.req.param('taskSlug'));
    if (existing === null || existing.deletedAt !== null) return c.json(NOT_FOUND, 404);

    const nowIso = clock().toISOString();
    const updated = deps.repo.setTaskStatus(existing.id, 'paused', 'manual', user.id, nowIso);

    const payload: ScheduledTaskPausedPayload = {
      taskId: existing.id,
      reason: 'manual',
      actorId: user.id,
    };
    await deps.bus.publish({ type: 'scheduledtask.paused', payload, correlationId });
    return c.json({ task: toSummary(updated) });
  });

  // ---------- POST /l/:slug/scheduled-tasks/:taskSlug/resume --------------

  app.post('/l/:slug/scheduled-tasks/:taskSlug/resume', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    const existing = deps.repo.getTaskBySlug(layer.id, c.req.param('taskSlug'));
    if (existing === null || existing.deletedAt !== null) return c.json(NOT_FOUND, 404);

    const now = clock();
    const nowIso = now.toISOString();
    const resumed = deps.repo.setTaskStatus(existing.id, 'active', null, user.id, nowIso);

    // Re-anchor `next_run_at` forward when the previous value already
    // sailed past. The runner auto-pause path sets `next_run_at` to the
    // next cron slot on entry into `paused`, but a long manual pause
    // can still leave it stale.
    if (resumed.nextRunAt <= nowIso) {
      const next = computeNextRun(resumed.schedule, now).toISOString();
      deps.repo.setTaskNextRunAt(existing.id, next, resumed.lastRunAt, nowIso);
    }
    const refreshed = deps.repo.getTaskById(existing.id) ?? resumed;

    const payload: ScheduledTaskResumedPayload = {
      taskId: existing.id,
      resumedBy: user.id,
    };
    await deps.bus.publish({ type: 'scheduledtask.resumed', payload, correlationId });
    return c.json({ task: toSummary(refreshed) });
  });

  // ---------- POST /l/:slug/scheduled-tasks/:taskSlug/runs ---------------

  app.post('/l/:slug/scheduled-tasks/:taskSlug/runs', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    const task = deps.repo.getTaskBySlug(layer.id, c.req.param('taskSlug'));
    if (task === null || task.deletedAt !== null) return c.json(NOT_FOUND, 404);

    // Plan §15 #4 — manual run-now does NOT 409 when a scheduled tick
    // already has a run in flight. We insert a new `requested` row
    // tagged `triggeredBy='manual'` and publish; the run subscriber
    // serializes work through the durable pump.
    const runId = crypto.randomUUID();
    const nowIso = clock().toISOString();
    const nextAttempt = task.attempt + 1;
    const run = deps.repo.insertRun({
      id: runId,
      taskId: task.id,
      status: 'requested',
      attempt: nextAttempt,
      triggeredBy: 'manual',
      requestedAt: nowIso,
      correlationId,
    });

    const payload: ScheduledTaskRunRequestedPayload = {
      taskId: task.id,
      runId: run.id,
      kind: task.kind,
      layerId: task.layerId,
      triggeredBy: 'manual',
      attempt: nextAttempt,
    };
    await deps.bus.publish({
      type: 'scheduledtask.run.requested',
      payload,
      correlationId,
    });
    return c.json({ run: toRunSummary(run) }, 202);
  });

  // ---------- GET /l/:slug/scheduled-tasks/:taskSlug/runs -----------------

  app.get('/l/:slug/scheduled-tasks/:taskSlug/runs', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const task = deps.repo.getTaskBySlug(layer.id, c.req.param('taskSlug'));
    if (task === null || task.deletedAt !== null) return c.json(NOT_FOUND, 404);
    const limit = parseLimit(c.req.query('limit'));
    const runs = deps.repo.listRunsForTask(task.id, limit);
    return c.json({ runs: runs.map(toRunSummary) });
  });
}

// ---------------------------------------------------------------------------
// helpers

export function toSummary(task: ScheduledTask): ScheduledTaskSummary {
  return {
    id: task.id,
    layerId: task.layerId,
    slug: task.slug,
    kind: task.kind,
    name: task.name,
    status: task.status,
    pauseReason: task.pauseReason,
    schedule: task.schedule,
    maxAttempts: task.maxAttempts,
    backoffBaseMs: task.backoffBaseMs,
    backoffMaxMs: task.backoffMaxMs,
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    attempt: task.attempt,
    version: task.version,
    createdAt: task.createdAt,
    createdBy: task.createdBy,
    updatedAt: task.updatedAt,
    updatedBy: task.updatedBy,
    deletedAt: task.deletedAt,
  };
}

export function toRunSummary(run: ScheduledTaskRun): ScheduledTaskRunSummary {
  return {
    id: run.id,
    taskId: run.taskId,
    status: run.status,
    attempt: run.attempt,
    triggeredBy: run.triggeredBy,
    requestedAt: run.requestedAt,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    error: run.error,
    correlationId: run.correlationId,
  };
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_RUNS_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RUNS_LIMIT;
  return Math.min(Math.floor(n), MAX_RUNS_LIMIT);
}

function deriveSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

interface ZodLikeIssue {
  readonly path: ReadonlyArray<string | number>;
  readonly message?: string;
}

/**
 * Hand a more useful error code when a zod parse failure clearly maps
 * to an invalid schedule (the most common create/update failure
 * mode). Everything else maps to the generic bad-request body so the
 * route stays stable across schema refactors.
 */
function scheduleErrorFromZod(issues: readonly ZodLikeIssue[]): {
  readonly error: string;
} {
  for (const issue of issues) {
    if (issue.path[0] !== 'schedule') continue;
    if (issue.path[1] === 'cronExpression' || issue.path[1] === 'cronTimezone') {
      return INVALID_CRON;
    }
    if (issue.path[1] === 'intervalMinutes') {
      return INVALID_INTERVAL;
    }
  }
  return BAD_REQUEST;
}

interface UpdatePatchEventInput {
  readonly name?: string | undefined;
  readonly schedule?: unknown;
  readonly config?: Readonly<Record<string, unknown>> | undefined;
  readonly maxAttempts?: number | undefined;
  readonly backoffBaseMs?: number | undefined;
  readonly backoffMaxMs?: number | undefined;
}

function serializePatchForEvent(body: UpdatePatchEventInput): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  if (body.name !== undefined) out.name = body.name;
  if (body.schedule !== undefined) out.schedule = body.schedule;
  // Do NOT echo `config` — plan §7 anti-leak invariant: handler
  // config never lands in an event payload.
  if (body.maxAttempts !== undefined) out.maxAttempts = body.maxAttempts;
  if (body.backoffBaseMs !== undefined) out.backoffBaseMs = body.backoffBaseMs;
  if (body.backoffMaxMs !== undefined) out.backoffMaxMs = body.backoffMaxMs;
  return out;
}
