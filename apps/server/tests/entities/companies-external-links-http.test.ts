/**
 * Phase 4a.2 — HTTP-level checks for POST/DELETE
 * `/l/:slug/company/:companySlug/external-links`.
 *
 * Focus:
 *   - Unknown connector id → 400 `errors.entity.connectorUnknown` and
 *     NO row in `entity_external_links`.
 *   - Known connector id → 201 with the link in `sync_state='idle'`
 *     and one `entity.connector.sync.requested` published on the bus.
 *
 * The test does NOT exercise the connector's `pull` end-to-end —
 * `makeTestApp` registers the default `companyModule` whose KvK
 * connector uses the global `fetch`. The full pull / dispatch path is
 * covered in `companies-kvk-connector.test.ts` against a stubbed fetch
 * and a custom-injected module.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { seedUserAndSession } from '../_helpers/auth';
import { makeTestApp, type TestApp } from '../_helpers/app';
import { seedLayersIfNeeded } from '../../src/layers/seed';
import type { BusEvent } from '@bunny2/bus';
import type { EntityExternalLink, EntityRef } from '@bunny2/shared';

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

describe('/l/:slug/company/:companySlug/external-links', () => {
  async function setupCompany(
    prefix: string,
  ): Promise<{ token: string; slug: string; companySlug: string }> {
    if (fx === null) throw new Error('fixture not initialised');
    const { token } = seedUserAndSession(fx.db, { username: prefix });
    await seedLayersIfNeeded({
      db: fx.db,
      bus: fx.bus,
      transitiveGroups: fx.resolver,
    });
    await postJson(fx, '/layers', token, { type: 'project', slug: 'extp', name: 'P' });
    const res = await postJson(fx, '/l/extp/company', token, {
      title: 'AMI BV',
      originalLocale: 'en',
      slug: 'ami',
      payload: { kvkNumber: '12345678' },
    });
    expect(res.status).toBe(201);
    return { token, slug: 'extp', companySlug: 'ami' };
  }

  it('returns 400 errors.entity.connectorUnknown when the connector id is not registered', async () => {
    fx = makeTestApp('bunny2-extlinks-unknown-');
    const { token } = await setupCompany('unk');
    const before =
      fx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM entity_external_links').get()?.n ??
      0;
    const res = await postJson(fx, '/l/extp/company/ami/external-links', token, {
      connector: 'nope',
      externalId: '12345678',
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.entity.connectorUnknown');
    const after =
      fx.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM entity_external_links').get()?.n ??
      0;
    expect(after).toBe(before);
  });

  it('persists the link with sync_state idle and emits entity.connector.sync.requested on a known connector', async () => {
    fx = makeTestApp('bunny2-extlinks-ok-');
    const captured: BusEvent[] = [];
    fx.bus.subscribe('entity.connector.sync.requested', (ev) => {
      captured.push(ev);
    });
    const { token } = await setupCompany('ok');
    const res = await postJson(fx, '/l/extp/company/ami/external-links', token, {
      connector: 'kvk',
      externalId: '12345678',
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      externalLink: EntityExternalLink;
    };
    expect(body.externalLink.connector).toBe('kvk');
    expect(body.externalLink.externalId).toBe('12345678');
    expect(body.externalLink.syncState).toBe('idle');
    expect(body.externalLink.syncedAt).toBeNull();

    // One requested event fired on the bus.
    expect(captured.length).toBe(1);
    const reqPayload = captured[0]?.payload as {
      ref: EntityRef;
      connector: string;
      externalId: string;
    };
    expect(reqPayload.connector).toBe('kvk');
    expect(reqPayload.externalId).toBe('12345678');
  });
});
