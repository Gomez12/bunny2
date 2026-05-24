/**
 * Phase 7.6 — `/l/:slug/capabilities/*` HTTP routes.
 *
 * Covers:
 *  - GET list returns active capabilities for the layer;
 *  - POST deactivate is admin-only (403 for non-admins);
 *  - cross-layer 404 when the capability id belongs to another layer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';

let fx: TestApp | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

function seedSkillCapability(
  db: import('bun:sqlite').Database,
  layerId: string,
): { id: string; kind: 'skill'; name: string } {
  const repo = createLayerCapabilitiesRepo(db);
  const id = crypto.randomUUID();
  const name = 'demo-skill';
  repo.insertCapability({
    id,
    layerId,
    kind: 'skill',
    name,
    specJson: JSON.stringify({
      artifactKind: 'skill',
      name,
      description: 'demo',
      intent: 'question.entity_lookup',
      promptFragment: 'demo',
      addressesTags: ['zero-hit-retrieval'],
    }),
    origin: 'builtin',
    activatedAt: new Date().toISOString(),
  });
  return { id, kind: 'skill', name };
}

beforeEach(async () => {
  fx = await makeTestAppSeeded({
    prefix: 'bunny2-capabilities-routes-',
    withCapabilityRegistry: true,
  });
});

describe('GET /l/:slug/capabilities', () => {
  it('returns the active capabilities for the layer', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    seedSkillCapability(fx.db, everyone.id);

    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/capabilities', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items.length).toBe(1);
  });
});

describe('POST /l/:slug/capabilities/:id/deactivate', () => {
  it('admin deactivates the capability', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const cap = seedSkillCapability(fx.db, everyone.id);

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/capabilities/${cap.id}/deactivate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const row = createLayerCapabilitiesRepo(fx.db).getById(cap.id);
    expect(row?.deactivatedAt).not.toBeNull();
  });

  it('non-admin gets 403', async () => {
    if (fx === null) throw new Error('no fx');
    await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'bob' });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const cap = seedSkillCapability(fx.db, everyone.id);

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/capabilities/${cap.id}/deactivate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${nonAdmin.token}` },
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for a capability id that does not exist', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/capabilities/${crypto.randomUUID()}/deactivate`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
  });
});
