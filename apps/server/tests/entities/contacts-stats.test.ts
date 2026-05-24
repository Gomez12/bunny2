/**
 * Phase 4b.4 — HTTP-level checks for `GET /l/:slug/contact/_stats`.
 *
 * Asserts the four counts the contacts dashboard widget consumes:
 *
 *   - `total` — non-soft-deleted contacts in the layer.
 *   - `withCompanyLink` — contacts with `company_entity_id` populated.
 *   - `missingEmail` — contacts whose `primary_email` is NULL.
 *   - `recentlyEnriched` — contacts whose `entity_souls.updated_at` is
 *     newer than `now - 24h`.
 *
 * Also exercises layer isolation so a contact in a sibling layer never
 * pollutes the requesting layer's counts.
 *
 * Mirrors `apps/server/tests/entities/companies-stats.test.ts` — the
 * second consumer of the §4a.4 `statsProvider` slot deliberately
 * follows the first one's HTTP smoke pattern.
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

interface ContactStats {
  readonly total: number;
  readonly withCompanyLink: number;
  readonly missingEmail: number;
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

describe('GET /l/:slug/contact/_stats', () => {
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
    fx = makeTestApp('bunny2-contacts-stats-empty-');
    const { token } = await seed('cse');
    const res = await getJson(fx, '/l/stats/contact/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: ContactStats };
    expect(body.stats).toEqual({
      total: 0,
      withCompanyLink: 0,
      missingEmail: 0,
      recentlyEnriched: 0,
    });
  });

  it('counts total, withCompanyLink, missingEmail and recentlyEnriched correctly', async () => {
    fx = makeTestApp('bunny2-contacts-stats-happy-');
    const { token } = await seed('csh');

    // First create a company in the layer so we have a real entity id
    // to reuse as `companyEntityId`. The shared cross-cutting tables key
    // off UUIDs, so the company id is interchangeable with any other
    // entity ref; the contact module's soft `company_entity_id` slot is
    // kind-agnostic by design (see 4b.1 close-out).
    let res = await postJson(fx, '/l/stats/company', token, {
      title: 'AMI BV',
      originalLocale: 'en',
      slug: 'ami',
      payload: { kvkNumber: '12345678', description: 'anchor' },
    });
    expect(res.status).toBe(201);
    const companyEntityId = ((await res.json()) as { entity: { id: string } }).entity.id;

    // C1 — has email + companyEntityId. Counts only in `withCompanyLink`
    // (and `total`). Not enriched, has an email.
    res = await postJson(fx, '/l/stats/contact', token, {
      title: 'Alice',
      originalLocale: 'en',
      slug: 'alice',
      payload: {
        givenName: 'Alice',
        emails: [{ value: 'alice@ami.nl', isPrimary: true }],
        companyEntityId,
      },
    });
    expect(res.status).toBe(201);

    // C2 — phone only, no email. Counts only in `missingEmail` (and
    // `total`). No company link, not enriched.
    res = await postJson(fx, '/l/stats/contact', token, {
      title: 'Bob',
      originalLocale: 'en',
      slug: 'bob',
      payload: {
        givenName: 'Bob',
        phones: [{ value: '+31612345678' }],
      },
    });
    expect(res.status).toBe(201);

    // C3 — has email, no company link. Will be flagged as recently
    // enriched by stamping `entity_souls`. Counts only in
    // `recentlyEnriched` (and `total`).
    res = await postJson(fx, '/l/stats/contact', token, {
      title: 'Carol',
      originalLocale: 'en',
      slug: 'carol',
      payload: {
        givenName: 'Carol',
        emails: [{ value: 'carol@example.com', isPrimary: true }],
      },
    });
    expect(res.status).toBe(201);
    const carolId = ((await res.json()) as { entity: { id: string } }).entity.id;

    // C4 — vanilla. Has email, no company link, not enriched. Counts
    // only in `total`.
    res = await postJson(fx, '/l/stats/contact', token, {
      title: 'Dave',
      originalLocale: 'en',
      slug: 'dave',
      payload: {
        givenName: 'Dave',
        emails: [{ value: 'dave@example.com', isPrimary: true }],
      },
    });
    expect(res.status).toBe(201);

    // Stamp Carol's soul row with a recent updated_at. The enrichment
    // runner writes the same shape via `recordLastEnriched`; the widget
    // only cares about the timestamp falling inside the 24h window.
    const recentIso = new Date().toISOString();
    fx.db
      .query<
        unknown,
        [string, string, string, string]
      >(`INSERT INTO entity_souls (entity_id, entity_kind, memory_json, updated_at) VALUES (?, ?, ?, ?)`)
      .run(carolId, 'contact', JSON.stringify({ lastEnrichedAtVersionByJob: { x: 1 } }), recentIso);

    // Decoy: stamp Dave's soul with a stale timestamp to prove the 24h
    // cutoff actually excludes old enrichments.
    const daveRes = await getJson(fx, '/l/stats/contact/dave', token);
    const dave = ((await daveRes.json()) as { entity: { id: string } }).entity;
    const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    fx.db
      .query<
        unknown,
        [string, string, string, string]
      >(`INSERT INTO entity_souls (entity_id, entity_kind, memory_json, updated_at) VALUES (?, ?, ?, ?)`)
      .run(dave.id, 'contact', JSON.stringify({}), oldIso);

    res = await getJson(fx, '/l/stats/contact/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: ContactStats };
    expect(body.stats).toEqual({
      total: 4,
      withCompanyLink: 1,
      missingEmail: 1,
      recentlyEnriched: 1,
    });
  });

  it('does not include contacts from sibling layers', async () => {
    fx = makeTestApp('bunny2-contacts-stats-isolation-');
    const { token, slug, otherSlug } = await seed('csi');

    // Two contacts in `stats`, three in `stats2`. Each layer's contact
    // counts must stay independent — a contact in the other layer never
    // contributes to the requested layer's counters.
    await postJson(fx, `/l/${slug}/contact`, token, {
      title: 'Self One',
      originalLocale: 'en',
      slug: 's1',
      payload: { givenName: 'Self', emails: [{ value: 's1@one.nl', isPrimary: true }] },
    });
    await postJson(fx, `/l/${slug}/contact`, token, {
      title: 'Self Two',
      originalLocale: 'en',
      slug: 's2',
      payload: { givenName: 'Self', emails: [{ value: 's2@one.nl', isPrimary: true }] },
    });
    for (const s of ['o1', 'o2', 'o3']) {
      await postJson(fx, `/l/${otherSlug}/contact`, token, {
        title: s.toUpperCase(),
        originalLocale: 'en',
        slug: s,
        payload: { givenName: s, emails: [{ value: `${s}@other.nl`, isPrimary: true }] },
      });
    }

    const res = await getJson(fx, `/l/${slug}/contact/_stats`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: ContactStats };
    expect(body.stats.total).toBe(2);

    const other = await getJson(fx, `/l/${otherSlug}/contact/_stats`, token);
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { stats: ContactStats };
    expect(otherBody.stats.total).toBe(3);
  });
});
