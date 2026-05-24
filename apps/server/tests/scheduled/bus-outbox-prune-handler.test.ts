import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { openDatabase } from '../../src/storage/sqlite';
import {
  busOutboxPruneHandler,
  pruneBusOutbox,
} from '../../src/scheduled/built-in/bus-outbox-prune';
import type { ScheduledTask, ScheduledTaskRun } from '../../src/scheduled/repo';
import type {
  ScheduledTaskHandlerLogger,
  ScheduledTaskRunContext,
} from '../../src/scheduled/registry';
import type { LlmClient } from '../../src/llm';

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-outbox-prune-'));
  return openDatabase(dir);
}

function insertOutbox(
  db: Database,
  opts: {
    id: string;
    type?: string;
    occurredAt: string;
    status: 'pending' | 'in_flight' | 'delivered' | 'dead' | 'abandoned';
    deliveredAt?: string | null;
  },
): void {
  db.query<unknown, [string, string, string, string, string | null]>(
    `INSERT INTO bus_outbox (id, type, payload_json, occurred_at, status, delivered_at)
     VALUES (?, ?, '{}', ?, ?, ?)`,
  ).run(opts.id, opts.type ?? 'test.event', opts.occurredAt, opts.status, opts.deliveredAt ?? null);
}

function countOutbox(db: Database): number {
  return db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM bus_outbox').get()?.n ?? 0;
}

function fakeTask(config: Record<string, unknown>): ScheduledTask {
  return {
    id: 't',
    layerId: 'l',
    slug: 'bus-outbox-prune',
    kind: 'bus.outbox.prune',
    name: 'x',
    status: 'active',
    pauseReason: null,
    schedule: { kind: 'interval', intervalMinutes: 60 },
    config,
    maxAttempts: 3,
    backoffBaseMs: 60_000,
    backoffMaxMs: 3_600_000,
    nextRunAt: '2026-05-24T00:00:00.000Z',
    lastRunAt: null,
    attempt: 0,
    claimedAt: null,
    claimedByPid: null,
    version: 1,
    createdAt: '2026-05-24T00:00:00.000Z',
    createdBy: 'u',
    updatedAt: '2026-05-24T00:00:00.000Z',
    updatedBy: 'u',
    deletedAt: null,
    deletedBy: null,
  };
}

function fakeRun(): ScheduledTaskRun {
  return {
    id: 'r',
    taskId: 't',
    status: 'started',
    attempt: 1,
    triggeredBy: 'schedule',
    requestedAt: '2026-05-24T00:00:00.000Z',
    startedAt: '2026-05-24T00:00:00.000Z',
    finishedAt: null,
    durationMs: null,
    error: null,
    correlationId: 'c',
  };
}

function noopLogger(): ScheduledTaskHandlerLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeCtx(db: Database, task: ScheduledTask, nowIso: string): ScheduledTaskRunContext {
  return {
    task,
    run: fakeRun(),
    correlationId: 'c',
    now: (): string => nowIso,
    db,
    bus: new InMemoryMessageBus(),
    llm: { endpoint: 't', defaultModel: 'd' } as unknown as LlmClient,
    logger: noopLogger(),
  };
}

describe('bus.outbox.prune handler', () => {
  it('deletes delivered/abandoned/dead rows older than 7 days by default; leaves pending/in_flight/young rows', async () => {
    const db = mkDb();
    try {
      const now = new Date('2026-05-24T10:00:00.000Z');
      const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
      const young = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000).toISOString();
      // Old delivered → drop.
      insertOutbox(db, {
        id: 'old-delivered',
        occurredAt: old,
        status: 'delivered',
        deliveredAt: old,
      });
      // Old dead (delivered_at NULL — the COALESCE fallback case) → drop.
      insertOutbox(db, { id: 'old-dead', occurredAt: old, status: 'dead' });
      // Old abandoned (delivered_at NULL) → drop.
      insertOutbox(db, { id: 'old-abandoned', occurredAt: old, status: 'abandoned' });
      // Old pending → must stay (status filter).
      insertOutbox(db, { id: 'old-pending', occurredAt: old, status: 'pending' });
      // Old in_flight → must stay.
      insertOutbox(db, { id: 'old-in-flight', occurredAt: old, status: 'in_flight' });
      // Young delivered → must stay (age filter).
      insertOutbox(db, {
        id: 'young-delivered',
        occurredAt: young,
        status: 'delivered',
        deliveredAt: young,
      });
      expect(countOutbox(db)).toBe(6);

      await busOutboxPruneHandler.run(makeCtx(db, fakeTask({}), now.toISOString()));
      const surviving = db
        .query<{ id: string }, []>('SELECT id FROM bus_outbox ORDER BY id')
        .all()
        .map((r) => r.id);
      expect(surviving).toEqual(['old-in-flight', 'old-pending', 'young-delivered']);
    } finally {
      db.close();
    }
  });

  it('honors task.config.retentionDays override', async () => {
    const db = mkDb();
    try {
      const now = new Date('2026-05-24T10:00:00.000Z');
      const twoDays = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000).toISOString();
      insertOutbox(db, {
        id: 'two-days-delivered',
        occurredAt: twoDays,
        status: 'delivered',
        deliveredAt: twoDays,
      });
      // Default 7-day retention would keep this. Override to 1 → drop.
      await busOutboxPruneHandler.run(
        makeCtx(db, fakeTask({ retentionDays: 1 }), now.toISOString()),
      );
      expect(countOutbox(db)).toBe(0);
    } finally {
      db.close();
    }
  });

  it('pure function counts deleted rows', () => {
    const db = mkDb();
    try {
      const now = new Date('2026-05-24T10:00:00.000Z');
      const old = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000).toISOString();
      insertOutbox(db, { id: 'a', occurredAt: old, status: 'dead' });
      insertOutbox(db, { id: 'b', occurredAt: old, status: 'abandoned' });
      const deleted = pruneBusOutbox(db, 7, now);
      expect(deleted).toBe(2);
    } finally {
      db.close();
    }
  });

  it('declares an hourly defaultSchedule', () => {
    expect(busOutboxPruneHandler.kind).toBe('bus.outbox.prune');
    expect(busOutboxPruneHandler.defaultSchedule).toEqual({
      kind: 'interval',
      intervalMinutes: 60,
    });
  });
});
