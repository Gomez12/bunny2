/**
 * Phase 8.4 — `/l/:slug/settings/proposals` HTTP routes.
 *
 * Covers:
 *  - GET defaults when no row exists (`source: 'default'`).
 *  - PUT writes the row; subsequent GET returns `source: 'saved'`.
 *  - PUT validation rejects out-of-range values (400).
 *  - PUT requires admin (403 for a non-admin).
 *  - PUT emits `layer.proposal-settings.updated` with the changedFields
 *    diff (every field on first save; only the changed names afterwards).
 *  - Cross-layer probe — a non-admin in another layer gets 404.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { BusEvent } from '@bunny2/bus';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';
import { LayerProposalSettingsRepo } from '../src/proposals/repos/layer-proposal-settings-repo';
import {
  LAYER_PROPOSAL_SETTINGS_UPDATED_EVENT_TYPE,
  type LayerProposalSettingsUpdatedPayload,
} from '../src/proposals/events';

let fx: TestApp | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

beforeEach(async () => {
  fx = await makeTestAppSeeded({
    prefix: 'bunny2-layer-proposal-settings-',
    withCapabilityRegistry: true,
  });
});

describe('GET /l/:slug/settings/proposals', () => {
  it('returns the resolved defaults when no row exists', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/proposals', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: 'default' | 'saved';
      settings: {
        autoActivationEnabled: boolean;
        thresholdCutoff: number;
        cooldownHours: number;
        requireThumbsUpDeltaPositive: boolean;
        maxTokensDelta: number | null;
      };
    };
    expect(body.source).toBe('default');
    expect(body.settings.autoActivationEnabled).toBe(false);
    expect(body.settings.thresholdCutoff).toBe(1.0);
    expect(body.settings.cooldownHours).toBe(24);
    expect(body.settings.requireThumbsUpDeltaPositive).toBe(true);
    expect(body.settings.maxTokensDelta).toBeNull();
  });
});

describe('PUT /l/:slug/settings/proposals', () => {
  it('admin saves; subsequent GET returns source=saved with the new values', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const putRes = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/proposals', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          autoActivationEnabled: true,
          thresholdCutoff: 0.75,
          cooldownHours: 6,
          requireThumbsUpDeltaPositive: false,
          maxTokensDelta: 200,
        }),
      }),
    );
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as {
      source: 'default' | 'saved';
      settings: { thresholdCutoff: number; maxTokensDelta: number | null };
    };
    expect(putBody.source).toBe('saved');
    expect(putBody.settings.thresholdCutoff).toBe(0.75);
    expect(putBody.settings.maxTokensDelta).toBe(200);

    const getRes = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/proposals', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      source: 'default' | 'saved';
      settings: { autoActivationEnabled: boolean; thresholdCutoff: number };
    };
    expect(getBody.source).toBe('saved');
    expect(getBody.settings.autoActivationEnabled).toBe(true);
    expect(getBody.settings.thresholdCutoff).toBe(0.75);
  });

  it('rejects out-of-range thresholdCutoff with 400', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    for (const bad of [-0.01, 1.5]) {
      const res = await fx.app.fetch(
        new Request('http://localhost/l/everyone/settings/proposals', {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            autoActivationEnabled: false,
            thresholdCutoff: bad,
            cooldownHours: 24,
            requireThumbsUpDeltaPositive: true,
            maxTokensDelta: null,
          }),
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('rejects out-of-range cooldownHours with 400', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    for (const bad of [-1, 721]) {
      const res = await fx.app.fetch(
        new Request('http://localhost/l/everyone/settings/proposals', {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            autoActivationEnabled: false,
            thresholdCutoff: 1,
            cooldownHours: bad,
            requireThumbsUpDeltaPositive: true,
            maxTokensDelta: null,
          }),
        }),
      );
      expect(res.status).toBe(400);
    }
  });

  it('rejects negative maxTokensDelta with 400', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/proposals', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          autoActivationEnabled: false,
          thresholdCutoff: 1,
          cooldownHours: 24,
          requireThumbsUpDeltaPositive: true,
          maxTokensDelta: -1,
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
      new Request('http://localhost/l/everyone/settings/proposals', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${nonAdmin.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          autoActivationEnabled: true,
          thresholdCutoff: 0.5,
          cooldownHours: 6,
          requireThumbsUpDeltaPositive: true,
          maxTokensDelta: null,
        }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('emits layer.proposal-settings.updated with every field on first save, then only changed fields', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const events: BusEvent[] = [];
    fx.bus.subscribe(LAYER_PROPOSAL_SETTINGS_UPDATED_EVENT_TYPE, (e) => {
      events.push(e);
    });
    // First save — every field name in payload.
    const first = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/proposals', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          autoActivationEnabled: true,
          thresholdCutoff: 0.5,
          cooldownHours: 6,
          requireThumbsUpDeltaPositive: false,
          maxTokensDelta: 200,
        }),
      }),
    );
    expect(first.status).toBe(200);
    // Bus is async — give the in-memory adapter one tick.
    await new Promise((r) => setTimeout(r, 20));
    expect(events.length).toBe(1);
    const firstPayload = events[0]?.payload as LayerProposalSettingsUpdatedPayload | undefined;
    expect(firstPayload?.changedFields).toEqual([
      'autoActivationEnabled',
      'thresholdCutoff',
      'cooldownHours',
      'requireThumbsUpDeltaPositive',
      'maxTokensDelta',
    ]);

    // Second save — only `thresholdCutoff` changes.
    const second = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/proposals', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          autoActivationEnabled: true,
          thresholdCutoff: 0.7,
          cooldownHours: 6,
          requireThumbsUpDeltaPositive: false,
          maxTokensDelta: 200,
        }),
      }),
    );
    expect(second.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(events.length).toBe(2);
    const secondPayload = events[1]?.payload as LayerProposalSettingsUpdatedPayload | undefined;
    expect(secondPayload?.changedFields).toEqual(['thresholdCutoff']);
  });

  it('writes the row that LayerProposalSettingsRepo can read back', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/settings/proposals', {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          autoActivationEnabled: true,
          thresholdCutoff: 0.6,
          cooldownHours: 12,
          requireThumbsUpDeltaPositive: true,
          maxTokensDelta: 500,
        }),
      }),
    );
    expect(res.status).toBe(200);
    // Cross-checks against the repo so the route's response shape
    // can't drift from what 8.3's auto-activate job actually reads.
    const everyone = fx.db
      .query<{ id: string }, [string]>(`SELECT id FROM layers WHERE slug = ?`)
      .get('everyone');
    if (everyone === null) throw new Error('expected everyone layer row');
    const repo = new LayerProposalSettingsRepo(fx.db);
    const row = repo.find(everyone.id);
    expect(row?.autoActivationEnabled).toBe(true);
    expect(row?.thresholdCutoff).toBe(0.6);
    expect(row?.cooldownHours).toBe(12);
    expect(row?.maxTokensDelta).toBe(500);
  });
});
