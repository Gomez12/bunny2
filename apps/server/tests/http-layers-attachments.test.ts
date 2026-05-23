/**
 * Phase 3.4 — `/layers/:slug/attachments` add / remove.
 *
 * Covers:
 *   - happy path: insert + list.
 *   - non-object config rejected (array / scalar) with
 *     errors.layer.attachmentConfigInvalid.
 *   - duplicate (kind, refId) → 409 errors.layer.attachmentAlreadyRegistered.
 *   - delete attachment from another layer leaks 404, not 200.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from './_helpers/auth';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedLayersIfNeeded } from '../src/layers/seed';
import {
  createLayerAttachmentsRepo,
  type LayerAttachment,
} from '../src/repos/layer-attachments-repo';
import { createLayersRepo } from '../src/repos/layers-repo';

let fx: TestApp | null = null;
afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

async function postJson(
  app: TestApp,
  url: string,
  token: string,
  body: unknown,
  method: 'POST' | 'DELETE' = 'POST',
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

describe('/layers/:slug/attachments', () => {
  it('registers a new attachment with a JSON object config', async () => {
    fx = makeTestApp('bunny2-att-ok-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'p', name: 'P' });
    const res = await postJson(fx, '/layers/p/attachments', token, {
      kind: 'agent',
      refId: 'agent-42',
      config: { temperature: 0.2 },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { attachment: LayerAttachment };
    expect(body.attachment.kind).toBe('agent');
    expect(body.attachment.refId).toBe('agent-42');
    expect(body.attachment.config['temperature']).toBe(0.2);
  });

  it('rejects an array config with errors.layer.attachmentConfigInvalid', async () => {
    fx = makeTestApp('bunny2-att-array-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'p', name: 'P' });
    const res = await postJson(fx, '/layers/p/attachments', token, {
      kind: 'skill',
      refId: 's-1',
      config: ['bad'],
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.attachmentConfigInvalid');
  });

  it('rejects a scalar config with errors.layer.attachmentConfigInvalid', async () => {
    fx = makeTestApp('bunny2-att-scalar-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'p', name: 'P' });
    const res = await postJson(fx, '/layers/p/attachments', token, {
      kind: 'skill',
      refId: 's-1',
      config: 42,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.attachmentConfigInvalid');
  });

  it('rejects a null config with errors.layer.attachmentConfigInvalid', async () => {
    fx = makeTestApp('bunny2-att-null-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'p', name: 'P' });
    const res = await postJson(fx, '/layers/p/attachments', token, {
      kind: 'skill',
      refId: 's-1',
      config: null,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.attachmentConfigInvalid');
  });

  it('rejects duplicate (kind, refId) with 409 errors.layer.attachmentAlreadyRegistered', async () => {
    fx = makeTestApp('bunny2-att-dupe-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'p', name: 'P' });
    const first = await postJson(fx, '/layers/p/attachments', token, {
      kind: 'mcp_server',
      refId: 'mcp-1',
    });
    expect(first.status).toBe(201);
    const dupe = await postJson(fx, '/layers/p/attachments', token, {
      kind: 'mcp_server',
      refId: 'mcp-1',
    });
    expect(dupe.status).toBe(409);
    const body = (await dupe.json()) as { error: string };
    expect(body.error).toBe('errors.layer.attachmentAlreadyRegistered');
  });

  it('DELETE /layers/:slug/attachments/:id 404s when the attachment belongs to another layer', async () => {
    fx = makeTestApp('bunny2-att-cross-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'a', name: 'A' });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'b', name: 'B' });

    // attach to A directly through the repo so we know the id.
    const layersRepo = createLayersRepo(fx.db);
    const layerA = layersRepo.getLayerBySlug('a');
    if (layerA === null) throw new Error('test setup: a missing');
    const attRepo = createLayerAttachmentsRepo(fx.db);
    const att = attRepo.insertAttachment({
      id: crypto.randomUUID(),
      layerId: layerA.id,
      kind: 'agent',
      refId: 'agent-x',
      now: new Date().toISOString(),
    });

    // try to delete it from B's path → 404 (not 200, no cross-layer
    // leak).
    const res = await postJson(fx, `/layers/b/attachments/${att.id}`, token, undefined, 'DELETE');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.attachmentNotFound');
  });
});
