import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createChatConversationsRepo } from '../src/chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../src/chat/repos/chat-messages-repo';
import { createImprovementProposalsRepo } from '../src/proposals/repos/improvement-proposals-repo';
import { createImprovementProposalEvidenceRepo } from '../src/proposals/repos/improvement-proposal-evidence-repo';
import { createImprovementProposalArtifactsRepo } from '../src/proposals/repos/improvement-proposal-artifacts-repo';
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-proposals-'));
  return openDatabase(dir);
}

interface Seeded {
  userId: string;
  layerId: string;
  conversationId: string;
  messageId: string;
}

function seedLayerUserAndMessage(db: Database): Seeded {
  const user = createUsersRepo(db).createUser({
    id: crypto.randomUUID(),
    username: 'admin',
    displayName: 'Admin',
    passwordHash: 'h',
    mustChangePassword: false,
    now: now(),
  });
  const layer = createLayersRepo(db).insertLayer({
    id: crypto.randomUUID(),
    type: 'everyone',
    slug: 'everyone',
    name: 'Everyone',
    now: now(),
  });
  const conv = createChatConversationsRepo(db).insertConversation({
    id: crypto.randomUUID(),
    layerId: layer.id,
    userId: user.id,
    title: 't',
    locale: 'en',
    now: now(),
  });
  const msg = createChatMessagesRepo(db).insertMessage({
    id: crypto.randomUUID(),
    conversationId: conv.id,
    role: 'user',
    content: 'Wanneer is mijn Acmé strategy meeting?',
    status: 'done',
    correlationId: 'corr-1',
    flowId: 'flow-1',
    now: now(),
  });
  return { userId: user.id, layerId: layer.id, conversationId: conv.id, messageId: msg.id };
}

function sampleSpecJson(): string {
  return JSON.stringify({
    artifactKind: 'skill',
    name: 'expand-acme-alias',
    description: 'Expand the Acmé alias to Acme so retrieval finds matches.',
    intent: 'question.entity_lookup',
    promptFragment: 'If the user writes Acmé, also search for Acme.',
    addressesTags: ['zero-hit-retrieval'],
  });
}

function sampleImpactJson(): string {
  return JSON.stringify({ thumbsUpDelta: 0.18, tokensDelta: 12, latencyDeltaMs: 14 });
}

function sampleSnapshotJson(): string {
  return JSON.stringify({ capabilities: [], builtins: [] });
}

