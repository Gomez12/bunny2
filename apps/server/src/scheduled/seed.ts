import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { ScheduledTaskSchedule } from '@bunny2/shared';
import { ADMIN_USER_ID_KEY } from '../auth/seed';
import { EVERYONE_LAYER_SLUG } from '../layers/seed';
import { createLayersRepo } from '../repos/layers-repo';
import { getMeta, setMeta } from '../storage/kv-meta';
import { getScheduledTaskHandler } from './registry';
import type { ScheduledTasksRepo } from './repo';
import { computeNextRun } from './schedule';
import {
  LLM_PRUNE_KIND,
  SYSTEM_HEALTHCHECK_KIND,
  SCHEDULED_RUNS_PRUNE_KIND,
  BUS_OUTBOX_PRUNE_KIND,
} from './built-in';
import type { ScheduledTaskCreatedPayload } from './events';

/**
 * Phase 5.5 — one-shot seed for the built-in system scheduled tasks.
 *
 * Runs at boot AFTER `seedAdminIfNeeded` (we need
 * `kv_meta.admin_user_id` for the `created_by` FK), AFTER
 * `seedLayersIfNeeded` (we need the `everyone` layer id), AFTER
 * `registerBuiltInScheduledTaskHandlers()` (we need each handler's
 * `defaultSchedule` to compute `next_run_at`), and BEFORE
 * `scheduler.start()` (the seed must finish writing rows before the
 * tick walks the due-set).
 *
 * Idempotency is two-tier, same pattern as `seedLayersIfNeeded`:
 *  1. Fast path — `kv_meta.system_scheduled_tasks_seed_done = 'true'`.
 *  2. Correctness path — per-kind `getTaskBySlug` lookup before
 *     inserting. Re-running with the marker cleared still cannot
 *     duplicate a row.
 *
 * System tasks live in the `everyone` layer per plan §4.3 decision
 * #3 — admin-only edit access falls out of `canEditLayer` for free,
 * no new "system" layer type required.
 *
 * Runs on EVERY process role. The seed is a one-shot row insert and
 * does not depend on which process owns the tick — the worker (or
 * `all`) role picks them up via the normal due-set scan.
 */

export const SYSTEM_SCHEDULED_TASKS_SEED_DONE_KEY = 'system_scheduled_tasks_seed_done';

/**
 * The four kinds seeded on first boot. Order matters only for
 * stable test output — the scheduler does not care about insertion
 * order. New built-in kinds add an entry here AND a row in
 * `docs/dev/architecture/job-inventory.md` (the 5.7 docs test
 * checks the diff).
 */
interface SystemTaskSpec {
  readonly kind: string;
  readonly slug: string;
  readonly name: string;
}

const SYSTEM_TASKS: readonly SystemTaskSpec[] = [
  { kind: LLM_PRUNE_KIND, slug: 'llm-calls-prune', name: 'LLM calls retention prune' },
  { kind: SYSTEM_HEALTHCHECK_KIND, slug: 'system-healthcheck', name: 'System healthcheck' },
  {
    kind: SCHEDULED_RUNS_PRUNE_KIND,
    slug: 'scheduled-runs-prune',
    name: 'Scheduled-task run-history prune',
  },
  { kind: BUS_OUTBOX_PRUNE_KIND, slug: 'bus-outbox-prune', name: 'Bus outbox prune' },
];

export interface SeedSystemScheduledTasksDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly repo: ScheduledTasksRepo;
  /** Override for tests; defaults to `new Date()`. */
  readonly clock?: () => Date;
  /** Override for tests; defaults to `crypto.randomUUID`. */
  readonly idFactory?: () => string;
}

export interface SeedSystemScheduledTasksResult {
  readonly seeded: boolean;
  /** Rows inserted on this call (zero on a fast-path no-op). */
  readonly created: number;
}

export async function seedSystemScheduledTasksIfNeeded(
  deps: SeedSystemScheduledTasksDeps,
): Promise<SeedSystemScheduledTasksResult> {
  const clock = deps.clock ?? ((): Date => new Date());
  const idFactory = deps.idFactory ?? ((): string => crypto.randomUUID());

  // ---- fast-path early return -------------------------------------------
  const done = getMeta(deps.db, SYSTEM_SCHEDULED_TASKS_SEED_DONE_KEY);
  if (done === 'true') {
    return { seeded: false, created: 0 };
  }

  // ---- resolve the everyone layer + admin actor -------------------------
  const layersRepo = createLayersRepo(deps.db);
  const everyone = layersRepo.getLayerBySlug(EVERYONE_LAYER_SLUG);
  if (everyone === null) {
    throw new Error(
      "scheduled-seed: 'everyone' layer not found — seedLayersIfNeeded must run first",
    );
  }
  const adminUserId = getMeta(deps.db, ADMIN_USER_ID_KEY);
  if (adminUserId === null || adminUserId === '') {
    // We deliberately fail loudly rather than fall back to a string
    // literal like 'system'. `scheduled_tasks.created_by` is
    // `REFERENCES users(id)` (see 0012_scheduled_tasks.sql); inserting
    // a non-user id would silently violate the FK on Postgres later
    // even if SQLite tolerates it today.
    throw new Error(
      'scheduled-seed: admin_user_id missing in kv_meta — seedAdminIfNeeded must run first',
    );
  }

  // ---- per-kind ensure-row helper ---------------------------------------
  const now = clock();
  const nowIso = now.toISOString();
  let created = 0;

  for (const spec of SYSTEM_TASKS) {
    const existing = deps.repo.getTaskBySlug(everyone.id, spec.slug);
    if (existing !== null) {
      continue;
    }
    const handler = getScheduledTaskHandler(spec.kind);
    if (handler === null) {
      throw new Error(
        `scheduled-seed: built-in handler for '${spec.kind}' not registered — ` +
          `registerBuiltInScheduledTaskHandlers() must run first`,
      );
    }
    const schedule: ScheduledTaskSchedule = handler.defaultSchedule ?? {
      kind: 'interval',
      intervalMinutes: 60,
    };
    const id = idFactory();
    const nextRunAt = computeNextRun(schedule, now).toISOString();
    deps.repo.insertTask({
      id,
      layerId: everyone.id,
      slug: spec.slug,
      kind: spec.kind,
      name: spec.name,
      schedule,
      config: {},
      nextRunAt,
      createdBy: adminUserId,
      now: nowIso,
    });
    created += 1;
    const payload: ScheduledTaskCreatedPayload = {
      taskId: id,
      layerId: everyone.id,
      kind: spec.kind,
      slug: spec.slug,
      scheduleKind: schedule.kind,
      createdBy: adminUserId,
    };
    await deps.bus.publish({
      type: 'scheduledtask.created',
      payload,
      correlationId: idFactory(),
    });
  }

  setMeta(deps.db, SYSTEM_SCHEDULED_TASKS_SEED_DONE_KEY, 'true', nowIso);

  return { seeded: true, created };
}
