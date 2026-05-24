/**
 * Phase 4c.4 — HTTP-level checks for `GET /l/:slug/calendar_event/_stats`.
 *
 * Asserts the four counts the calendar dashboard widget consumes:
 *
 *   - `total` — non-soft-deleted calendar events in the layer.
 *   - `upcomingNext7d` — non-soft-deleted events where
 *     `starts_at >= now AND starts_at < now+7d`.
 *   - `withAttendeesLinked` — events whose `payload.attendees[]` has at
 *     least one entry with `contactEntityId` set.
 *   - `recentlyEnriched` — events whose `entity_souls.updated_at` is
 *     newer than `now - 24h`.
 *
 * Also exercises layer isolation so an event in a sibling layer never
 * pollutes the requesting layer's counts.
 *
 * Mirrors `apps/server/tests/entities/contacts-stats.test.ts` — the
 * third consumer of the §4a.4 `statsProvider` slot deliberately follows
 * the second one's HTTP smoke pattern. Calendar events are seeded with
 * `contactEntityId` populated directly in the payload at create time so
 * the test does not have to drive the enrichment runner.
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

interface CalendarEventStats {
  readonly total: number;
  readonly upcomingNext7d: number;
  readonly withAttendeesLinked: number;
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

function isoOffsetDays(days: number): string {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

describe('GET /l/:slug/calendar_event/_stats', () => {
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
    fx = makeTestApp('bunny2-calendar-stats-empty-');
    const { token } = await seed('cae');
    const res = await getJson(fx, '/l/stats/calendar_event/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: CalendarEventStats };
    expect(body.stats).toEqual({
      total: 0,
      upcomingNext7d: 0,
      withAttendeesLinked: 0,
      recentlyEnriched: 0,
    });
  });

  it('counts total, upcomingNext7d, withAttendeesLinked and recentlyEnriched correctly', async () => {
    fx = makeTestApp('bunny2-calendar-stats-happy-');
    const { token } = await seed('cah');

    // Any UUID works for `contactEntityId` — the schema requires only the
    // string shape. There is no foreign-key check on the calendar table;
    // the link is soft, kind-agnostic, and explicitly survives a target
    // soft-delete (see 4c.1 module + 4b.1 close-out).
    const linkedContactId = crypto.randomUUID();

    // E1 — ~7 days in the past. Decoy for `upcomingNext7d`. No
    // attendees with contactEntityId. Counts only in `total`.
    let res = await postJson(fx, '/l/stats/calendar_event', token, {
      title: 'Past meeting',
      originalLocale: 'en',
      slug: 'past-meeting',
      payload: {
        summary: 'Past meeting',
        startsAt: isoOffsetDays(-7),
      },
    });
    expect(res.status).toBe(201);

    // E2 — +1 day, attendee linked to a contact. Counts in
    // `upcomingNext7d` AND `withAttendeesLinked` (and `total`).
    res = await postJson(fx, '/l/stats/calendar_event', token, {
      title: 'Tomorrow standup',
      originalLocale: 'en',
      slug: 'tomorrow-standup',
      payload: {
        summary: 'Tomorrow standup',
        startsAt: isoOffsetDays(1),
        attendees: [
          { value: 'linked@example.com', contactEntityId: linkedContactId },
          { value: 'plain@example.com' },
        ],
      },
    });
    expect(res.status).toBe(201);

    // E3 — +3 days, no attendees linked. Counts in `upcomingNext7d`
    // (and `total`). Will also be flagged as `recentlyEnriched` by
    // stamping `entity_souls`.
    res = await postJson(fx, '/l/stats/calendar_event', token, {
      title: 'Mid-week review',
      originalLocale: 'en',
      slug: 'mid-week-review',
      payload: {
        summary: 'Mid-week review',
        startsAt: isoOffsetDays(3),
      },
    });
    expect(res.status).toBe(201);
    const midWeekId = ((await res.json()) as { entity: { id: string } }).entity.id;

    // E4 — +30 days. Decoy for `upcomingNext7d`. Counts only in `total`.
    res = await postJson(fx, '/l/stats/calendar_event', token, {
      title: 'Next-month planning',
      originalLocale: 'en',
      slug: 'next-month-planning',
      payload: {
        summary: 'Next-month planning',
        startsAt: isoOffsetDays(30),
      },
    });
    expect(res.status).toBe(201);

    // E5 — ~14 days in the past, attendees but none with
    // `contactEntityId`. Decoy for `withAttendeesLinked`. Counts only
    // in `total` (and proves the linked-counter is NOT a naive
    // "attendees array is non-empty" check).
    res = await postJson(fx, '/l/stats/calendar_event', token, {
      title: 'Quarterly retro',
      originalLocale: 'en',
      slug: 'quarterly-retro',
      payload: {
        summary: 'Quarterly retro',
        startsAt: isoOffsetDays(-14),
        attendees: [
          { value: 'unresolved+1@example.com' },
          { value: 'unresolved+2@example.com', displayName: 'Unknown' },
        ],
      },
    });
    expect(res.status).toBe(201);

    // Stamp E3's soul row with a recent `updated_at` to flag it as
    // recently enriched. The enrichment runner writes the same shape
    // via `recordLastEnriched`; the widget only cares about the
    // timestamp falling inside the 24h window.
    const recentIso = new Date().toISOString();
    fx.db
      .query<
        unknown,
        [string, string, string, string]
      >(`INSERT INTO entity_souls (entity_id, entity_kind, memory_json, updated_at) VALUES (?, ?, ?, ?)`)
      .run(
        midWeekId,
        'calendar_event',
        JSON.stringify({ lastEnrichedAtVersionByJob: { x: 1 } }),
        recentIso,
      );

    // Decoy: stamp E1 with a stale timestamp to prove the 24h cutoff
    // actually excludes old enrichments.
    const pastRes = await getJson(fx, '/l/stats/calendar_event/past-meeting', token);
    const past = ((await pastRes.json()) as { entity: { id: string } }).entity;
    const oldIso = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    fx.db
      .query<
        unknown,
        [string, string, string, string]
      >(`INSERT INTO entity_souls (entity_id, entity_kind, memory_json, updated_at) VALUES (?, ?, ?, ?)`)
      .run(past.id, 'calendar_event', JSON.stringify({}), oldIso);

    res = await getJson(fx, '/l/stats/calendar_event/_stats', token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: CalendarEventStats };
    expect(body.stats).toEqual({
      total: 5,
      upcomingNext7d: 2,
      withAttendeesLinked: 1,
      recentlyEnriched: 1,
    });
  });

  it('does not include events from sibling layers', async () => {
    fx = makeTestApp('bunny2-calendar-stats-isolation-');
    const { token, slug, otherSlug } = await seed('cai');

    // Two events in `stats`, three in `stats2`. Each layer's event
    // counts must stay independent — an event in the other layer never
    // contributes to the requested layer's counters.
    await postJson(fx, `/l/${slug}/calendar_event`, token, {
      title: 'Self One',
      originalLocale: 'en',
      slug: 's1',
      payload: { summary: 'Self one', startsAt: isoOffsetDays(2) },
    });
    await postJson(fx, `/l/${slug}/calendar_event`, token, {
      title: 'Self Two',
      originalLocale: 'en',
      slug: 's2',
      payload: { summary: 'Self two', startsAt: isoOffsetDays(4) },
    });
    for (const s of ['o1', 'o2', 'o3']) {
      await postJson(fx, `/l/${otherSlug}/calendar_event`, token, {
        title: s.toUpperCase(),
        originalLocale: 'en',
        slug: s,
        payload: { summary: s, startsAt: isoOffsetDays(2) },
      });
    }

    const res = await getJson(fx, `/l/${slug}/calendar_event/_stats`, token);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stats: CalendarEventStats };
    expect(body.stats.total).toBe(2);
    expect(body.stats.upcomingNext7d).toBe(2);

    const other = await getJson(fx, `/l/${otherSlug}/calendar_event/_stats`, token);
    expect(other.status).toBe(200);
    const otherBody = (await other.json()) as { stats: CalendarEventStats };
    expect(otherBody.stats.total).toBe(3);
    expect(otherBody.stats.upcomingNext7d).toBe(3);
  });
});
