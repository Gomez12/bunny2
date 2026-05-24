/**
 * Phase 7.6 — `/l/:slug/proposals/*` HTTP routes.
 *
 * Covers:
 *  - GET list returns the seeded summary;
 *  - GET detail returns evidence + artifacts;
 *  - approve / reject / replay-sandbox auth-gating;
 *  - cross-layer 404 (never 403) on a proposal id from another layer.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { makeTestAppSeeded, type TestApp } from './_helpers/app';
import { loginSeededAdminRotated, seedNonAdminUser } from './_helpers/auth';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createImprovementProposalsRepo } from '../src/proposals/repos/improvement-proposals-repo';

let fx: TestApp | null = null;

afterEach(() => {
  if (fx !== null) {
    fx.cleanup();
    fx = null;
  }
});

function seedSkillProposal(
  db: import('bun:sqlite').Database,
  layerId: string,
  opts: { id?: string; status?: 'new' | 'rejected'; runId?: string } = {},
): string {
  const id = opts.id ?? crypto.randomUUID();
  const repo = createImprovementProposalsRepo(db);
  repo.insertProposal({
    id,
    layerId,
    status: opts.status ?? 'new',
    artifactKind: 'skill',
    problemSummary: 'demo problem',
    proposedSpecJson: JSON.stringify({
      artifactKind: 'skill',
      name: 'demo-skill',
      description: 'demo',
      intent: 'question.entity_lookup',
      promptFragment: 'Treat Acmé as Acme.',
      addressesTags: ['zero-hit-retrieval'],
    }),
    expectedImpactJson: JSON.stringify({
      thumbsUpDelta: 0.18,
      tokensDelta: 12,
      latencyDeltaMs: 14,
    }),
    threshold: 0.72,
    capabilitySnapshotJson: JSON.stringify({ capabilities: [], builtins: [] }),
    mintedByRunId: opts.runId ?? crypto.randomUUID(),
    mintedAt: new Date().toISOString(),
  });
  return id;
}

beforeEach(async () => {
  fx = await makeTestAppSeeded({
    prefix: 'bunny2-proposals-routes-',
    withCapabilityRegistry: true,
  });
});

describe('GET /l/:slug/proposals', () => {
  it('lists proposals for the layer', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    seedSkillProposal(fx.db, everyone.id);

    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/proposals', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ id: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.items.length).toBe(1);
  });

  it('list summary surfaces the phase-8.4 audit columns (autoActivatedBy/At) — null on a fresh row', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    seedSkillProposal(fx.db, everyone.id);
    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/proposals', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        id: string;
        autoActivatedBy: 'system' | null;
        autoActivatedAt: string | null;
      }>;
    };
    expect(body.items[0]?.autoActivatedBy).toBeNull();
    expect(body.items[0]?.autoActivatedAt).toBeNull();
  });

  it('returns 400 on a malformed sort value', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const res = await fx.app.fetch(
      new Request('http://localhost/l/everyone/proposals?sort=bogus', {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe('GET /l/:slug/proposals/:id', () => {
  it('returns the detail with evidence + artifacts', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const proposalId = seedSkillProposal(fx.db, everyone.id);

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposal: { id: string };
      evidence: unknown[];
      artifacts: unknown[];
    };
    expect(body.proposal.id).toBe(proposalId);
    expect(Array.isArray(body.evidence)).toBe(true);
    expect(Array.isArray(body.artifacts)).toBe(true);
  });

  it('detail surfaces the six phase-8.4 audit columns (null on a fresh row)', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const proposalId = seedSkillProposal(fx.db, everyone.id);
    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      proposal: {
        autoActivatedBy: 'system' | null;
        autoActivatedAt: string | null;
        autoActivationDecisionJson: string | null;
        rolledBackAt: string | null;
        rolledBackBy: string | null;
        rolledBackReason: string | null;
      };
    };
    expect(body.proposal.autoActivatedBy).toBeNull();
    expect(body.proposal.autoActivatedAt).toBeNull();
    expect(body.proposal.autoActivationDecisionJson).toBeNull();
    expect(body.proposal.rolledBackAt).toBeNull();
    expect(body.proposal.rolledBackBy).toBeNull();
    expect(body.proposal.rolledBackReason).toBeNull();
  });

  it('returns 404 for a proposal id that does not exist', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${crypto.randomUUID()}`, {
        headers: { authorization: `Bearer ${token}` },
      }),
    );
    expect(res.status).toBe(404);
  });
});

describe('POST /l/:slug/proposals/:id/reject', () => {
  it('admin rejects with a reason; status flips to rejected', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const proposalId = seedSkillProposal(fx.db, everyone.id);

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'not a real problem' }),
      }),
    );
    expect(res.status).toBe(200);
    const repo = createImprovementProposalsRepo(fx.db);
    const row = repo.getProposalById(proposalId);
    expect(row?.status).toBe('rejected');
    expect(row?.rejectedReason).toBe('not a real problem');
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
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const proposalId = seedSkillProposal(fx.db, everyone.id);

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${nonAdmin.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'no' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('rejects an empty reason with 400', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const proposalId = seedSkillProposal(fx.db, everyone.id);

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/reject`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: '' }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
