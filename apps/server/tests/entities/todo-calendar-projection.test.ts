/**
 * Phase 4d.6 — todo → calendar projection bridge subscriber tests.
 *
 * Exercises `createTodoCalendarProjection({...})` directly against a
 * test fixture's bus + db (instead of going through `createApp`),
 * because the bridge lives at the process level in production (see
 * `apps/server/src/index.ts`) and `makeTestApp` does not start it.
 *
 * Coverage:
 *   1. Create a todo with `dueAt` → projection row exists.
 *   2. Update title → projection row title updates.
 *   3. PATCH dueAt away → projection row is removed.
 *   4. Soft-delete → projection row is removed.
 *   5. Todo without `dueAt` → no projection row.
 *   6. `rebuild()` re-projects every non-deleted, dueAt-bearing todo.
 *   7. Cross-layer isolation — a todo in layer B does NOT pollute
 *      layer A's projections.
 *   8. The subscriber does NOT publish any `entity.todo.*` event
 *      back (no feedback loop).
 */
import { afterEach, describe, expect, it } from 'bun:test';
import type { BusEvent } from '@bunny2/bus';
import { seedUserAndSession } from '../_helpers/auth';
import { makeTestApp, type TestApp } from '../_helpers/app';
import { seedLayersIfNeeded } from '../../src/layers/seed';
import { createTodoCalendarProjection, todoModule } from '../../src/entities/todos';
import { createEntityStore } from '../../src/entities/store';
import { createLlmClient } from '../../src/llm/client';

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

async function setupLayer(
  prefix: string,
  slug = `pl-${prefix}`,
): Promise<{
  token: string;
  slug: string;
}> {
  if (fx === null) throw new Error('fixture not initialised');
  const { token } = seedUserAndSession(fx.db, { username: prefix });
  await seedLayersIfNeeded({
    db: fx.db,
    bus: fx.bus,
    transitiveGroups: fx.resolver,
  });
  const res = await sendJson(fx, '/layers', token, {
    type: 'project',
    slug,
    name: slug,
  });
  expect(res.status).toBe(201);
  return { token, slug };
}

interface ProjectionRow {
  readonly todo_id: string;
  readonly layer_id: string;
  readonly todo_slug: string;
  readonly title: string;
  readonly due_at: string;
  readonly priority: number;
  readonly status: string;
}

function projections(): readonly ProjectionRow[] {
  if (fx === null) throw new Error('fixture not initialised');
  return fx.db
    .query<ProjectionRow, []>(
      `SELECT todo_id, layer_id, todo_slug, title, due_at, priority, status
         FROM calendar_projection_todos
         ORDER BY due_at ASC`,
    )
    .all();
}

function projectionsForLayer(layerSlug: string): readonly ProjectionRow[] {
  if (fx === null) throw new Error('fixture not initialised');
  const row = fx.db
    .query<{ id: string }, [string]>(`SELECT id FROM layers WHERE slug = ?`)
    .get(layerSlug);
  if (row === null) return [];
  return fx.db
    .query<ProjectionRow, [string]>(
      `SELECT todo_id, layer_id, todo_slug, title, due_at, priority, status
         FROM calendar_projection_todos
        WHERE layer_id = ?
        ORDER BY due_at ASC`,
    )
    .all(row.id);
}

