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
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';
import { PROPOSAL_ROLLED_BACK_EVENT_TYPE } from '../src/proposals/events';

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

// Phase 8.5 — manual rollback HTTP tests. We seed an `'activated'`
// proposal directly via the repo and pair it with a live capability
// (origin `'proposal:<id>'`) — this mirrors what `replanOnApproval`
// leaves behind after a human approve, without paying the LLM mock /
// sandbox cost a full approve round-trip would.
function seedActivatedProposalWithCapability(
  fx: TestApp,
  layerId: string,
  opts: { autoActivatedBySystem?: boolean } = {},
): { proposalId: string; capabilityId: string } {
  const proposalsRepo = createImprovementProposalsRepo(fx.db);
  const capabilitiesRepo = createLayerCapabilitiesRepo(fx.db);
  const proposalId = crypto.randomUUID();
  const nowIso = new Date().toISOString();
  proposalsRepo.insertProposal({
    id: proposalId,
    layerId,
    status: 'activated',
    artifactKind: 'skill',
    problemSummary: 'demo problem',
    proposedSpecJson: JSON.stringify({
      artifactKind: 'skill',
      name: 'rollback-target',
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
    mintedByRunId: crypto.randomUUID(),
    mintedAt: nowIso,
  });
  proposalsRepo.updateStatus(proposalId, {
    status: 'activated',
    activatedAt: nowIso,
  });
  if (opts.autoActivatedBySystem === true) {
    proposalsRepo.recordAutoActivation(proposalId, nowIso);
  }
  const capability = capabilitiesRepo.insertCapability({
    id: crypto.randomUUID(),
    layerId,
    kind: 'skill',
    name: `rollback-target-${proposalId.slice(0, 8)}`,
    specJson: JSON.stringify({}),
    origin: `proposal:${proposalId}`,
    activatedAt: nowIso,
  });
  return { proposalId, capabilityId: capability.id };
}

describe('POST /l/:slug/proposals/:id/rollback', () => {
  it('admin rolls back an activated proposal; row, capability, and bus event are all updated', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const { proposalId, capabilityId } = seedActivatedProposalWithCapability(fx, everyone.id);

    // Capture `proposal.rolled-back` payloads to confirm the reason
    // text is *not* on the wire (ADR 0027 §3 / plan §10).
    const rollbackPayloads: Array<Record<string, unknown>> = [];
    fx.bus.subscribe(PROPOSAL_ROLLED_BACK_EVENT_TYPE, (e) => {
      rollbackPayloads.push(e.payload as Record<string, unknown>);
    });

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/rollback`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'capability misbehaved on rollback' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; capabilityId: string };
    expect(body.status).toBe('rolled-back');
    expect(body.capabilityId).toBe(capabilityId);

    const proposalsRepo = createImprovementProposalsRepo(fx.db);
    const row = proposalsRepo.getProposalById(proposalId);
    expect(row?.rolledBackAt).not.toBeNull();
    expect(row?.rolledBackBy).toBeTruthy();
    expect(row?.rolledBackReason).toBe('capability misbehaved on rollback');

    const capabilitiesRepo = createLayerCapabilitiesRepo(fx.db);
    const cap = capabilitiesRepo.getById(capabilityId);
    expect(cap?.deactivatedAt).not.toBeNull();

    // Let the bus dispatch loop drain.
    await new Promise<void>((r) => setTimeout(r, 0));
    expect(rollbackPayloads.length).toBe(1);
    const payload = rollbackPayloads[0]!;
    expect(payload.proposalId).toBe(proposalId);
    expect(payload.capabilityId).toBe(capabilityId);
    // Anti-leak invariant — reason text never crosses the wire.
    expect('reason' in payload).toBe(false);
    expect('rolledBackReason' in payload).toBe(false);
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
    const { proposalId } = seedActivatedProposalWithCapability(fx, everyone.id);

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/rollback`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${nonAdmin.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'should not be allowed' }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it('returns 404 for a proposal from a different layer (no leak)', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    const personal = createLayersRepo(fx.db).getLayerBySlug('personal-admin');
    if (everyone === null || personal === null) throw new Error('expected seeded layers');
    // Seed the proposal on `personal-admin`, then probe via `/l/everyone/…`.
    const { proposalId } = seedActivatedProposalWithCapability(fx, personal.id);

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/rollback`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ reason: 'cross-layer probe' }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it('returns 400 when the reason is missing, too short, or too long', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const { proposalId } = seedActivatedProposalWithCapability(fx, everyone.id);

    // Missing body
    const missing = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/rollback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        // No body — `c.req.json()` rejects.
      }),
    );
    expect(missing.status).toBe(400);

    // Reason too short (4 chars)
    const tooShort = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/rollback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'four' }),
      }),
    );
    expect(tooShort.status).toBe(400);

    // Reason too long (> 2000 chars)
    const tooLong = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/rollback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'a'.repeat(2001) }),
      }),
    );
    expect(tooLong.status).toBe(400);
  });

  it('returns 409 errors.proposal.notActivated for a non-activated proposal', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    // Status `'new'` — the seed helper defaults to `'new'`.
    const proposalId = seedSkillProposal(fx.db, everyone.id);

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/rollback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'should not roll back a new proposal' }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.proposal.notActivated');
  });

  it('returns 409 errors.proposal.alreadyDeactivated when the capability is already deactivated', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const { proposalId, capabilityId } = seedActivatedProposalWithCapability(fx, everyone.id);

    // Simulate the phase-7.6 capabilities deactivate route having
    // already fired before rollback is attempted.
    createLayerCapabilitiesRepo(fx.db).deactivate(capabilityId, new Date().toISOString());

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/rollback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'capability already gone' }),
      }),
    );
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('errors.proposal.alreadyDeactivated');
  });

  it('rolls back an auto-activated proposal exactly like a human-activated one (ADR 0027 §3 universal)', async () => {
    if (fx === null) throw new Error('no fx');
    const { token } = await loginSeededAdminRotated({
      db: fx.db,
      bus: fx.bus,
      app: fx.app,
      seedLog: fx.seedLog,
    });
    const everyone = createLayersRepo(fx.db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const { proposalId, capabilityId } = seedActivatedProposalWithCapability(fx, everyone.id, {
      autoActivatedBySystem: true,
    });

    const proposalsRepo = createImprovementProposalsRepo(fx.db);
    expect(proposalsRepo.getProposalById(proposalId)?.autoActivatedBy).toBe('system');

    const res = await fx.app.fetch(
      new Request(`http://localhost/l/everyone/proposals/${proposalId}/rollback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ reason: 'auto-activation regressed retrieval' }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; capabilityId: string };
    expect(body.status).toBe('rolled-back');
    expect(body.capabilityId).toBe(capabilityId);

    const row = proposalsRepo.getProposalById(proposalId);
    expect(row?.rolledBackAt).not.toBeNull();
    expect(row?.autoActivatedBy).toBe('system');
  });
});
