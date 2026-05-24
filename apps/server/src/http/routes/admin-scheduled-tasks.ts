import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { ScheduledTaskSummary } from '@bunny2/shared';
import type { ScheduledTasksRepo } from '../../scheduled/repo';
import { toRunSummary, toSummary } from './scheduled-tasks';
import type { HonoVariables } from '../types';

/**
 * Phase 5.4 — `/admin/scheduled-tasks/*` admin cross-layer overview.
 *
 * Sits behind the `/admin/*` `requireAdmin` gate wired in `router.ts`,
 * so every handler in this file can assume the caller is a verified
 * site admin. Bypasses the per-layer scoping the
 * `/l/:slug/scheduled-tasks/*` routes enforce so an admin can audit
 * every task in one place.
 *
 * Plan §4.1 row 5.4: "admin cross-layer overview" + run history by
 * task id. Read-only — admin pause / resume / delete go through the
 * per-layer routes (an admin is always `canEditLayer` true for the
 * `everyone` layer, and the per-layer routes already publish the
 * right events).
 */

const DEFAULT_RUNS_LIMIT = 50;
const MAX_RUNS_LIMIT = 200;
const NOT_FOUND = { error: 'errors.scheduledTasks.notFound' } as const;

interface LayerSlugRow {
  readonly layer_id: string;
  readonly slug: string;
}

export interface AdminScheduledTasksRouteDeps {
  readonly db: Database;
  readonly repo: ScheduledTasksRepo;
}

export function registerAdminScheduledTasksRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AdminScheduledTasksRouteDeps,
): void {
  // ---------- GET /admin/scheduled-tasks ---------------------------------

  app.get('/admin/scheduled-tasks', (c) => {
    const tasks = deps.repo.listTasks({});
    // Resolve each `layer_id → slug` in one batched read instead of
    // joining at SQL — keeps the repo decoupled from the
    // admin-cross-layer concern and avoids growing the repo surface
    // for a single admin route. The number of tasks is bounded by
    // the registered handler set; a join would not move the needle.
    const layerIds = Array.from(new Set(tasks.map((t) => t.layerId)));
    const layerSlugs =
      layerIds.length === 0 ? new Map<string, string>() : readLayerSlugs(deps.db, layerIds);
    const rows: Array<ScheduledTaskSummary & { readonly layerSlug: string }> = tasks.map(
      (task) => ({
        ...toSummary(task),
        layerSlug: layerSlugs.get(task.layerId) ?? '',
      }),
    );
    return c.json({ tasks: rows });
  });

  // ---------- GET /admin/scheduled-tasks/:taskId/runs --------------------

  app.get('/admin/scheduled-tasks/:taskId/runs', (c) => {
    const taskId = c.req.param('taskId');
    const task = deps.repo.getTaskById(taskId);
    if (task === null) return c.json(NOT_FOUND, 404);
    const limit = parseLimit(c.req.query('limit'));
    const runs = deps.repo.listRunsForTask(taskId, limit);
    return c.json({ runs: runs.map(toRunSummary) });
  });
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_RUNS_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RUNS_LIMIT;
  return Math.min(Math.floor(n), MAX_RUNS_LIMIT);
}

function readLayerSlugs(db: Database, layerIds: readonly string[]): Map<string, string> {
  const placeholders = layerIds.map(() => '?').join(',');
  const rows = db
    .query<
      LayerSlugRow,
      string[]
    >(`SELECT id AS layer_id, slug FROM layers WHERE id IN (${placeholders})`)
    .all(...layerIds);
  const out = new Map<string, string>();
  for (const row of rows) out.set(row.layer_id, row.slug);
  return out;
}
