/**
 * Phase 7.6 — `proposals.evidence.prune` retention boundary test.
 *
 * Asserts:
 *  - Evidence + artifact rows for proposals older than the cutoff in
 *    terminal status (`rejected`) are deleted.
 *  - Proposals in `new` status are NEVER touched, regardless of age.
 *  - The proposal row itself survives — only the heavy child rows go.
 *  - Idempotent: a second prune against the same cutoff is a no-op.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { openDatabase } from '../src/storage/sqlite';
import { safeRmSync } from './_helpers/temp-dir';
import { createImprovementProposalsRepo } from '../src/proposals/repos/improvement-proposals-repo';
import { createLayersRepo } from '../src/repos/layers-repo';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { seedAdminIfNeeded } from '../src/auth/seed';
import { createGroupResolver } from '../src/auth/group-resolver';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import { pruneProposalEvidence } from '../src/proposals/evidence-prune-handler';

let dir: string;
let db: Database;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-proposal-prune-'));
  db = openDatabase(dir);
  const bus = new InMemoryMessageBus();
  await seedAdminIfNeeded({ db, bus, log: () => {} });
  await seedLayersIfNeeded({ db, bus, transitiveGroups: createGroupResolver({ db, bus }) });
});

afterEach(() => {
  try {
    db.close();
  } catch {
    /* already */
  }
  try {
    safeRmSync(dir);
  } catch {
    /* best-effort */
  }
});

function seedProposalWithEvidence(
  layerId: string,
  status: 'new' | 'rejected' | 'superseded',
  mintedAt: string,
): string {
  const proposalsRepo = createImprovementProposalsRepo(db);
  const id = crypto.randomUUID();
  proposalsRepo.insertProposal({
    id,
    layerId,
    status,
    artifactKind: 'skill',
    problemSummary: 'demo',
    proposedSpecJson: '{}',
    expectedImpactJson: '{}',
    threshold: 0.5,
    capabilitySnapshotJson: '{}',
    mintedByRunId: crypto.randomUUID(),
    mintedAt,
  });
  // Seed a real chat conversation + message so the evidence FK holds.
  const userRow = db.query<{ id: string }, []>('SELECT id FROM users LIMIT 1').get();
  if (userRow === null) throw new Error('expected seeded user');
  const convId = crypto.randomUUID();
  db.query<unknown, [string, string, string, string, string, string, string]>(
    `INSERT INTO chat_conversations
       (id, layer_id, user_id, title, locale, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(convId, layerId, userRow.id, 'demo', 'en', mintedAt, mintedAt);
  const msgId = crypto.randomUUID();
  db.query<unknown, [string, string, string, string, string, string, string, string]>(
    `INSERT INTO chat_messages
       (id, conversation_id, role, content, status, correlation_id, flow_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(msgId, convId, 'user', 'demo', 'done', crypto.randomUUID(), `chat:${convId}`, mintedAt);
  // Now the FK-safe evidence row.
  db.query<unknown, [string, string, string, string]>(
    `INSERT INTO improvement_proposal_evidence
       (id, proposal_id, message_id, cluster_reason)
     VALUES (?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), id, msgId, 'thumbs-down');
  // Artifact row.
  db.query<unknown, [string, string, string, string, string, string]>(
    `INSERT INTO improvement_proposal_artifacts
       (id, proposal_id, variant, transcript_json, metrics_json, ran_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(crypto.randomUUID(), id, 'current', '{}', '{}', mintedAt);
  return id;
}

describe('proposals.evidence.prune', () => {
  it('deletes evidence + artifacts for old rejected proposals', () => {
    const everyone = createLayersRepo(db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const now = new Date('2026-05-24T00:00:00.000Z');
    // 100 days ago = older than the 90-day cutoff
    const oldIso = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const id = seedProposalWithEvidence(everyone.id, 'rejected', oldIso);

    const result = pruneProposalEvidence(db, { maxAgeDays: 90 }, now);

    expect(result.proposalsTouched).toBe(1);
    expect(result.evidenceDeleted).toBe(1);
    expect(result.artifactsDeleted).toBe(1);
    // The proposal row itself survives.
    const repo = createImprovementProposalsRepo(db);
    expect(repo.getProposalById(id)).not.toBeNull();
  });

  it('does NOT touch new proposals regardless of age', () => {
    const everyone = createLayersRepo(db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const now = new Date('2026-05-24T00:00:00.000Z');
    const oldIso = new Date(now.getTime() - 1000 * 24 * 60 * 60 * 1000).toISOString();
    seedProposalWithEvidence(everyone.id, 'new', oldIso);

    const result = pruneProposalEvidence(db, { maxAgeDays: 90 }, now);

    expect(result.proposalsTouched).toBe(0);
    expect(result.evidenceDeleted).toBe(0);
    expect(result.artifactsDeleted).toBe(0);
  });

  it('is idempotent — a second prune against the same cutoff is a no-op', () => {
    const everyone = createLayersRepo(db).getLayerBySlug('everyone');
    if (everyone === null) throw new Error('expected everyone layer');
    const now = new Date('2026-05-24T00:00:00.000Z');
    const oldIso = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000).toISOString();
    seedProposalWithEvidence(everyone.id, 'superseded', oldIso);

    const first = pruneProposalEvidence(db, { maxAgeDays: 90 }, now);
    expect(first.evidenceDeleted).toBe(1);

    const second = pruneProposalEvidence(db, { maxAgeDays: 90 }, now);
    expect(second.proposalsTouched).toBe(1); // proposal still matches
    expect(second.evidenceDeleted).toBe(0); // nothing left to delete
    expect(second.artifactsDeleted).toBe(0);
  });
});
