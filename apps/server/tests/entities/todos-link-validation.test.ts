/**
 * Phase 4d.1 — HTTP-level checks for the cross-kind link validator
 * mounted in `apps/server/src/entities/todos/index.ts`.
 *
 * The validator middleware sits in front of `mountEntityRoutes` on
 * the kind's POST + PATCH paths. The contract suite drives
 * `mountEntityRoutes` directly (no validator), so the suite's
 * 640 tests never exercise this code path — which is why this
 * dedicated HTTP-level fixture exists. Each case is a real
 * `fetch(request)` round-trip against the production `createApp`
 * wiring; the validator is the layer between the router and the
 * store.
 *
 * Scope (matches the brief's "what does this validator do?"
 * checklist):
 *   - No `linkedEntityRef` → 201 (validator early-exits).
 *   - `linkedEntityRef` to a contact in the same layer → 201, SQL
 *     row carries both `linked_entity_id` and `linked_entity_kind`.
 *   - `linkedEntityRef.entityId` is a random UUID → 400 with
 *     `errors.entity.todos.linkedEntityNotFound`, no `todos` row
 *     written.
 *   - `linkedEntityRef` to a contact in a DIFFERENT layer → same
 *     400 (load-bearing cross-layer isolation case).
 *   - `linkedEntityRef` to a soft-deleted contact in the same layer
 *     → 400 (`deleted_at IS NOT NULL` branch).
 *   - PATCH with an invalid `linkedEntityRef` → 400, stored payload
 *     unchanged.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from '../_helpers/auth';
import { makeTestApp, type TestApp } from '../_helpers/app';
import { seedLayersIfNeeded } from '../../src/layers/seed';

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

async function setupLayer(prefix: string): Promise<{ token: string; slug: string }> {
  if (fx === null) throw new Error('fixture not initialised');
  const { token } = seedUserAndSession(fx.db, { username: prefix });
  await seedLayersIfNeeded({
    db: fx.db,
    bus: fx.bus,
    transitiveGroups: fx.resolver,
  });
  const slug = `tl-${prefix}`;
  const res = await sendJson(fx, '/layers', token, {
    type: 'project',
    slug,
    name: slug,
  });
  expect(res.status).toBe(201);
  return { token, slug };
}

async function createContact(
  layerSlug: string,
  token: string,
  contactSlug: string,
): Promise<string> {
  if (fx === null) throw new Error('fixture not initialised');
  const res = await sendJson(fx, `/l/${layerSlug}/contact`, token, {
    title: contactSlug,
    slug: contactSlug,
    originalLocale: 'en',
    payload: {},
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { entity: { id: string } };
  return body.entity.id;
}

function countTodos(): number {
  if (fx === null) throw new Error('fixture not initialised');
  return fx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM todos').get()?.n ?? 0;
}

describe('POST /l/:slug/todo — cross-kind link validation', () => {
  it('returns 201 when no linkedEntityRef is present', async () => {
    fx = makeTestApp('bunny2-todos-link-no-ref-');
    const { token, slug } = await setupLayer('no-ref');
    const res = await sendJson(fx, `/l/${slug}/todo`, token, {
      title: 'Buy milk',
      originalLocale: 'en',
      payload: {},
    });
    expect(res.status).toBe(201);
  });

  it('returns 201 and writes linked_entity_{id,kind} when the link resolves in the same layer', async () => {
    fx = makeTestApp('bunny2-todos-link-ok-');
    const { token, slug } = await setupLayer('ok');
    const contactId = await createContact(slug, token, 'alice');
    const res = await sendJson(fx, `/l/${slug}/todo`, token, {
      title: 'Call Alice',
      originalLocale: 'en',
      payload: {
        linkedEntityRef: { kind: 'contact', entityId: contactId },
      },
    });
    expect(res.status).toBe(201);
    const row = fx.db
      .query<
        { linked_entity_id: string | null; linked_entity_kind: string | null },
        []
      >('SELECT linked_entity_id, linked_entity_kind FROM todos LIMIT 1')
      .get();
    expect(row?.linked_entity_id).toBe(contactId);
    expect(row?.linked_entity_kind).toBe('contact');
  });

  it('returns 400 errors.entity.todos.linkedEntityNotFound for an unknown entityId and writes no row', async () => {
    fx = makeTestApp('bunny2-todos-link-missing-');
    const { token, slug } = await setupLayer('missing');
    const before = countTodos();
    const res = await sendJson(fx, `/l/${slug}/todo`, token, {
      title: 'Mystery',
      originalLocale: 'en',
      payload: {
        linkedEntityRef: { kind: 'contact', entityId: '00000000-0000-0000-0000-000000000999' },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.entity.todos.linkedEntityNotFound');
    expect(countTodos()).toBe(before);
  });

  it('returns 400 when the linked contact lives in a different layer (cross-layer isolation)', async () => {
    fx = makeTestApp('bunny2-todos-link-cross-layer-');
    // Layer A holds the contact; layer B owns the todo and tries to
    // link across — must fail with the same not-found code so we
    // never leak cross-layer existence to the caller.
    const { token: tokenA, slug: slugA } = await setupLayer('cross-a');
    const contactInA = await createContact(slugA, tokenA, 'alice');
    // Same user creates layer B (they own both, but the layers are
    // separate scopes).
    const resB = await sendJson(fx, '/layers', tokenA, {
      type: 'project',
      slug: 'cross-b',
      name: 'cross-b',
    });
    expect(resB.status).toBe(201);
    const before = countTodos();
    const res = await sendJson(fx, `/l/cross-b/todo`, tokenA, {
      title: 'Cross-layer todo',
      originalLocale: 'en',
      payload: {
        linkedEntityRef: { kind: 'contact', entityId: contactInA },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.entity.todos.linkedEntityNotFound');
    expect(countTodos()).toBe(before);
  });

  it('returns 400 when the linked contact is soft-deleted in the same layer', async () => {
    fx = makeTestApp('bunny2-todos-link-soft-deleted-');
    const { token, slug } = await setupLayer('soft');
    const contactId = await createContact(slug, token, 'alice');
    const del = await sendJson(fx, `/l/${slug}/contact/alice`, token, undefined, 'DELETE');
    expect(del.status).toBe(200);
    const before = countTodos();
    const res = await sendJson(fx, `/l/${slug}/todo`, token, {
      title: 'Stale link',
      originalLocale: 'en',
      payload: {
        linkedEntityRef: { kind: 'contact', entityId: contactId },
      },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.entity.todos.linkedEntityNotFound');
    expect(countTodos()).toBe(before);
  });
});

describe('PATCH /l/:slug/todo/:entitySlug — cross-kind link validation', () => {
  it('returns 400 on an invalid linkedEntityRef and leaves the stored payload unchanged', async () => {
    fx = makeTestApp('bunny2-todos-link-patch-bad-');
    const { token, slug } = await setupLayer('patch');
    // Seed a todo with a valid link first.
    const contactId = await createContact(slug, token, 'alice');
    const createRes = await sendJson(fx, `/l/${slug}/todo`, token, {
      title: 'Call Alice',
      slug: 'call-alice',
      originalLocale: 'en',
      payload: {
        description: 'remind Alice about the deal',
        linkedEntityRef: { kind: 'contact', entityId: contactId },
      },
    });
    expect(createRes.status).toBe(201);

    // PATCH with a link to a non-existent contact must fail and the
    // stored payload must keep both the old link and the description.
    const patchRes = await sendJson(
      fx,
      `/l/${slug}/todo/call-alice`,
      token,
      {
        payload: {
          linkedEntityRef: {
            kind: 'contact',
            entityId: '00000000-0000-0000-0000-000000000aaa',
          },
        },
      },
      'PATCH',
    );
    expect(patchRes.status).toBe(400);
    const body = (await patchRes.json()) as { error: string };
    expect(body.error).toBe('errors.entity.todos.linkedEntityNotFound');

    type Row = {
      payload_json: string;
      linked_entity_id: string | null;
      linked_entity_kind: string | null;
    };
    const row = fx.db
      .query<
        Row,
        [string]
      >('SELECT payload_json, linked_entity_id, linked_entity_kind FROM todos WHERE slug = ?')
      .get('call-alice');
    expect(row?.linked_entity_id).toBe(contactId);
    expect(row?.linked_entity_kind).toBe('contact');
    const stored = JSON.parse(row?.payload_json ?? '{}') as {
      description?: string;
      linkedEntityRef?: { kind: string; entityId: string };
    };
    expect(stored.description).toBe('remind Alice about the deal');
    expect(stored.linkedEntityRef?.entityId).toBe(contactId);
  });

  it('returns 200 when PATCH carries no linkedEntityRef (validator stays silent)', async () => {
    fx = makeTestApp('bunny2-todos-link-patch-no-ref-');
    const { token, slug } = await setupLayer('patchnone');
    const createRes = await sendJson(fx, `/l/${slug}/todo`, token, {
      title: 'Buy milk',
      slug: 'buy-milk',
      originalLocale: 'en',
      payload: {},
    });
    expect(createRes.status).toBe(201);
    const patchRes = await sendJson(
      fx,
      `/l/${slug}/todo/buy-milk`,
      token,
      { payload: { description: 'two liters please' } },
      'PATCH',
    );
    expect(patchRes.status).toBe(200);
  });
});
