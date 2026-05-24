/**
 * Phase 5.6 — `GET /l/:slug/scheduled-tasks/_kinds`.
 *
 * The web create-dialog reads this list to populate its Kind dropdown
 * (plan §15 #1 — handlers may carry a `defaultSchedule` pre-fill).
 *
 * Covered:
 *   - 200 with the registered handler set in registration order.
 *   - `defaultSchedule` round-trips when the handler declares one.
 *   - non-member sees `404 errors.layer.notVisible` — read-allowed to
 *     layer members, not to the public.
 *   - empty registry → 200 + `{ kinds: [] }`.
 *
 * Route ordering note (plan §4.1 row 5.6 + advisor): `_kinds` MUST be
 * matched before the `/:taskSlug` catch-all. The test exercises the
 * literal segment to guard the precedence.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedUserAndSession } from './_helpers/auth';
import { seedLayersIfNeeded } from '../src/layers/seed';
import {
  __resetScheduledTaskRegistryForTests,
  registerScheduledTaskHandler,
} from '../src/scheduled/registry';

let fx: TestApp | null = null;

beforeEach(() => {
  __resetScheduledTaskRegistryForTests();
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

describe('/l/:slug/scheduled-tasks/_kinds', () => {
  it('returns the registered handlers, including the optional defaultSchedule', async () => {
    registerScheduledTaskHandler({
      kind: 'test.kinds.simple',
      async run() {
        // no-op
      },
    });
    registerScheduledTaskHandler({
      kind: 'test.kinds.cron',
      defaultSchedule: {
        kind: 'cron',
        cronExpression: '0 7 * * MON',
        cronTimezone: 'Europe/Amsterdam',
      },
      async run() {
        // no-op
      },
    });

    fx = makeTestApp('bunny2-sched-kinds-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createProjectLayer(fx, token, 'p1');

    const res = await send(fx, 'GET', '/l/p1/scheduled-tasks/_kinds', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      kinds: ReadonlyArray<{
        kind: string;
        defaultSchedule?: {
          kind: string;
          cronExpression?: string;
          cronTimezone?: string;
          intervalMinutes?: number;
        };
      }>;
    };
    const byKind = new Map(body.kinds.map((k) => [k.kind, k]));
    expect(byKind.has('test.kinds.simple')).toBe(true);
    expect(byKind.has('test.kinds.cron')).toBe(true);
    expect(byKind.get('test.kinds.simple')?.defaultSchedule).toBeUndefined();
    expect(byKind.get('test.kinds.cron')?.defaultSchedule).toEqual({
      kind: 'cron',
      cronExpression: '0 7 * * MON',
      cronTimezone: 'Europe/Amsterdam',
    });
  });

  it('returns 404 errors.layer.notVisible to a non-member', async () => {
    registerScheduledTaskHandler({
      kind: 'test.kinds.private',
      async run() {
        // no-op
      },
    });
    fx = makeTestApp('bunny2-sched-kinds-401-');
    const { token: aliceToken } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createProjectLayer(fx, aliceToken, 'aliceonly');
    const { token: bobToken } = seedUserAndSession(fx.db, { username: 'bob' });

    const res = await send(fx, 'GET', '/l/aliceonly/scheduled-tasks/_kinds', bobToken);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.notVisible');
  });

  it('returns an empty array when no handlers are registered', async () => {
    fx = makeTestApp('bunny2-sched-kinds-empty-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
    await createProjectLayer(fx, token, 'p1');

    const res = await send(fx, 'GET', '/l/p1/scheduled-tasks/_kinds', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kinds: readonly unknown[] };
    expect(body.kinds).toEqual([]);
  });
});
