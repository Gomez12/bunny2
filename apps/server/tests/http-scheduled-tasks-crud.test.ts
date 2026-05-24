/**
 * Phase 5.4 — `/l/:slug/scheduled-tasks/*` CRUD round-trip.
 *
 * Covers:
 *   - list / get / create / patch / delete happy path.
 *   - non-member sees `404 errors.layer.notVisible`.
 *   - non-owner-but-visible sees `403 errors.layer.forbidden`.
 *   - duplicate slug → `409 errors.scheduledTasks.slugTaken`.
 *   - invalid cron expression → `422 errors.scheduledTasks.invalidCron`.
 *   - unknown handler kind → `400 errors.scheduledTasks.handlerUnknown`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedUserAndSession } from './_helpers/auth';
import { seedLayersIfNeeded } from '../src/layers/seed';
import {
  __resetScheduledTaskRegistryForTests,
  registerScheduledTaskHandler,
} from '../src/scheduled/registry';

const FIXTURE_KIND = 'test.crud.fixture';

let fx: TestApp | null = null;

beforeEach(() => {
  __resetScheduledTaskRegistryForTests();
  registerScheduledTaskHandler({
    kind: FIXTURE_KIND,
    async run() {
      // no-op fixture; CRUD does not invoke the handler.
    },
  });
});

afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
  __resetScheduledTaskRegistryForTests();
});

async function send(
  app: TestApp,
  method: string,
  url: string,
  token: string,
  body?: unknown,
): Promise<Response> {
  return app.app.fetch(
    new Request(`http://localhost${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

async function createProjectLayer(app: TestApp, token: string, slug: string): Promise<void> {
  const res = await send(app, 'POST', '/layers', token, {
    type: 'project',
    slug,
    name: slug,
  });
  if (res.status !== 201) {
    throw new Error(`createProjectLayer: ${res.status} ${await res.text()}`);
  }
}

describe('/l/:slug/scheduled-tasks CRUD', () => {
  it('creates, lists, gets, patches, and deletes a task end-to-end', async () => {
    fx = makeTestApp('bunny2-sched-crud-create-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createProjectLayer(fx, token, 'p1');

    const createRes = await send(fx, 'POST', '/l/p1/scheduled-tasks', token, {
      name: 'Weekly Digest',
      kind: FIXTURE_KIND,
      schedule: { kind: 'interval', intervalMinutes: 60 },
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { task: { id: string; slug: string } };
    expect(created.task.slug).toBe('weekly-digest');

    const listRes = await send(fx, 'GET', '/l/p1/scheduled-tasks', token);
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { tasks: Array<{ slug: string }> };
    expect(list.tasks.map((t) => t.slug)).toContain('weekly-digest');

    const getRes = await send(fx, 'GET', '/l/p1/scheduled-tasks/weekly-digest', token);
    expect(getRes.status).toBe(200);

    const patchRes = await send(fx, 'PATCH', '/l/p1/scheduled-tasks/weekly-digest', token, {
      name: 'Weekly Digest v2',
      schedule: { kind: 'interval', intervalMinutes: 120 },
    });
    expect(patchRes.status).toBe(200);
    const patched = (await patchRes.json()) as {
      task: { name: string; schedule: { intervalMinutes: number } };
    };
    expect(patched.task.name).toBe('Weekly Digest v2');
    expect(patched.task.schedule.intervalMinutes).toBe(120);

    const delRes = await send(fx, 'DELETE', '/l/p1/scheduled-tasks/weekly-digest', token);
    expect(delRes.status).toBe(200);

    const afterDel = await send(fx, 'GET', '/l/p1/scheduled-tasks/weekly-digest', token);
    expect(afterDel.status).toBe(404);
  });

  it('returns 404 errors.layer.notVisible to a user outside the layer', async () => {
    fx = makeTestApp('bunny2-sched-crud-non-member-');
    const { token: ownerToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { token: outsiderToken } = seedUserAndSession(fx.db, { username: 'mallory' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createProjectLayer(fx, ownerToken, 'private');

    const res = await send(fx, 'GET', '/l/private/scheduled-tasks', outsiderToken);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notVisible');
  });

  it('returns 403 errors.layer.forbidden to a non-owner who can see the layer', async () => {
    fx = makeTestApp('bunny2-sched-crud-non-owner-');
    const { token: ownerToken } = seedUserAndSession(fx.db, { username: 'alice' });
    const { token: memberToken, user: member } = seedUserAndSession(fx.db, {
      username: 'bob',
    });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createProjectLayer(fx, ownerToken, 'shared');
    const add = await send(fx, 'POST', '/layers/shared/members', ownerToken, {
      userId: member.id,
      role: 'member',
    });
    expect(add.status).toBe(201);

    const create = await send(fx, 'POST', '/l/shared/scheduled-tasks', memberToken, {
      name: 'forbidden',
      kind: FIXTURE_KIND,
      schedule: { kind: 'interval', intervalMinutes: 10 },
    });
    expect(create.status).toBe(403);
    const body = (await create.json()) as { error: string };
    expect(body.error).toBe('errors.layer.forbidden');
  });

  it('rejects an unknown handler kind with errors.scheduledTasks.handlerUnknown', async () => {
    fx = makeTestApp('bunny2-sched-crud-unknown-kind-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createProjectLayer(fx, token, 'k1');

    const res = await send(fx, 'POST', '/l/k1/scheduled-tasks', token, {
      name: 'mystery',
      kind: 'nope.not.registered',
      schedule: { kind: 'interval', intervalMinutes: 5 },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.scheduledTasks.handlerUnknown');
  });

  it('rejects a duplicate slug with errors.scheduledTasks.slugTaken', async () => {
    fx = makeTestApp('bunny2-sched-crud-dup-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createProjectLayer(fx, token, 'd1');

    const first = await send(fx, 'POST', '/l/d1/scheduled-tasks', token, {
      name: 'Digest',
      slug: 'digest',
      kind: FIXTURE_KIND,
      schedule: { kind: 'interval', intervalMinutes: 30 },
    });
    expect(first.status).toBe(201);
    const dup = await send(fx, 'POST', '/l/d1/scheduled-tasks', token, {
      name: 'Digest 2',
      slug: 'digest',
      kind: FIXTURE_KIND,
      schedule: { kind: 'interval', intervalMinutes: 30 },
    });
    expect(dup.status).toBe(409);
    const body = (await dup.json()) as { error: string };
    expect(body.error).toBe('errors.scheduledTasks.slugTaken');
  });

  it('rejects an invalid cron expression with errors.scheduledTasks.invalidCron', async () => {
    fx = makeTestApp('bunny2-sched-crud-bad-cron-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createProjectLayer(fx, token, 'c1');

    const res = await send(fx, 'POST', '/l/c1/scheduled-tasks', token, {
      name: 'bad cron',
      kind: FIXTURE_KIND,
      schedule: {
        kind: 'cron',
        cronExpression: '99 99 99 99 99',
        cronTimezone: 'Europe/Amsterdam',
      },
    });
    // `croner` rejects the impossible field values at runtime — the
    // zod schema only enforces the 5-or-6-field shape.
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.scheduledTasks.invalidCron');
  });
});
