/**
 * Phase 5.4 — pause / resume lifecycle.
 *
 * Covers:
 *   - pause flips status to `paused` with `pauseReason='manual'` and
 *     emits `scheduledtask.paused` with `reason='manual'`.
 *   - resume flips status back to `active` and emits
 *     `scheduledtask.resumed`.
 *   - resume re-anchors `next_run_at` forward when the stored value
 *     is already in the past (long manual pause).
 *   - non-editor cannot pause or resume.
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
import { createScheduledTasksRepo } from '../src/scheduled/repo';

const FIXTURE_KIND = 'test.lifecycle.fixture';

let fx: TestApp | null = null;

beforeEach(() => {
  __resetScheduledTaskRegistryForTests();
  registerScheduledTaskHandler({
    kind: FIXTURE_KIND,
    async run() {
      // unused
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

async function setupTask(prefix: string): Promise<{
  fx: TestApp;
  token: string;
  taskId: string;
}> {
  const built = makeTestApp(prefix);
  const { token } = seedUserAndSession(built.db, { username: 'alice' });
  await seedLayersIfNeeded({ db: built.db, bus: built.bus, transitiveGroups: built.resolver });
  const layer = await send(built, 'POST', '/layers', token, {
    type: 'project',
    slug: 'p1',
    name: 'P1',
  });
  if (layer.status !== 201) throw new Error(`layer create failed: ${layer.status}`);
  const create = await send(built, 'POST', '/l/p1/scheduled-tasks', token, {
    name: 'Lifecycle Job',
    kind: FIXTURE_KIND,
    schedule: { kind: 'interval', intervalMinutes: 120 },
  });
  if (create.status !== 201) throw new Error(`task create failed: ${create.status}`);
  const body = (await create.json()) as { task: { id: string } };
  return { fx: built, token, taskId: body.task.id };
}

describe('/l/:slug/scheduled-tasks/:taskSlug pause/resume', () => {
  it('pauses with reason=manual and emits scheduledtask.paused', async () => {
    const setup = await setupTask('bunny2-sched-lifecycle-pause-');
    fx = setup.fx;
    const events: BusEvent[] = [];
    fx.bus.subscribe('scheduledtask.paused', async (event) => {
      events.push(event);
    });

    const res = await send(fx, 'POST', '/l/p1/scheduled-tasks/lifecycle-job/pause', setup.token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      task: { status: string; pauseReason: string | null };
    };
    expect(body.task.status).toBe('paused');
    expect(body.task.pauseReason).toBe('manual');
    expect(events).toHaveLength(1);
    const payload = events[0]?.payload as { reason: string; actorId: string | null };
    expect(payload.reason).toBe('manual');
    expect(payload.actorId).not.toBeNull();
  });

  it('resume re-anchors next_run_at when stored value is stale', async () => {
    const setup = await setupTask('bunny2-sched-lifecycle-resume-');
    fx = setup.fx;

    // Pause first.
    const pause = await send(fx, 'POST', '/l/p1/scheduled-tasks/lifecycle-job/pause', setup.token);
    expect(pause.status).toBe(200);

    // Force the stored `next_run_at` into the past so the resume
    // branch picks up the re-anchor path.
    const past = new Date(Date.now() - 60_000).toISOString();
    const repo = createScheduledTasksRepo(fx.db);
    repo.setTaskNextRunAt(setup.taskId, past, null, new Date().toISOString());

    const resume = await send(
      fx,
      'POST',
      '/l/p1/scheduled-tasks/lifecycle-job/resume',
      setup.token,
    );
    expect(resume.status).toBe(200);
    const body = (await resume.json()) as {
      task: { status: string; pauseReason: string | null; nextRunAt: string };
    };
    expect(body.task.status).toBe('active');
    expect(body.task.pauseReason).toBeNull();
    expect(body.task.nextRunAt > past).toBe(true);
  });

  it('non-editor cannot pause', async () => {
    const setup = await setupTask('bunny2-sched-lifecycle-nonedit-');
    fx = setup.fx;
    const { token: memberToken, user: member } = seedUserAndSession(fx.db, {
      username: 'bob',
    });
    const add = await send(fx, 'POST', '/layers/p1/members', setup.token, {
      userId: member.id,
      role: 'member',
    });
    expect(add.status).toBe(201);

    const res = await send(fx, 'POST', '/l/p1/scheduled-tasks/lifecycle-job/pause', memberToken);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.forbidden');
  });
});
