/**
 * Phase 4a.4 — HTTP-level checks for `GET /l/:slug/company/_stats`.
 *
 * Asserts the four counts the dashboard widget consumes:
 *
 *   - `total` — non-soft-deleted companies in the layer.
 *   - `withKvk` — companies with `kvk_number` populated.
 *   - `missingDescription` — companies with no / empty `description`.
 *   - `recentlyEnriched` — companies whose `entity_souls.updated_at`
 *     is newer than `now - 24h`.
 *
 * Also exercises:
 *
 *   - Route ordering: `/_stats` matches the stats handler, NOT the
 *     `/:entitySlug` GET handler that lives next to it in the router.
 *   - Layer isolation: a company in a sibling layer does NOT pollute
 *     the requesting layer's counts.
 *   - Soft-deleted rows are excluded from `total`, `withKvk`, and
 *     `missingDescription`.
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

interface CompanyStats {
  readonly total: number;
  readonly withKvk: number;
  readonly missingDescription: number;
  readonly recentlyEnriched: number;
}

async function postJson(
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

describe('GET /l/:slug/company/_stats', () => {
  async function seed(prefix: string): Promise<{ token: string; slug: string; otherSlug: string }> {
    if (fx === null) throw new Error('fixture not initialised');
    const { token } = seedUserAndSession(fx.db, { username: prefix });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'stats', name: 'Stats' });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'stats2', name: 'Other' });
    return { token, slug: 'stats', otherSlug: 'stats2' };
  }

  it('returns 200 with zero counts on an empty layer', async () => {
    fx = makeTestApp('bunny2-stats-empty-');
    const { token } = await seed('empty');
    const res = await getJson(fx, '/l/stats/company/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: CompanyStats };
    expect(body.stats).toEqual({
      total: 0,
      withKvk: 0,
      missingDescription: 0,
      recentlyEnriched: 0,
    });
  });

  it('counts total, withKvk, missingDescription, and recentlyEnriched correctly', async () => {
    fx = makeTestApp('bunny2-stats-happy-');
    const { token } = await seed('happy');

    // Company A — has KvK, has description.
    let res = await postJson(fx, '/l/stats/company', token, {
      title: 'AMI BV',
      originalLocale: 'en',
      slug: 'ami',
      payload: { kvkNumber: '12345678', description: 'Stays in the count' },
    });
    expect(res.status).toBe(201);

    // Company B — no KvK, has description.
    res = await postJson(fx, '/l/stats/company', token, {
      title: 'Beta',
      originalLocale: 'en',
      slug: 'beta',
      payload: { description: 'Also has one' },
    });
    expect(res.status).toBe(201);

    // Company C — no KvK, no description → missingDescription counts it.
    res = await postJson(fx, '/l/stats/company', token, {
      title: 'Gamma',
      originalLocale: 'en',
      slug: 'gamma',
      payload: {},
    });
    expect(res.status).toBe(201);
    const cId = ((await res.json()) as { entity: { id: string } }).entity.id;

    // Mark Gamma as recently enriched: stamp entity_souls with a fresh
    // updated_at. The widget's "recently enriched" bucket only cares
    // about the timestamp, not the memory_json contents.
    const recentIso = new Date().toISOString();
    fx.db
      .query<
        unknown,
        [string, string, string, string]
      >(`INSERT INTO entity_souls (entity_id, entity_kind, memory_json, updated_at) VALUES (?, ?, ?, ?)`)
      .run(cId, 'company', JSON.stringify({ lastEnrichedAtVersionByJob: { x: 1 } }), recentIso);

    // Decoy — also stamp a stale soul on Beta so we verify the 24h cutoff.
    const beforeRes = await getJson(fx, '/l/stats/company/beta', token);
    const beta = ((await beforeRes.json()) as { entity: { id: string } }).entity;
    const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    fx.db
      .query<
        unknown,
        [string, string, string, string]
      >(`INSERT INTO entity_souls (entity_id, entity_kind, memory_json, updated_at) VALUES (?, ?, ?, ?)`)
      .run(beta.id, 'company', JSON.stringify({}), oldIso);

    res = await getJson(fx, '/l/stats/company/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: CompanyStats };
    expect(body.stats.total).toBe(3);
    expect(body.stats.withKvk).toBe(1);
    expect(body.stats.missingDescription).toBe(1);
    expect(body.stats.recentlyEnriched).toBe(1);
  });

  it('returns 200 (not 404 from the entity-slug handler) when the path is /_stats', async () => {
    // Route-ordering smoke: the `/:entitySlug` GET handler comes right
    // after `/_stats` in the router. If they're registered the wrong
    // way around, this call returns `errors.entity.notFound` (404) with
    // entitySlug='_stats' — caught here so the stats endpoint cannot
    // regress silently in the future.
    fx = makeTestApp('bunny2-stats-route-order-');
    const { token } = await seed('route');
    const res = await getJson(fx, '/l/stats/company/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: CompanyStats };
    expect(body.stats.total).toBe(0);
  });

  it('does not include companies from sibling layers', async () => {
    fx = makeTestApp('bunny2-stats-isolation-');
    const { token, slug, otherSlug } = await seed('isolate');

    // Two companies in `stats`, three in `stats2`.
    await postJson(fx, `/l/${slug}/company`, token, {
      title: 'A1',
      originalLocale: 'en',
      slug: 'a1',
      payload: { kvkNumber: '11111111', description: 'x' },
    });
    await postJson(fx, `/l/${slug}/company`, token, {
      title: 'A2',
      originalLocale: 'en',
      slug: 'a2',
      payload: { kvkNumber: '22222222', description: 'y' },
    });
    for (const s of ['b1', 'b2', 'b3']) {
      await postJson(fx, `/l/${otherSlug}/company`, token, {
        title: s.toUpperCase(),
        originalLocale: 'en',
        slug: s,
        payload: { kvkNumber: `9999999${s.length}`, description: 'z' },
      });
    }

    const res = await getJson(fx, `/l/${slug}/company/_stats`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: CompanyStats };
    expect(body.stats.total).toBe(2);
    expect(body.stats.withKvk).toBe(2);

    const other = await getJson(fx, `/l/${otherSlug}/company/_stats`, token);
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { stats: CompanyStats };
    expect(otherBody.stats.total).toBe(3);
  });

  it('excludes soft-deleted rows', async () => {
    fx = makeTestApp('bunny2-stats-soft-delete-');
    const { token } = await seed('softdel');

    await postJson(fx, '/l/stats/company', token, {
      title: 'Kept',
      originalLocale: 'en',
      slug: 'kept',
      payload: { kvkNumber: '12345678', description: 'still here' },
    });
    await postJson(fx, '/l/stats/company', token, {
      title: 'Trashed',
      originalLocale: 'en',
      slug: 'trashed',
      payload: { kvkNumber: '87654321', description: 'gone' },
    });
    const del = await postJson(fx, '/l/stats/company/trashed', token, undefined, 'DELETE');
    expect(del.status).toBe(200);

    const res = await getJson(fx, '/l/stats/company/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: CompanyStats };
    expect(body.stats.total).toBe(1);
    expect(body.stats.withKvk).toBe(1);
    expect(body.stats.missingDescription).toBe(0);
  });
});
