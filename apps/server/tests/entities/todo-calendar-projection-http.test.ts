/**
 * Phase 4d.6 — HTTP-level checks for the read endpoint
 * `GET /l/:slug/calendar/_projections/todos`.
 *
 * The endpoint lives under the `/calendar/` URL prefix (NOT
 * `/todo/...`) so the calendar UI can fetch projections alongside
 * real events without sniffing for a kind discriminator on the
 * `/calendar_event` list. See ADR 0017.
 *
 * Coverage:
 *   - 200 with the expected items when projections exist (sorted by
 *     `due_at ASC`).
 *   - 404 `errors.layer.notVisible` when the caller is not a member
 *     of the layer (no cross-layer existence probe).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from '../_helpers/auth';
import { makeTestApp, type TestApp } from '../_helpers/app';
import { seedLayersIfNeeded } from '../../src/layers/seed';
import { createTodoCalendarProjection } from '../../src/entities/todos';

let fx: TestApp | null = null;
afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

async function sendJson(
  app: TestApp,
  url: string,
  token: string,
  body: unknown,
  method: 'POST' | 'PATCH' | 'DELETE' = 'POST',
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

async function getJson(app: TestApp, url: string, token: string): Promise<Response> {
  return app.app.fetch(
    new Request(`http://localhost${url}`, {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

interface ProjectionItem {
  readonly todoId: string;
  readonly layerId: string;
  readonly todoSlug: string;
  readonly title: string;
  readonly dueAt: string;
  readonly priority: number;
  readonly status: string;
}

describe('GET /l/:slug/calendar/_projections/todos', () => {
  it('returns 200 with the projection items', async () => {
    fx = makeTestApp('bunny2-tcp-http-list-');
    const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
    bridge.start();
    try {
      const { token } = seedUserAndSession(fx.db, { username: 'pl' });
      await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
      await sendJson(fx, '/layers', token, { type: 'project', slug: 'plroom', name: 'pl' });
      const r1 = await sendJson(fx, '/l/plroom/todo', token, {
        title: 'Later',
        originalLocale: 'en',
        slug: 'p-later',
        payload: { dueAt: '2026-07-10', priority: 4 },
      });
      expect(r1.status).toBe(201);
      const r2 = await sendJson(fx, '/l/plroom/todo', token, {
        title: 'Earlier',
        originalLocale: 'en',
        slug: 'p-earlier',
        payload: { dueAt: '2026-06-01', priority: 2 },
      });
      expect(r2.status).toBe(201);
      // No-dueAt — must NOT appear in the projections endpoint.
      await sendJson(fx, '/l/plroom/todo', token, {
        title: 'No date',
        originalLocale: 'en',
        slug: 'p-nodate',
        payload: {},
      });

      const res = await getJson(fx, '/l/plroom/calendar/_projections/todos', token);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { items: readonly ProjectionItem[] };
      expect(body.items).toHaveLength(2);
      // Sorted by due_at ascending.
      expect(body.items[0]?.todoSlug).toBe('p-earlier');
      expect(body.items[0]?.dueAt).toBe('2026-06-01');
      expect(body.items[0]?.priority).toBe(2);
      expect(body.items[0]?.status).toBe('open');
      expect(body.items[1]?.todoSlug).toBe('p-later');
    } finally {
      bridge.stop();
    }
  });

  it('returns 404 errors.layer.notVisible for a non-member', async () => {
    fx = makeTestApp('bunny2-tcp-http-nv-');
    const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
    bridge.start();
    try {
      // First user creates a private project layer + a todo with dueAt.
      const owner = seedUserAndSession(fx.db, { username: 'owner' });
      await seedLayersIfNeeded({ db: fx.db, bus: fx.bus, transitiveGroups: fx.resolver });
      const create = await sendJson(fx, '/layers', owner.token, {
        type: 'project',
        slug: 'priv',
        name: 'Private',
      });
      expect(create.status).toBe(201);
      await sendJson(fx, '/l/priv/todo', owner.token, {
        title: 'Owner only',
        originalLocale: 'en',
        slug: 't-priv',
        payload: { dueAt: '2026-06-15' },
      });
      // Second user is a different account; the project layer is
      // private to the owner (per phase-3 rules) so the second user
      // cannot see it.
      const intruder = seedUserAndSession(fx.db, { username: 'intruder' });
      const res = await getJson(fx, '/l/priv/calendar/_projections/todos', intruder.token);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('errors.layer.notVisible');
    } finally {
      bridge.stop();
    }
  });
});
