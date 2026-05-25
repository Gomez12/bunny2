import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { ADMIN_USER_ID_KEY } from '../../src/auth/seed';
import { EVERYONE_LAYER_SLUG } from '../../src/layers/seed';
import { setMeta, getMeta } from '../../src/storage/kv-meta';
import { createScheduledTasksRepo } from '../../src/scheduled/repo';
import { createSqliteLlmCallLog } from '../../src/llm/call-log';
import {
  __resetScheduledTaskRegistryForTests,
  registerBuiltInScheduledTaskHandlers,
} from '../../src/scheduled';
import { registerProposalsScheduledTaskHandlers } from '../../src/proposals';
import {
  seedSystemScheduledTasksIfNeeded,
  SYSTEM_SCHEDULED_TASKS_SEED_DONE_KEY,
} from '../../src/scheduled/seed';

const isoNow = (d: Date = new Date()): string => d.toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sched-seed-'));
  return openDatabase(dir);
}

function bootstrap(db: Database): { everyoneLayerId: string; adminUserId: string } {
  const user = createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username: 'admin',
    displayName: 'Admin',
    passwordHash: 'h',
    mustChangePassword: false,
    now: isoNow(),
  });
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: EVERYONE_LAYER_SLUG,
    name: 'Everyone',
    now: isoNow(),
  });
  setMeta(db, ADMIN_USER_ID_KEY, user.id, isoNow());
  return { everyoneLayerId: layer.id, adminUserId: user.id };
}

function registerHandlers(db: Database): void {
  registerBuiltInScheduledTaskHandlers({
    llmCallLog: createSqliteLlmCallLog(db),
    llmRetentionDays: 180,
    schemaVersion: '0001_init',
    busAdapter: 'in-memory',
  });
  // Phase 7.6 — the seed now also covers `proposals.evidence.prune`
  // and `proposals.replan-stale`; register the placeholder shapes so
  // the seed's `getScheduledTaskHandler` lookup succeeds.
  registerProposalsScheduledTaskHandlers();
}

describe('seedSystemScheduledTasksIfNeeded', () => {
  afterEach(() => {
    __resetScheduledTaskRegistryForTests();
  });

  it('inserts the system tasks in the everyone layer on first call, sets the marker', async () => {
    const db = mkDb();
    try {
      const { everyoneLayerId, adminUserId } = bootstrap(db);
      registerHandlers(db);
      const repo = createScheduledTasksRepo(db);
      const bus = new InMemoryMessageBus();
      const res = await seedSystemScheduledTasksIfNeeded({ db, bus, repo });
      expect(res.seeded).toBe(true);
      expect(res.created).toBe(8);

      const tasks = repo.listTasks({ layerId: everyoneLayerId });
      const kinds = tasks.map((t) => t.kind).sort();
      expect(kinds).toEqual([
        'analytics.events.prune',
        'bus.outbox.prune',
        'llm.calls.prune',
        'proposals.auto-activate',
        'proposals.evidence.prune',
        'proposals.replan-stale',
        'scheduled.runs.prune',
        'system.healthcheck',
      ]);
      // Every row in the everyone layer, attributed to the admin actor.
      for (const t of tasks) {
        expect(t.layerId).toBe(everyoneLayerId);
        expect(t.createdBy).toBe(adminUserId);
        expect(t.status).toBe('active');
      }
      expect(getMeta(db, SYSTEM_SCHEDULED_TASKS_SEED_DONE_KEY)).toBe('true');
    } finally {
      db.close();
    }
  });

  it('is idempotent: a second call inserts no new rows and leaves the marker set', async () => {
    const db = mkDb();
    try {
      bootstrap(db);
      registerHandlers(db);
      const repo = createScheduledTasksRepo(db);
      const bus = new InMemoryMessageBus();
      await seedSystemScheduledTasksIfNeeded({ db, bus, repo });
      const second = await seedSystemScheduledTasksIfNeeded({ db, bus, repo });
      expect(second.seeded).toBe(false);
      expect(second.created).toBe(0);
      // Still the full system-task count.
      expect(repo.listTasks().length).toBe(8);
    } finally {
      db.close();
    }
  });

  it('fails loudly when the everyone layer is missing', async () => {
    const db = mkDb();
    try {
      // Bootstrap only the admin user, no everyone layer.
      const user = createUsersRepo(db).createUser({
        id: crypto.randomUUID(),
        username: 'admin',
        displayName: 'Admin',
        passwordHash: 'h',
        mustChangePassword: false,
        now: isoNow(),
      });
      setMeta(db, ADMIN_USER_ID_KEY, user.id, isoNow());
      registerHandlers(db);
      const repo = createScheduledTasksRepo(db);
      const bus = new InMemoryMessageBus();
      await expect(seedSystemScheduledTasksIfNeeded({ db, bus, repo })).rejects.toThrow(/everyone/);
    } finally {
      db.close();
    }
  });

  it('fails loudly when admin_user_id is missing', async () => {
    const db = mkDb();
    try {
      createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'everyone',
        slug: EVERYONE_LAYER_SLUG,
        name: 'Everyone',
        now: isoNow(),
      });
      registerHandlers(db);
      const repo = createScheduledTasksRepo(db);
      const bus = new InMemoryMessageBus();
      await expect(seedSystemScheduledTasksIfNeeded({ db, bus, repo })).rejects.toThrow(
        /admin_user_id/,
      );
    } finally {
      db.close();
    }
  });

  it('correctness path: with the marker cleared but rows already present, does not duplicate', async () => {
    const db = mkDb();
    try {
      bootstrap(db);
      registerHandlers(db);
      const repo = createScheduledTasksRepo(db);
      const bus = new InMemoryMessageBus();
      await seedSystemScheduledTasksIfNeeded({ db, bus, repo });
      // Clear the marker, but leave the rows in place. The per-slug
      // lookup must still recognise existing rows and skip them.
      db.query<unknown, [string]>('DELETE FROM kv_meta WHERE key = ?').run(
        SYSTEM_SCHEDULED_TASKS_SEED_DONE_KEY,
      );
      const again = await seedSystemScheduledTasksIfNeeded({ db, bus, repo });
      expect(again.created).toBe(0);
      expect(repo.listTasks().length).toBe(8);
    } finally {
      db.close();
    }
  });
});
