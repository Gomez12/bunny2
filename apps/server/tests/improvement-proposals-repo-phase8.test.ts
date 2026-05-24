import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { createUsersRepo } from '../src/repos/users-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { createImprovementProposalsRepo } from '../src/proposals/repos/improvement-proposals-repo';

/**
 * Phase 8.1 — audit columns on `improvement_proposals`:
 *
 *   - `recordAutoActivationDecision` writes the decision JSON
 *     before `replanOnApproval` runs (ADR 0026 §4).
 *   - `recordAutoActivation` stamps `auto_activated_by = 'system'`
 *     and `auto_activated_at` after the replan returns
 *     (ADR 0026 §3).
 *   - `recordRollback` stamps the three rollback columns in the
 *     same transaction the rollback route soft-deactivates the
 *     capability (ADR 0027 §2).
 *
 * The harness mirrors `proposals-repo.test.ts`: temp-dir Database
 * per test, migrations applied from disk via `openDatabase`.
 */

const now = () => new Date().toISOString();

function mkDb(): Database {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-proposals-phase8-'));
  return openDatabase(dir);
}

interface Seeded {
  userId: string;
  layerId: string;
}

function seedLayerAndUser(db: Database): Seeded {
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
  return { userId: user.id, layerId: layer.id };
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

describe('improvement-proposals-repo — phase 8 audit columns', () => {
  it('starts all six new audit columns NULL on a freshly inserted proposal', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerAndUser(db);
      const repo = createImprovementProposalsRepo(db);
      const created = repo.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: 's',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.7,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      expect(created.autoActivatedBy).toBeNull();
      expect(created.autoActivatedAt).toBeNull();
      expect(created.autoActivationDecisionJson).toBeNull();
      expect(created.rolledBackAt).toBeNull();
      expect(created.rolledBackBy).toBeNull();
      expect(created.rolledBackReason).toBeNull();
    } finally {
      db.close();
    }
  });

  it('recordAutoActivationDecision writes the JSON column without touching status', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerAndUser(db);
      const repo = createImprovementProposalsRepo(db);
      const created = repo.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: 's',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.7,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      const decisionJson = JSON.stringify({
        outcome: 'eligible',
        gates: [
          { name: 'auto-activation-enabled', passed: true },
          { name: 'cooldown-elapsed', passed: true },
        ],
      });
      repo.recordAutoActivationDecision(created.id, decisionJson);
      const reloaded = repo.getProposalById(created.id);
      expect(reloaded?.autoActivationDecisionJson).toBe(decisionJson);
      // Status is left to other methods — `recordAutoActivationDecision`
      // is audit-only (ADR 0026 §4).
      expect(reloaded?.status).toBe('new');
      // The other audit columns stay NULL.
      expect(reloaded?.autoActivatedBy).toBeNull();
      expect(reloaded?.autoActivatedAt).toBeNull();
    } finally {
      db.close();
    }
  });

  it('recordAutoActivation writes auto_activated_by="system" and auto_activated_at', () => {
    const db = mkDb();
    try {
      const { layerId } = seedLayerAndUser(db);
      const repo = createImprovementProposalsRepo(db);
      const created = repo.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: 's',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.7,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      repo.recordAutoActivation(created.id, '2026-05-10T00:00:00.000Z');
      const reloaded = repo.getProposalById(created.id);
      expect(reloaded?.autoActivatedBy).toBe('system');
      expect(reloaded?.autoActivatedAt).toBe('2026-05-10T00:00:00.000Z');
      // `approved_by` stays NULL — the auto-path never writes it
      // (ADR 0026 §3).
      expect(reloaded?.approvedBy).toBeNull();
    } finally {
      db.close();
    }
  });

  it('recordRollback writes all three rollback columns in one call', () => {
    const db = mkDb();
    try {
      const { layerId, userId } = seedLayerAndUser(db);
      const repo = createImprovementProposalsRepo(db);
      const created = repo.insertProposal({
        id: crypto.randomUUID(),
        layerId,
        status: 'new',
        artifactKind: 'skill',
        problemSummary: 's',
        proposedSpecJson: sampleSpecJson(),
        expectedImpactJson: sampleImpactJson(),
        threshold: 0.7,
        capabilitySnapshotJson: sampleSnapshotJson(),
        mintedByRunId: 'run-1',
        mintedAt: now(),
      });
      repo.recordRollback(created.id, {
        rolledBackBy: userId,
        reason: 'Skill regressed on the calendar event lookup.',
        now: '2026-05-15T00:00:00.000Z',
      });
      const reloaded = repo.getProposalById(created.id);
      expect(reloaded?.rolledBackAt).toBe('2026-05-15T00:00:00.000Z');
      expect(reloaded?.rolledBackBy).toBe(userId);
      expect(reloaded?.rolledBackReason).toBe('Skill regressed on the calendar event lookup.');
    } finally {
      db.close();
    }
  });
});
