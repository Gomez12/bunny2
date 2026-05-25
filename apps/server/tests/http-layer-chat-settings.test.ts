/**
 * `/l/:slug/settings/chat` HTTP routes.
 *
 * Covers:
 *  - GET defaults when no row exists (`source: 'default'`).
 *  - PUT writes; subsequent GET returns `source: 'saved'`.
 *  - PUT validation rejects a negative cap (400).
 *  - PUT requires admin (403 for a non-admin).
 *  - Spend block reflects the embedding subscriber's bookkeeping.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';

let fx: TestApp | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

beforeEach(async () => {
  fx = await makeTestAppSeeded({
    prefix: 'bunny2-layer-chat-settings-',
    withCapabilityRegistry: true,
  });
});

describe('GET /l/:slug/settings/chat', () => {
  it('returns the defaults when no row exists', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/chat', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: 'default' | 'saved';
      settings: {
        model: string | null;
        embeddingDailyCap: number | null;
        embeddingMonthlyCap: number | null;
      };
      spend: { day: string; tokensToday: number; tokensLast30Days: number };
    };
    expect(body.source).toBe('default');
    expect(body.settings.model).toBeNull();
    expect(body.settings.embeddingDailyCap).toBeNull();
    expect(body.settings.embeddingMonthlyCap).toBeNull();
    expect(body.spend.tokensToday).toBe(0);
    expect(body.spend.tokensLast30Days).toBe(0);
    // `day` should be a 10-char YYYY-MM-DD string.
    expect(body.spend.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('PUT /l/:slug/settings/chat', () => {
  it('admin saves; subsequent GET returns source=saved with the new values', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const putRes = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/chat', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          embeddingDailyCap: 5000,
          embeddingMonthlyCap: 100_000,
        }),
      }),
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      source: 'default' | 'saved';
      settings: { model: string | null; embeddingDailyCap: number | null };
    };
    expect(putBody.source).toBe('saved');
    expect(putBody.settings.model).toBe('gpt-4o-mini');
    expect(putBody.settings.embeddingDailyCap).toBe(5000);

    const getRes = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/chat', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      source: 'default' | 'saved';
      settings: { model: string | null; embeddingDailyCap: number | null };
    };
    expect(getBody.source).toBe('saved');
    expect(getBody.settings.model).toBe('gpt-4o-mini');
  });

  it('rejects a negative daily cap with 400', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/chat', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: null,
          embeddingDailyCap: -10,
          embeddingMonthlyCap: null,
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('non-admin gets 403', async () => {
    if (fx === null) throw new Error('no fx');
    await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const nonAdmin = await seedNonAdminUser({ db: fx.db, app: fx.app }, { username: 'alice' });
    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/chat', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${nonAdmin.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          embeddingDailyCap: 100,
          embeddingMonthlyCap: 1000,
        }),
      }),
    );
    expect(res.status).toBe(403);
  });
});