describe('todo → calendar projection subscriber', () => {
  it('creates a projection row when a todo with dueAt is created', async () => {
    fx = makeTestApp('bunny2-tcp-create-');
    const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
    bridge.start();
    try {
      const { token, slug } = await setupLayer('create');
      const res = await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'Call AMI BV',
        originalLocale: 'en',
        slug: 't-due',
        payload: { dueAt: '2026-06-05', priority: 2 },
      });
      expect(res.status).toBe(201);
      const rows = projectionsForLayer(slug);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.todo_slug).toBe('t-due');
      expect(rows[0]?.title).toBe('Call AMI BV');
      expect(rows[0]?.due_at).toBe('2026-06-05');
      expect(rows[0]?.priority).toBe(2);
      expect(rows[0]?.status).toBe('open');
    } finally {
      bridge.stop();
    }
  });

  it('does NOT create a projection row when the todo has no dueAt', async () => {
    fx = makeTestApp('bunny2-tcp-no-due-');
    const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
    bridge.start();
    try {
      const { token, slug } = await setupLayer('nodue');
      const res = await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'Pay invoice',
        originalLocale: 'en',
        slug: 't-nodue',
        payload: {},
      });
      expect(res.status).toBe(201);
      expect(projections()).toHaveLength(0);
    } finally {
      bridge.stop();
    }
  });

  it('updates the projection row when the title changes', async () => {
    fx = makeTestApp('bunny2-tcp-update-title-');
    const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
    bridge.start();
    try {
      const { token, slug } = await setupLayer('upd');
      await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'Original',
        originalLocale: 'en',
        slug: 't-upd',
        payload: { dueAt: '2026-06-10' },
      });
      const patch = await sendJson(
        fx,
        `/l/${slug}/todo/t-upd`,
        token,
        { title: 'Renamed', payload: { dueAt: '2026-06-10' } },
        'PATCH',
      );
      expect(patch.status).toBe(200);
      const rows = projectionsForLayer(slug);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.title).toBe('Renamed');
    } finally {
      bridge.stop();
    }
  });

  it('removes the projection row when dueAt is cleared via store.update', async () => {
    // The HTTP PATCH path merges top-level payload keys (see
    // §14 calendar-patch-payload-merge close-out): a request with
    // `payload: {}` preserves `dueAt`. To clear `dueAt` an internal
    // caller (the enrichment runner, an admin tool) calls
    // `store.update(...)` with a payload that omits the field — the
    // store wholesale-replaces the payload. This test takes that
    // direct path because it's the only way to exercise the "dueAt
    // went from set to null" bridge branch.
    fx = makeTestApp('bunny2-tcp-clear-due-');
    const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
    bridge.start();
    try {
      const { token, slug } = await setupLayer('clear');
      const createRes = await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'Has due',
        originalLocale: 'en',
        slug: 't-clear',
        payload: { dueAt: '2026-06-12' },
      });
      expect(createRes.status).toBe(201);
      expect(projectionsForLayer(slug)).toHaveLength(1);

      // Find the created todo + actor id and call store.update with
      // a dueAt-less payload.
      const created = (await createRes.json()) as { entity: { id: string } };
      const ownerRow = fx.db
        .query<{ id: string }, [string]>(`SELECT id FROM users WHERE username = ?`)
        .get('clear');
      const llm = createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      });
      const store = createEntityStore({ module: todoModule, db: fx.db, bus: fx.bus, llm });
      await store.update({
        id: created.entity.id,
        // Re-parsed default payload (status='open', priority=3) with
        // NO dueAt.
        payload: todoModule.payloadSchema.parse({}),
        actorId: ownerRow!.id,
      });
      expect(projectionsForLayer(slug)).toHaveLength(0);
    } finally {
      bridge.stop();
    }
  });

  it('removes the projection row when the todo is soft-deleted', async () => {
    fx = makeTestApp('bunny2-tcp-delete-');
    const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
    bridge.start();
    try {
      const { token, slug } = await setupLayer('del');
      await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'To delete',
        originalLocale: 'en',
        slug: 't-del',
        payload: { dueAt: '2026-06-15' },
      });
      expect(projectionsForLayer(slug)).toHaveLength(1);
      const del = await sendJson(fx, `/l/${slug}/todo/t-del`, token, undefined, 'DELETE');
      expect(del.status).toBe(200);
      expect(projectionsForLayer(slug)).toHaveLength(0);
    } finally {
      bridge.stop();
    }
  });

  it('rebuilds the projection table from existing todos', async () => {
    fx = makeTestApp('bunny2-tcp-rebuild-');
    // Boot WITHOUT the bridge so the create-todo events do not write
    // projection rows. Then call `rebuild()` and assert it backfills
    // every non-deleted dueAt-bearing todo. This matches the
    // production "missed events between shutdown and reboot" path.
    try {
      const { token, slug } = await setupLayer('reb');
      await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'A',
        originalLocale: 'en',
        slug: 't-a',
        payload: { dueAt: '2026-06-01' },
      });
      await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'B',
        originalLocale: 'en',
        slug: 't-b',
        payload: { dueAt: '2026-06-02' },
      });
      // Third todo has NO dueAt — must NOT appear in projections
      // after rebuild.
      await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'C',
        originalLocale: 'en',
        slug: 't-c',
        payload: {},
      });
      // Fourth todo has dueAt but is soft-deleted — must NOT appear.
      await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'D',
        originalLocale: 'en',
        slug: 't-d',
        payload: { dueAt: '2026-06-03' },
      });
      const del = await sendJson(fx, `/l/${slug}/todo/t-d`, token, undefined, 'DELETE');
      expect(del.status).toBe(200);

      expect(projectionsForLayer(slug)).toHaveLength(0);

      const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
      bridge.rebuild();
      const rows = projectionsForLayer(slug);
      expect(rows).toHaveLength(2);
      const slugs = rows.map((r) => r.todo_slug).sort();
      expect(slugs).toEqual(['t-a', 't-b']);

      // Rebuild a second time — must be idempotent (same rows, no
      // duplicates, no row vanished).
      bridge.rebuild();
      expect(projectionsForLayer(slug)).toHaveLength(2);
    } finally {
      // No bridge.stop() — never started.
    }
  });

  it('keeps projections isolated across layers', async () => {
    fx = makeTestApp('bunny2-tcp-isolation-');
    const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
    bridge.start();
    try {
      const { token, slug: slugA } = await setupLayer('iso-a', 'iso-a');
      const slugB = 'iso-b';
      await sendJson(fx, '/layers', token, { type: 'project', slug: slugB, name: slugB });
      await sendJson(fx, `/l/${slugA}/todo`, token, {
        title: 'A todo',
        originalLocale: 'en',
        slug: 't-iso-a',
        payload: { dueAt: '2026-06-20' },
      });
      await sendJson(fx, `/l/${slugB}/todo`, token, {
        title: 'B todo',
        originalLocale: 'en',
        slug: 't-iso-b',
        payload: { dueAt: '2026-06-21' },
      });
      const aRows = projectionsForLayer(slugA);
      const bRows = projectionsForLayer(slugB);
      expect(aRows).toHaveLength(1);
      expect(bRows).toHaveLength(1);
      expect(aRows[0]?.todo_slug).toBe('t-iso-a');
      expect(bRows[0]?.todo_slug).toBe('t-iso-b');
    } finally {
      bridge.stop();
    }
  });

  it('does NOT publish entity.todo.* events back to the bus (no feedback loop)', async () => {
    fx = makeTestApp('bunny2-tcp-no-loop-');
    const seen: BusEvent<unknown>[] = [];
    // Capture every entity.todo.* event AFTER the bridge writes the
    // projection. If the bridge published anything itself, we would
    // see counter-events here.
    fx.bus.subscribe('entity.todo.created', async (e) => {
      seen.push(e as BusEvent<unknown>);
    });
    fx.bus.subscribe('entity.todo.updated', async (e) => {
      seen.push(e as BusEvent<unknown>);
    });
    fx.bus.subscribe('entity.todo.deleted', async (e) => {
      seen.push(e as BusEvent<unknown>);
    });
    fx.bus.subscribe('entity.todo.restored', async (e) => {
      seen.push(e as BusEvent<unknown>);
    });

    const bridge = createTodoCalendarProjection({ db: fx.db, bus: fx.bus });
    bridge.start();
    try {
      const { token, slug } = await setupLayer('loop');
      // Exactly one event per HTTP mutation. The bridge MUST NOT
      // add a second event.
      const createRes = await sendJson(fx, `/l/${slug}/todo`, token, {
        title: 'No loop',
        originalLocale: 'en',
        slug: 't-loop',
        payload: { dueAt: '2026-06-30' },
      });
      expect(createRes.status).toBe(201);
      const patchRes = await sendJson(
        fx,
        `/l/${slug}/todo/t-loop`,
        token,
        { payload: {} },
        'PATCH',
      );
      expect(patchRes.status).toBe(200);

      // Two HTTP mutations → exactly two entity.todo.* events. If the
      // bridge re-published, we would see four or more.
      expect(seen.filter((e) => e.type === 'entity.todo.created')).toHaveLength(1);
      expect(seen.filter((e) => e.type === 'entity.todo.updated')).toHaveLength(1);
      expect(seen.filter((e) => e.type === 'entity.todo.deleted')).toHaveLength(0);
    } finally {
      bridge.stop();
    }
  });
});
