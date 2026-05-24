/**
 * Phase 3.2 — idempotent layer seed.
 *
 * Asserts:
 *  - one `everyone` layer + one personal-per-user + one group-per-group
 *  - default `bottom_up` edges (every layer→everyone; personal→groups)
 *  - re-running on the same data-dir is a no-op (no extra rows, no
 *    extra events)
 *  - `kv_meta.layers_seed_done` is set on first run
 *  - a username with special characters falls back to a uuid-suffix slug
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { correlationIdMiddleware, errorCaptureMiddleware, telemetryMiddleware } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { safeRmSync } from './_helpers/temp-dir';
import { openDatabase } from '../src/storage/sqlite';
import { createSqliteEventLog } from '../src/bus/event-log';
import { createUsersRepo } from '../src/repos/users-repo';
import { createGroupsRepo } from '../src/repos/groups-repo';
import { createGroupResolver } from '../src/auth/group-resolver';
import { LAYERS_SEED_DONE_KEY, personalLayerSlugFor, seedLayersIfNeeded } from '../src/layers/seed';
import { getMeta } from '../src/storage/kv-meta';

let dir: string;
let db: Database;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-layer-seed-'));
  db = openDatabase(dir);
});
afterEach(() => {
  try {
    db.close();
  } catch {
    /* already closed */
  }
  safeRmSync(dir);
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

function mkUser(username: string, displayName?: string): string {
  const id = crypto.randomUUID();
  createUsersRepo(db).createUser({
    id,
    username,
    displayName: displayName ?? username,
    passwordHash: 'h',
    mustChangePassword: false,
    now: new Date().toISOString(),
  });
  return id;
}

function mkGroup(slug: string, name?: string): string {
  const id = crypto.randomUUID();
  createGroupsRepo(db).createGroup({
    id,
    slug,
    name: name ?? slug,
    now: new Date().toISOString(),
  });
  return id;
}

function rowCount(table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
}

describe('seedLayersIfNeeded', () => {
  it('creates everyone + personal-per-user + group-per-group with bottom_up edges', async () => {
    const userId = mkUser('alice');
    const _userId2 = mkUser('bob');
    const groupId = mkGroup('eng');
    createGroupsRepo(db).addUserToGroup(userId, groupId, new Date().toISOString());

    const { bus } = newBus(db);
    const resolver = createGroupResolver({ db, bus });
    const result = await seedLayersIfNeeded({ db, bus, transitiveGroups: resolver });

    expect(result.seeded).toBe(true);
    // 1 everyone + 2 personal + 1 group = 4
    expect(rowCount('layers')).toBe(4);
    const byType = db
      .query<
        { type: string; n: number },
        []
      >('SELECT type, COUNT(*) AS n FROM layers GROUP BY type')
      .all();
    const counts = Object.fromEntries(byType.map((r) => [r.type, r.n]));
    expect(counts.everyone).toBe(1);
    expect(counts.personal).toBe(2);
    expect(counts.group).toBe(1);

    // Edges: 2 personal→everyone + 1 group→everyone + 1 personal-alice→group-eng = 4
    expect(rowCount('layer_visibility_edges')).toBe(4);

    expect(getMeta(db, LAYERS_SEED_DONE_KEY)).toBe('true');
    void _userId2;
  });

  it('is idempotent: a second run inserts no extra rows and publishes no extra layer.* events', async () => {
    mkUser('alice');
    mkGroup('eng');
    const { bus } = newBus(db);
    const resolver = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: resolver });

    const layerCount = rowCount('layers');
    const edgeCount = rowCount('layer_visibility_edges');
    const eventsBefore =
      db
        .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM events WHERE type LIKE 'layer.%'`)
        .get()?.n ?? 0;

    const second = await seedLayersIfNeeded({ db, bus, transitiveGroups: resolver });
    expect(second.seeded).toBe(false);
    expect(second.created.layers).toBe(0);
    expect(second.created.visibilityEdges).toBe(0);
    expect(rowCount('layers')).toBe(layerCount);
    expect(rowCount('layer_visibility_edges')).toBe(edgeCount);
    const eventsAfter =
      db
        .query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM events WHERE type LIKE 'layer.%'`)
        .get()?.n ?? 0;
    expect(eventsAfter).toBe(eventsBefore);
  });

  it('publishes layer.created and layer.visibility.added events on first run', async () => {
    mkUser('alice');
    mkGroup('eng');
    const { bus } = newBus(db);
    const resolver = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: resolver });

    const eventTypes = db
      .query<{ type: string }, []>(
        `SELECT type FROM events WHERE type LIKE 'layer.%' ORDER BY rowid`,
      )
      .all()
      .map((r) => r.type);
    expect(eventTypes).toContain('layer.created');
    expect(eventTypes).toContain('layer.visibility.added');
    // 3 layers created → 3 layer.created.
    expect(eventTypes.filter((t) => t === 'layer.created').length).toBe(3);
  });

  it('falls back to a uuid-suffix slug when the username contains characters outside [a-z0-9_-]', async () => {
    // A safe-for-`users.username` value that nevertheless contains a `.`
    // (the users table only requires non-empty and lowercase) and a
    // capital letter — both rejected by the slug character class.
    const userId = mkUser('john.doe', 'John Doe');
    const slug = personalLayerSlugFor('john.doe', userId);
    expect(slug.startsWith('personal-')).toBe(true);
    const local = slug.slice('personal-'.length);
    expect(local).toMatch(/^[0-9a-f]{8}$/);

    const { bus } = newBus(db);
    const resolver = createGroupResolver({ db, bus });
    await seedLayersIfNeeded({ db, bus, transitiveGroups: resolver });

    const row = db
      .query<{ slug: string }, [string]>(`SELECT slug FROM layers WHERE owner_user_id = ?`)
      .get(userId);
    expect(row?.slug).toBe(slug);
  });

  it('keeps the simple slug for a plain lowercase username', async () => {
    const userId = mkUser('admin');
    const slug = personalLayerSlugFor('admin', userId);
    expect(slug).toBe('personal-admin');
  });
});
