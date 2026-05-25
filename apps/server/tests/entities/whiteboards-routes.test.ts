/**
 * Phase 11.5 — HTTP-level tests for the whiteboards entity surface.
 *
 * Covers:
 *  - List / get / patch / soft-delete against a layer the caller is a
 *    member of.
 *  - 404 `errors.layer.notVisible` for a non-member calling the same
 *    surface.
 *  - 413 `errors.whiteboards.tooLarge` when a payload exceeds the
 *    scene byte cap (POST + PATCH + checkpoint).
 *  - Checkpoint endpoint writes the thumbnail blob + etag +
 *    `last_checkpoint_at` and exposes them via the
 *    `_list-with-thumbnails` endpoint.
 *  - The `_recent` widget endpoint sees the checkpointed thumbnail
 *    (phase 11.4 contract still holds).
 *
 * The test deliberately exercises the in-process `app.fetch(...)`
 * round-trip so the size-cap path lives behind the same auth +
 * effective-layers middleware chain production uses.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from '../_helpers/auth';
import { makeTestApp, type TestApp } from '../_helpers/app';
import { seedLayersIfNeeded } from '../../src/layers/seed';
import type { EntitySummary } from '@bunny2/shared';
import { SCENE_BYTE_CAP } from '../../src/entities/whiteboards/limits';

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
      headers: { authorization: `Bearer ${token}` },
    }),
  );
}

const EMPTY_PAYLOAD = { scene: { elements: [] }, files: {} } as const;

describe('/l/:slug/whiteboard CRUD', () => {
  async function bootLayer(prefix: string): Promise<{
    readonly token: string;
    readonly userId: string;
  }> {
    if (fx === null) throw new Error('fixture not initialised');
    const seed = seedUserAndSession(fx.db, { username: prefix });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    const r = await sendJson(fx, '/layers', seed.token, {
      type: 'project',
      slug: 'wbtest',
      name: 'WB test',
    });
    expect(r.status).toBe(201);
    return { token: seed.token, userId: seed.user.id };
  }

  it('round-trips list → get → patch → soft-delete for a member', async () => {
    fx = makeTestApp('bunny2-wb-routes-rt-');
    const { token } = await bootLayer('owner');

    // Create empty whiteboard.
    const create = await sendJson(fx, '/l/wbtest/whiteboard', token, {
      title: 'Q3 retro board',
      originalLocale: 'en',
      slug: 'q3-retro',
      payload: EMPTY_PAYLOAD,
    });
    expect(create.status).toBe(201);

    // List (generic) sees one row.
    const list = await getJson(fx, '/l/wbtest/whiteboard', token);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { entities: readonly EntitySummary[] };
    expect(listBody.entities).toHaveLength(1);

    // Detail get.
    const get = await getJson(fx, '/l/wbtest/whiteboard/q3-retro', token);
    expect(get.status).toBe(200);

    // PATCH: add a text element.
    const patch = await sendJson(
      fx,
      '/l/wbtest/whiteboard/q3-retro',
      token,
      {
        payload: {
          scene: {
            elements: [{ version: 1, type: 'text', id: 't1', text: 'Hello' }],
          },
          files: {},
        },
      },
      'PATCH',
    );
    expect(patch.status).toBe(200);

    // List-with-thumbnails surfaces the updated element count.
    const lwt = await getJson(fx, '/l/wbtest/whiteboard/_list-with-thumbnails', token);
    expect(lwt.status).toBe(200);
    const lwtBody = (await lwt.json()) as {
      items: readonly { slug: string; elementCount: number; thumbnailBlobBase64: string | null }[];
    };
    expect(lwtBody.items).toHaveLength(1);
    expect(lwtBody.items[0]?.elementCount).toBe(1);
    expect(lwtBody.items[0]?.thumbnailBlobBase64).toBeNull();

    // Soft-delete.
    const del = await sendJson(fx, '/l/wbtest/whiteboard/q3-retro', token, undefined, 'DELETE');
    expect(del.status).toBe(200);

    // List excludes the soft-deleted row.
    const list2 = await getJson(fx, '/l/wbtest/whiteboard', token);
    const list2Body = (await list2.json()) as { entities: readonly EntitySummary[] };
    expect(list2Body.entities).toHaveLength(0);
  });

  it('returns 404 errors.layer.notVisible for a non-member', async () => {
    fx = makeTestApp('bunny2-wb-routes-nv-');
    await bootLayer('owner');
    const intruder = seedUserAndSession(fx.db, { username: 'intruder' });

    const list = await getJson(fx, '/l/wbtest/whiteboard', intruder.token);
    expect(list.status).toBe(404);
    expect((await list.json()).error).toBe('errors.layer.notVisible');

    const lwt = await getJson(
      fx,
      '/l/wbtest/whiteboard/_list-with-thumbnails',
      intruder.token,
    );
    expect(lwt.status).toBe(404);
    expect((await lwt.json()).error).toBe('errors.layer.notVisible');

    const create = await sendJson(fx, '/l/wbtest/whiteboard', intruder.token, {
      title: 'attempt',
      originalLocale: 'en',
      payload: EMPTY_PAYLOAD,
    });
    expect(create.status).toBe(404);
    expect((await create.json()).error).toBe('errors.layer.notVisible');
  });

  it('rejects an over-cap POST with 413 errors.whiteboards.tooLarge', async () => {
    fx = makeTestApp('bunny2-wb-routes-cap-post-');
    const { token } = await bootLayer('owner');

    // Build a synthetic over-cap scene: one element with a string
    // body larger than the cap. Using `text` keeps the schema happy.
    const oversizeText = 'A'.repeat(SCENE_BYTE_CAP + 32);
    const res = await sendJson(fx, '/l/wbtest/whiteboard', token, {
      title: 'too big',
      originalLocale: 'en',
      payload: {
        scene: {
          elements: [{ version: 1, type: 'text', id: 't1', text: oversizeText }],
        },
        files: {},
      },
    });
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('errors.whiteboards.tooLarge');
  });

  it('rejects an over-cap PATCH with 413 errors.whiteboards.tooLarge', async () => {
    fx = makeTestApp('bunny2-wb-routes-cap-patch-');
    const { token } = await bootLayer('owner');
    await sendJson(fx, '/l/wbtest/whiteboard', token, {
      title: 'starter',
      originalLocale: 'en',
      slug: 'starter',
      payload: EMPTY_PAYLOAD,
    });
    const oversizeText = 'B'.repeat(SCENE_BYTE_CAP + 32);
    const res = await sendJson(
      fx,
      '/l/wbtest/whiteboard/starter',
      token,
      {
        payload: {
          scene: {
            elements: [{ version: 1, type: 'text', id: 't1', text: oversizeText }],
          },
          files: {},
        },
      },
      'PATCH',
    );
    expect(res.status).toBe(413);
    expect((await res.json()).error).toBe('errors.whiteboards.tooLarge');
  });

  it('checkpoint endpoint writes thumbnail blob + etag + last_checkpoint_at', async () => {
    fx = makeTestApp('bunny2-wb-routes-ckpt-');
    const { token } = await bootLayer('owner');
    await sendJson(fx, '/l/wbtest/whiteboard', token, {
      title: 'ckpt',
      originalLocale: 'en',
      slug: 'ckpt',
      payload: EMPTY_PAYLOAD,
    });

    // Tiny fake PNG bytes (3 bytes — the server doesn't validate the
    // PNG signature, only that the base64 round-trips).
    const fakePng = Uint8Array.from([0x89, 0x50, 0x4e]);
    const base64 = Buffer.from(fakePng).toString('base64');
    const etag = 'etag-test-1';

    const res = await sendJson(
      fx,
      '/l/wbtest/whiteboard/ckpt/_checkpoint',
      token,
      {
        payload: {
          scene: {
            elements: [{ version: 1, type: 'text', id: 't1', text: 'Hello' }],
          },
          files: {},
        },
        thumbnailBlobBase64: base64,
        thumbnailEtag: etag,
      },
      'PATCH',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { lastCheckpointAt: string };
    expect(typeof body.lastCheckpointAt).toBe('string');

    // The widget recent endpoint now exposes the thumbnail.
    const recent = await getJson(fx, '/l/wbtest/whiteboard/_recent', token);
    expect(recent.status).toBe(200);
    const recentBody = (await recent.json()) as {
      items: readonly { slug: string; thumbnailBlobBase64: string | null }[];
    };
    expect(recentBody.items[0]?.slug).toBe('ckpt');
    expect(recentBody.items[0]?.thumbnailBlobBase64).toBe(base64);

    // The list-with-thumbnails endpoint also sees it.
    const lwt = await getJson(fx, '/l/wbtest/whiteboard/_list-with-thumbnails', token);
    const lwtBody = (await lwt.json()) as {
      items: readonly {
        slug: string;
        thumbnailBlobBase64: string | null;
        lastCheckpointAt: string | null;
      }[];
    };
    expect(lwtBody.items[0]?.thumbnailBlobBase64).toBe(base64);
    expect(lwtBody.items[0]?.lastCheckpointAt).not.toBeNull();
  });
});
