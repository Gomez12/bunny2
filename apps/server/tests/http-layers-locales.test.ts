/**
 * Phase 3.4 — `/layers/:slug/locales`.
 *
 * Covers:
 *   - locale not in system list → 400 errors.layer.localeNotConfigured.
 *   - defaultLocale must be in locales[] → 400 errors.layer.defaultLocaleNotInSet.
 *   - happy path stores rows; `is_default` exactly once.
 *   - SQLite partial-unique-index defends against a direct repo writer
 *     trying to insert a second default row.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from './_helpers/auth';
import { makeTestApp, type TestApp } from './_helpers/app';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { createLayerLocalesRepo } from '../src/repos/layer-locales-repo';
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
): Promise<Response> {
  return app.app.fetch(
    new Request(`http://localhost${url}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

describe('/layers/:slug/locales', () => {
  it('rejects a locale that is not in the system list', async () => {
    fx = makeTestApp('bunny2-loc-bad-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'p', name: 'P' });

    const res = await postJson(fx, '/layers/p/locales', token, {
      locales: ['en', 'klingon'],
      defaultLocale: 'en',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; locale: string };
    expect(body.error).toBe('errors.layer.localeNotConfigured');
    expect(body.locale).toBe('klingon');
  });

  it('rejects defaultLocale not in the locales array', async () => {
    fx = makeTestApp('bunny2-loc-default-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'p', name: 'P' });

    const res = await postJson(fx, '/layers/p/locales', token, {
      locales: ['en'],
      defaultLocale: 'nl',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.layer.defaultLocaleNotInSet');
  });

  it('happy path stores the locales with the default flag', async () => {
    fx = makeTestApp('bunny2-loc-ok-');
    const { token } = seedUserAndSession(fx.db, { username: 'alice' });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'p', name: 'P' });

    const res = await postJson(fx, '/layers/p/locales', token, {
      locales: ['en', 'nl'],
      defaultLocale: 'nl',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: true;
      locales: { locale: string; isDefault: boolean }[];
    };
    expect(body.locales).toHaveLength(2);
    const nl = body.locales.find((l) => l.locale === 'nl');
    expect(nl?.isDefault).toBe(true);
    const en = body.locales.find((l) => l.locale === 'en');
    expect(en?.isDefault).toBe(false);
  });

  it('SQLite partial-unique-index rejects a second is_default row inserted directly', () => {
    fx = makeTestApp('bunny2-loc-pui-');
    const repo = createLayersRepo(fx.db);
    const localesRepo = createLayerLocalesRepo(fx.db);
    const layer = repo.insertLayer({
      id: crypto.randomUUID(),
      type: 'project',
      slug: 'p',
      name: 'P',
      now: new Date().toISOString(),
    });
    // First default row is fine.
    localesRepo.setLocales(layer.id, ['en'], 'en', new Date().toISOString());

    // Direct insert of a second `is_default=1` row must fail at SQLite.
    let threw = false;
    try {
      fx.db.exec(
        `INSERT INTO layer_locales(layer_id, locale, is_default, created_at) ` +
          `VALUES ('${layer.id}', 'nl', 1, '2026-01-01')`,
      );
    } catch (err) {
      threw = true;
      void err;
    }
    expect(threw).toBe(true);
  });
});
