import { afterEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { DurableSqliteMessageBus } from '@bunny2/bus';
import { openDatabase } from '../../src/storage/sqlite';
import { writeEventRow } from '../../src/bus/event-log';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createScheduledTasksRepo } from '../../src/scheduled/repo';
import { createScheduler } from '../../src/scheduled/scheduler';
import { createScheduledRunSubscriber } from '../../src/scheduled/run-subscriber';
import {
  __resetScheduledTaskRegistryForTests,
  registerScheduledTaskHandler,
} from '../../src/scheduled/registry';
import type { LlmClient } from '../../src/llm';

const isoNow = (d: Date = new Date()): string => d.toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-sched-e2e-'));
  return openDatabase(dir);
}

function fakeLlm(): LlmClient {
  return {
    endpoint: 'test://noop',
    defaultModel: 'noop',
    async chat() {
      throw new Error('llm not used');
    },
  } as unknown as LlmClient;
}

describe('scheduled-tasks end-to-end against DurableSqliteMessageBus', () => {
  afterEach(() => {
    __resetScheduledTaskRegistryForTests();
  });

  it('tick → publish → consume → handler success → next_run_at advanced', async () => {
    const db = mkDb();
    try {
      const userId = createUsersRepo(db).createUser({
        id: crypto.randomUUID(),
        username: 'admin',
        displayName: 'Admin',
        passwordHash: 'h',
        mustChangePassword: false,
        now: isoNow(),
      }).id;
      const layerId = createLayersRepo(db).insertLayer({
        id: crypto.randomUUID(),
        type: 'everyone',
        slug: 'everyone',
        name: 'Everyone',
        now: isoNow(),
      }).id;
      const repo = createScheduledTasksRepo(db);
      const past = isoNow(new Date(Date.now() - 60_000));
      const task = repo.insertTask({
        id: crypto.randomUUID(),
        layerId,
        slug: 'e2e',
        kind: 'test.e2e',
        name: 'E2E',
        schedule: { kind: 'interval', intervalMinutes: 1 },
        nextRunAt: past,
        createdBy: userId,
        now: isoNow(),
      });
      let runs = 0;
      registerScheduledTaskHandler({
        kind: 'test.e2e',
        async run() {
          runs += 1;
        },
      });
      const bus = new DurableSqliteMessageBus(db, {
        writeEvent: (event) => writeEventRow(db, event),
        subscriberKey: 'server-main',
      });
      const subscriber = createScheduledRunSubscriber({ db, bus, repo, llm: fakeLlm() });
      subscriber.start();
      bus.start();
      const scheduler = createScheduler({
        db,
        bus,
        repo,
        role: 'worker',
        // Skip boot recovery — we want the tick to publish the
        // request, not a `skipped_offline` row.
        bootRecoveryGraceMultiplier: 1_000_000,
      });
      const emitted = await scheduler.tickOnce();
      expect(emitted).toBe(1);
      // Drain the bus so the durable subscriber dispatches the event
      // to our run-subscriber handler.
      await bus.drain();
      expect(runs).toBe(1);
      const refreshed = repo.getTaskById(task.id);
      expect(refreshed?.nextRunAt).not.toBe(past);
      expect(refreshed?.attempt).toBe(0);
      const runRows = repo.listRunsForTask(task.id);
      expect(runRows.some((r) => r.status === 'succeeded')).toBe(true);
      bus.stop();
    } finally {
      db.close();
    }
  });
});
