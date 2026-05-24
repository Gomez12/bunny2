/**
 * Phase 5.6 — `GET /l/:slug/scheduled-tasks/_recent-runs`.
 *
 * The "Recent runs" dashboard widget (plan §15 #3 — cross-task list of
 * the last N runs in the current layer) reads this endpoint. Returns
 * the most recent run rows enriched with `taskSlug` + `taskName` so
 * the widget can link straight to the per-layer list page.
 *
 * Covered:
 *   - 200 with rows in `requested_at DESC` order.
 *   - rows include `taskSlug` + `taskName`.
 *   - `limit` clamps to 50 (plan + advisor note).
 *   - default limit is 10.
 *   - runs from a soft-deleted task are NOT surfaced.
 *   - cross-layer isolation — a layer's recent runs do not leak.
 *   - non-member sees `404 errors.layer.notVisible`.
 *
 * Route ordering note (plan §4.1 row 5.6 + advisor): `_recent-runs`
 * MUST be matched before the `/:taskSlug` catch-all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedUserAndSession } from './_helpers/auth';
import { seedLayersIfNeeded } from '../src/layers/seed';
import {
  __resetScheduledTaskRegistryForTests,
  registerScheduledTaskHandler,
} from '../src/scheduled/registry';

const FIXTURE_KIND = 'test.recent-runs.fixture';

let fx: TestApp | null = null;

beforeEach(() => {
  __resetScheduledTaskRegistryForTests();
  registerScheduledTaskHandler({
    kind: FIXTURE_KIND,
    async run() {
      // no-op
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

async function createLayer(app: TestApp, token: string, slug: string): Promise<void> {
  const res = await send(app, 'POST', '/layers', token, {
    type: 'project',
    slug,
    name: slug,
  });
  if (res.status !== 201) {
    throw new Error(`createLayer: ${res.status} ${await res.text()}`);
  }
}

async function createTask(
  app: TestApp,
  token: string,
  layerSlug: string,
  name: string,
): Promise<{ id: string; slug: string }> {
  const res = await send(app, 'POST', `/l/${layerSlug}/scheduled-tasks`, token, {
    name,
    kind: FIXTURE_KIND,
    schedule: { kind: 'interval', intervalMinutes: 60 },
  });
  if (res.status !== 201) {
    throw new Error(`createTask: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as { task: { id: string; slug: string } };
  return body.task;
}

async function manualRun(
  app: TestApp,
  token: string,
  layerSlug: string,
  taskSlug: string,
): Promise<void> {
  const res = await send(app, 'POST', `/l/${layerSlug}/scheduled-tasks/${taskSlug}/runs`, token);
  if (res.status !== 202) {
    throw new Error(`manualRun: ${res.status} ${await res.text()}`);
  }
  // ensure a strict DESC ordering on requested_at (ISO text compare)
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('/l/:slug/scheduled-tasks/_recent-runs', () => {
  it('returns runs in newest-first order with taskSlug + taskName enrichment', async () => {
    fx = makeTestApp('bunny2-sched-recent-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createLayer(fx, token, 'p1');

    const t1 = await createTask(fx, token, 'p1', 'First Task');
    const t2 = await createTask(fx, token, 'p1', 'Second Task');
    await manualRun(fx, token, 'p1', t1.slug);
    await manualRun(fx, token, 'p1', t2.slug);
    await manualRun(fx, token, 'p1', t1.slug);

    const res = await send(fx, 'GET', '/l/p1/scheduled-tasks/_recent-runs', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      runs: Array<{
        id: string;
        taskId: string;
        taskSlug: string;
        taskName: string;
        requestedAt: string;
      }>;
    };
    expect(body.runs).toHaveLength(3);
    // newest first
    expect(body.runs[0]?.taskSlug).toBe(t1.slug);
    expect(body.runs[1]?.taskSlug).toBe(t2.slug);
    expect(body.runs[2]?.taskSlug).toBe(t1.slug);
    expect(body.runs[0]?.taskName).toBe('First Task');
    // strictly DESC
    expect(body.runs[0]!.requestedAt >= body.runs[1]!.requestedAt).toBe(true);
    expect(body.runs[1]!.requestedAt >= body.runs[2]!.requestedAt).toBe(true);
  });

  it('honors the limit query parameter and clamps at 50', async () => {
    fx = makeTestApp('bunny2-sched-recent-limit-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createLayer(fx, token, 'p1');
    const task = await createTask(fx, token, 'p1', 'Task');
    for (let i = 0; i < 5; i += 1) {
      await manualRun(fx, token, 'p1', task.slug);
    }

    const res = await send(fx, 'GET', '/l/p1/scheduled-tasks/_recent-runs?limit=2', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: ReadonlyArray<unknown> };
    expect(body.runs).toHaveLength(2);

    // limit > MAX clamps to 50 (only 5 inserted so we see 5)
    const max = await send(fx, 'GET', '/l/p1/scheduled-tasks/_recent-runs?limit=9999', token);
    expect(max.status).toBe(200);
    const maxBody = (await max.json()) as { runs: ReadonlyArray<unknown> };
    expect(maxBody.runs.length).toBeLessThanOrEqual(50);
  });

  it('hides runs from soft-deleted tasks', async () => {
    fx = makeTestApp('bunny2-sched-recent-soft-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createLayer(fx, token, 'p1');
    const task = await createTask(fx, token, 'p1', 'Doomed Task');
    await manualRun(fx, token, 'p1', task.slug);

    // soft-delete the task
    const delRes = await send(fx, 'DELETE', `/l/p1/scheduled-tasks/${task.slug}`, token);
    expect(delRes.status).toBe(200);

    const res = await send(fx, 'GET', '/l/p1/scheduled-tasks/_recent-runs', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: ReadonlyArray<unknown> };
    expect(body.runs).toEqual([]);
  });

  it('returns 404 errors.layer.notVisible to a non-member', async () => {
    fx = makeTestApp('bunny2-sched-recent-notvis-');
    const { token: aliceToken } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createLayer(fx, aliceToken, 'aliceonly');
    const { token: bobToken } = seedUserAndSession(fx.db, { username: 'bob' });

    const res = await send(fx, 'GET', '/l/aliceonly/scheduled-tasks/_recent-runs', bobToken);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notVisible');
  });
});