describe('improvement-proposals-repo', () => {
  it('inserts and reads back a proposal with all timestamp fields null', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerUserAndMessage(db);
      const repo = createImprovementProposalsRepo(db);
      const created = repo.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: '3 messages got 0 retrieval hits searching for "Acmé"',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.72,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      expect(created.status).toBe('new');
      expect(created.artifactKind).toBe('skill');
      expect(created.threshold).toBeCloseTo(0.72, 5);
      expect(created.approvedBy).toBeNull();
      expect(created.deletedAt).toBeNull();
      expect(repo.getProposalById(created.id)?.problemSummary).toBe(created.problemSummary);
    } finally {
      db.close();
    }
  });

  it('lists proposals filtered by status and sorted by minted_at desc by default', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerUserAndMessage(db);
      const repo = createImprovementProposalsRepo(db);
      const older = repo.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: 'older',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.4,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: '2026-01-01T00:00:00.000Z',
      });
      const newer = repo.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'approved',
        artifactKind: 'skill',
        problemSummary: 'newer',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.9,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: '2026-02-01T00:00:00.000Z',
      });
      const all = repo.listProposals({ layerId });
      expect(all.map((p) => p.id)).toEqual([newer.id, older.id]);
      const onlyNew = repo.listProposals({ layerId, status: 'new' });
      expect(onlyNew.map((p) => p.id)).toEqual([older.id]);
      const byThreshold = repo.listProposals({ layerId, sortBy: 'threshold' });
      expect(byThreshold.map((p) => p.id)).toEqual([newer.id, older.id]);
    } finally {
      db.close();
    }
  });

  it('moves a proposal new → approved → activated via updateStatus', () => {
    const db = mkDb();
    try {
      const { layerId, userId } = seedLayerUserAndMessage(db);
      const repo = createImprovementProposalsRepo(db);
      const created = repo.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: 's',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.5,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      const approved = repo.updateStatus(created.id, {
        status: 'approved',
        approvedBy: userId,
        approvedAt: '2026-03-01T00:00:00.000Z',
      });
      expect(approved.status).toBe('approved');
      expect(approved.approvedBy).toBe(userId);
      expect(approved.approvedAt).toBe('2026-03-01T00:00:00.000Z');
      const activated = repo.updateStatus(created.id, {
        status: 'activated',
        activatedAt: '2026-03-01T00:01:00.000Z',
      });
      expect(activated.status).toBe('activated');
      expect(activated.activatedAt).toBe('2026-03-01T00:01:00.000Z');
      // Approved fields preserved across the second update.
      expect(activated.approvedBy).toBe(userId);
    } finally {
      db.close();
    }
  });

  it('soft-deletes and excludes the proposal from list by default; restore brings it back', () => {
    const db = mkDb();
    try {
      const { layerId, userId } = seedLayerUserAndMessage(db);
      const repo = createImprovementProposalsRepo(db);
      const created = repo.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'tool',
        problemSummary: 't',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.6,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      repo.softDeleteProposal(created.id, userId, '2026-04-01T00:00:00.000Z');
      const reloaded = repo.getProposalById(created.id);
      expect(reloaded?.deletedAt).toBe('2026-04-01T00:00:00.000Z');
      expect(reloaded?.deletedBy).toBe(userId);
      expect(repo.listProposals({ layerId }).length).toBe(0);
      expect(repo.listProposals({ layerId, includeDeleted: true }).length).toBe(1);
      repo.restoreProposal(created.id);
      expect(repo.getProposalById(created.id)?.deletedAt).toBeNull();
      expect(repo.listProposals({ layerId }).length).toBe(1);
    } finally {
      db.close();
    }
  });

  it('rejects insert with threshold outside [0, 1] via the SQL CHECK constraint', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerUserAndMessage(db);
      const repo = createImprovementProposalsRepo(db);
      expect(() =>
        repo.insertProposal({
          id: crypto.randomUUID(),
          layerId,
          status: 'new',
          artifactKind: 'skill',
          problemSummary: 'bad',
          proposedSpecJson: sampleSpecJson(),
          expectedImpactJson: sampleImpactJson(),
          threshold: 1.5,
          capabilitySnapshotJson: sampleSnapshotJson(),
          mintedByRunId: 'run-1',
          mintedAt: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });
});

