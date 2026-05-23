/**
 * Phase 2.3 — admin seed.
 *
 * Verifies the idempotent first-run bootstrap:
 *  - creates exactly one admin group + one admin user
 *  - emits the documented bus events
 *  - prints the password block to stdout exactly once
 *  - re-running on the same data-dir is a no-op
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InMemoryMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
  telemetryMiddleware,
} from '@bunny2/bus';
import { openDatabase } from '../src/storage/sqlite';
import { createSqliteEventLog } from '../src/bus/event-log';
import {
  ADMIN_GROUP_ID_KEY,
  ADMIN_SEED_DONE_KEY,
  ADMIN_USER_ID_KEY,
  seedAdminIfNeeded,
} from '../src/auth/seed';
import { getMeta } from '../src/storage/kv-meta';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-seed-'));
  db = openDatabase(dir);
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

function newBus(database: Database) {
  const eventLog = createSqliteEventLog(database);
  const bus = new InMemoryMessageBus({
    middlewares: [
      correlationIdMiddleware,
      telemetryMiddleware(eventLog.writer),
      errorCaptureMiddleware(),
    ],
  });
  return { bus, eventLog };
}

describe('seedAdminIfNeeded', () => {
  it('creates the admin group + user, prints once, and records the marker', async () => {
    const captured: string[] = [];
    const { bus } = newBus(db);
    const res = await seedAdminIfNeeded({ db, bus, log: (l) => captured.push(l) });

    expect(res.seeded).toBe(true);
    expect(res.adminGroupId).toBeTruthy();
    expect(res.adminUserId).toBeTruthy();

    // Marker rows.
    expect(getMeta(db, ADMIN_SEED_DONE_KEY)).toBe('true');
    expect(getMeta(db, ADMIN_GROUP_ID_KEY)).toBe(res.adminGroupId);
    expect(getMeta(db, ADMIN_USER_ID_KEY)).toBe(res.adminUserId);

    // Exactly one user, exactly one group, exactly one membership edge.
    const userCount = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0;
    const groupCount =
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM groups').get()?.n ?? 0;
    const membershipCount =
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM user_group_memberships').get()?.n ?? 0;
    expect(userCount).toBe(1);
    expect(groupCount).toBe(1);
    expect(membershipCount).toBe(1);

    // Print contained the password block.
    const joined = captured.join('\n');
    expect(joined).toContain('username: admin');
    expect(joined).toContain('password:');
    const passwordLine = captured.find((l) => l.includes('password:'));
    const password = passwordLine?.split('password:')[1]?.trim() ?? '';
    // 24 base64url chars from 18 random bytes — no padding.
    expect(password.length).toBe(24);
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('publishes group.created, user.created, group.member_added bus events', async () => {
    const captured: string[] = [];
    const { bus } = newBus(db);
    await seedAdminIfNeeded({ db, bus, log: (l) => captured.push(l) });

    interface EventRow {
      type: string;
      payload: string;
    }
    const rows = db
      .query<EventRow, []>('SELECT type, payload FROM events ORDER BY occurred_at ASC, id ASC')
      .all();
    const types = rows.map((r) => r.type);
    expect(types).toContain('group.created');
    expect(types).toContain('user.created');
    expect(types).toContain('group.member_added');

    // No password material in any payload.
    for (const r of rows) {
      expect(r.payload.toLowerCase()).not.toContain('password');
    }
  });

  it('is idempotent: a second run is a no-op (no extra rows, no second print)', async () => {
    const captured1: string[] = [];
    const { bus } = newBus(db);
    const first = await seedAdminIfNeeded({ db, bus, log: (l) => captured1.push(l) });
    expect(first.seeded).toBe(true);

    const captured2: string[] = [];
    const second = await seedAdminIfNeeded({ db, bus, log: (l) => captured2.push(l) });
    expect(second.seeded).toBe(false);
    expect(captured2).toEqual([]);

    const userCount = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM users').get()?.n ?? 0;
    expect(userCount).toBe(1);

    // The second call still returns the recorded admin ids so callers
    // (the status closure, future admin lookups) can rely on them.
    expect(second.adminGroupId).toBe(first.adminGroupId);
    expect(second.adminUserId).toBe(first.adminUserId);
  });
});
