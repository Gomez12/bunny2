/**
 * Phase 5.4 — manual `POST .../runs` + run history.
 *
 * Covers:
 *   - manual run emits `scheduledtask.run.requested` with
 *     `triggeredBy='manual'`.
 *   - `GET .../runs` returns rows in `requested_at DESC` order.
 *   - plan §15 #4 — manual run-now does NOT 409 even when a
 *     concurrent tick has the task in flight (we simply insert
 *     a second `requested` row).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { BusEvent } from '@bunny2/bus';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedUserAndSession } from './_helpers/auth';
import { seedLayersIfNeeded } from '../src/layers/seed';
import {
  __resetScheduledTaskRegistryForTests,
  registerScheduledTaskHandler,
} from '../src/scheduled/registry';

const FIXTURE_KIND = 'test.runs.fixture';

let fx: TestApp | null = null;

beforeEach(() => {
  __resetScheduledTaskRegistryForTests();
  registerScheduledTaskHandler({
    kind: FIXTURE_KIND,
    async run() {
      // no-op fixture; routes do not invoke handlers directly.
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

async function bootstrap(prefix: string): Promise<{ fx: TestApp; token: string }> {
  const t = makeTestApp(prefix);
  const { token } = seedUserAndSession(t.db, { username: 'alice' });
  await seedLayersIfNeeded({ db: t.db, bus: t.bus, transitiveGroups: t.resolver });
  const created = await send(t, 'POST', '/layers', token, {
    type: 'project',
    slug: 'p1',
    name: 'P1',
  });
  if (created.status !== 201) {
    throw new Error(`bootstrap: project create failed ${created.status}`);
  }
  const taskRes = await send(t, 'POST', '/l/p1/scheduled-tasks', token, {
    name: 'Manual Job',
    kind: FIXTURE_KIND,
    schedule: { kind: 'interval', intervalMinutes: 60 },
  });
  if (taskRes.status !== 201) {
    throw new Error(`bootstrap: task create failed ${taskRes.status}`);
  }
  return { fx: t, token };
}

describe('/l/:slug/scheduled-tasks/:taskSlug/runs', () => {
  it('manual POST emits scheduledtask.run.requested with triggeredBy=manual', async () => {
    const { fx: built, token } = await bootstrap('bunny2-sched-runs-manual-');
    fx = built;

    const seen: BusEvent[] = [];
    fx.bus.subscribe('scheduledtask.run.requested', async (event) => {
      seen.push(event);
    });

    const res = await send(fx, 'POST', '/l/p1/scheduled-tasks/manual-job/runs', token);
    expect(res.status).toBe(202);
    const body = (await res.json()) as { run: { id: string; triggeredBy: string } };
    expect(body.run.triggeredBy).toBe('manual');
    expect(seen).toHaveLength(1);
    const payload = seen[0]?.payload as { triggeredBy: string; runId: string };
    expect(payload.triggeredBy).toBe('manual');
    expect(payload.runId).toBe(body.run.id);
  });

  it('GET .../runs lists rows in newest-first order', async () => {
    const { fx: built, token } = await bootstrap('bunny2-sched-runs-list-');
    fx = built;

    const r1 = await send(fx, 'POST', '/l/p1/scheduled-tasks/manual-job/runs', token);
    expect(r1.status).toBe(202);
    // Force a small monotonic gap so `requested_at DESC` ordering is
    // observable (SQLite stores ISO strings, comparison is textual).
    await new Promise((resolve) => setTimeout(resolve, 5));
    const r2 = await send(fx, 'POST', '/l/p1/scheduled-tasks/manual-job/runs', token);
    expect(r2.status).toBe(202);

    const list = await send(fx, 'GET', '/l/p1/scheduled-tasks/manual-job/runs', token);
    expect(list.status).toBe(200);
    const body = (await list.json()) as { runs: Array<{ id: string; requestedAt: string }> };
    expect(body.runs.length).toBeGreaterThanOrEqual(2);
    expect(body.runs[0]!.requestedAt >= body.runs[1]!.requestedAt).toBe(true);
  });

  it('does NOT 409 a second manual run-now (plan §15 #4 — queue, do not reject)', async () => {
    const { fx: built, token } = await bootstrap('bunny2-sched-runs-queue-');
    fx = built;
    const first = await send(fx, 'POST', '/l/p1/scheduled-tasks/manual-job/runs', token);
    expect(first.status).toBe(202);
    const second = await send(fx, 'POST', '/l/p1/scheduled-tasks/manual-job/runs', token);
    expect(second.status).toBe(202);
  });
});