describe('improvement-proposal-evidence-repo', () => {
  it('inserts a batch of evidence rows and lists them by proposal id', () => {
    const db = mkDb();
    try {
      const { layerId, messageId } = seedLayerUserAndMessage(db);
      const proposals = createImprovementProposalsRepo(db);
      const evidence = createImprovementProposalEvidenceRepo(db);
      const proposal = proposals.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: 's',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.5,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      const inserted = evidence.insertMany([
        {
          id: crypto.randomUUID(),
          proposalId: proposal.id,
          messageId,
          clusterReason: 'zero-hit-retrieval',
          detailJson: JSON.stringify({ hits: 0 }),
        },
        {
          id: crypto.randomUUID(),
          proposalId: proposal.id,
          messageId,
          clusterReason: 'thumbs-down',
        },
      ]);
      expect(inserted.length).toBe(2);
      const list = evidence.listByProposal(proposal.id);
      expect(list.length).toBe(2);
      expect(list.map((e) => e.clusterReason).sort()).toEqual([
        'thumbs-down',
        'zero-hit-retrieval',
      ]);
      const zero = list.find((e) => e.clusterReason === 'zero-hit-retrieval');
      expect(zero?.detailJson).toBe(JSON.stringify({ hits: 0 }));
      const td = list.find((e) => e.clusterReason === 'thumbs-down');
      expect(td?.detailJson).toBeNull();
    } finally {
      db.close();
    }
  });

  it('deleteByProposal removes every evidence row for that proposal', () => {
    const db = mkDb();
    try {
      const { layerId, messageId } = seedLayerUserAndMessage(db);
      const proposals = createImprovementProposalsRepo(db);
      const evidence = createImprovementProposalEvidenceRepo(db);
      const p = proposals.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: 's',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.5,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      evidence.insertMany([
        {
          id: crypto.randomUUID(),
          proposalId: p.id,
          messageId,
          clusterReason: 'zero-hit-retrieval',
        },
      ]);
      expect(evidence.listByProposal(p.id).length).toBe(1);
      evidence.deleteByProposal(p.id);
      expect(evidence.listByProposal(p.id).length).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe('improvement-proposal-artifacts-repo', () => {
  it('inserts artifacts and lists them in ran_at order', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerUserAndMessage(db);
      const proposals = createImprovementProposalsRepo(db);
      const artifacts = createImprovementProposalArtifactsRepo(db);
      const p = proposals.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: 's',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.5,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      const current = artifacts.insertArtifact({
        id: crypto.randomUUID(),
        proposalId: p.id,
        variant: 'current',
        transcriptJson: JSON.stringify({ output: 'no hits' }),
        metricsJson: JSON.stringify({ latencyMs: 100 }),
        ranAt: '2026-05-01T00:00:00.000Z',
      });
      const proposed = artifacts.insertArtifact({
        id: crypto.randomUUID(),
        proposalId: p.id,
        variant: 'proposed',
        transcriptJson: JSON.stringify({ output: 'one hit' }),
        metricsJson: JSON.stringify({ latencyMs: 114 }),
        ranAt: '2026-05-01T00:00:01.000Z',
      });
      const list = artifacts.listByProposal(p.id);
      expect(list.map((a) => a.id)).toEqual([current.id, proposed.id]);
      expect(list[0]?.variant).toBe('current');
      expect(list[1]?.variant).toBe('proposed');
    } finally {
      db.close();
    }
  });
});

describe('layer-capabilities-repo', () => {
  it('inserts a capability and lists it via active + getByName lookups', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerUserAndMessage(db);
      const repo = createLayerCapabilitiesRepo(db);
      const created = repo.insertCapability({
        id: crypto.randomUUID(),
        layerId,
        kind: 'skill',
        name: 'expand-acme-alias',
        specJson: sampleSpecJson(),
        origin: 'builtin',
        activatedAt: now(),
      });
      expect(repo.listActiveByLayer(layerId).map((c) => c.id)).toEqual([created.id]);
      expect(repo.getByName(layerId, 'skill', 'expand-acme-alias')?.id).toBe(created.id);
      expect(repo.getByName(layerId, 'tool', 'expand-acme-alias')).toBeNull();
    } finally {
      db.close();
    }
  });

  it('enforces UNIQUE (layer_id, kind, name) on insert', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerUserAndMessage(db);
      const repo = createLayerCapabilitiesRepo(db);
      repo.insertCapability({
        id: crypto.randomUUID(),
        layerId,
        kind: 'skill',
        name: 'expand-acme-alias',
        specJson: sampleSpecJson(),
        origin: 'builtin',
        activatedAt: now(),
      });
      expect(() =>
        repo.insertCapability({
          id: crypto.randomUUID(),
          layerId,
          kind: 'skill',
          name: 'expand-acme-alias',
          specJson: sampleSpecJson(),
          origin: 'builtin',
          activatedAt: now(),
        }),
      ).toThrow();
    } finally {
      db.close();
    }
  });

  it('deactivate flips deactivated_at and excludes the row from listActiveByLayer', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerUserAndMessage(db);
      const repo = createLayerCapabilitiesRepo(db);
      const created = repo.insertCapability({
        id: crypto.randomUUID(),
        layerId,
        kind: 'agent',
        name: 'meeting-summariser',
        specJson: sampleSpecJson(),
        origin: 'builtin',
        activatedAt: now(),
      });
      repo.deactivate(created.id, '2026-05-10T00:00:00.000Z');
      expect(repo.listActiveByLayer(layerId).length).toBe(0);
      const all = repo.listAllByLayer(layerId);
      expect(all.length).toBe(1);
      expect(all[0]?.deactivatedAt).toBe('2026-05-10T00:00:00.000Z');
    } finally {
      db.close();
    }
  });
});
