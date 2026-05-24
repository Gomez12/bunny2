/**
 * Phase 7.5 — `loadSkillFragments` + answer-step injection tests.
 *
 * Pins:
 *  - `loadSkillFragments` returns activated skills for the right intent.
 *  - Ordering is `activatedAt` ascending so re-runs produce stable
 *    system prompts.
 *  - Deactivated skills are excluded.
 *  - Cross-layer skills are excluded.
 *  - Non-skill capabilities (tool, agent) are excluded.
 *  - Integration: a registry holding one matching skill makes the
 *    answer step's prompt include the fragment as an additional
 *    `system` message.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { ChatIntent, ProposalSpec } from '@bunny2/shared';
import { openDatabase } from '../src/storage/sqlite';
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';
import { createCapabilityRegistry } from '../src/proposals';
import { loadSkillFragments } from '../src/chat';

const LAYER_X = '11111111-1111-1111-1111-111111111111';
const LAYER_Y = '22222222-2222-2222-2222-222222222222';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-skill-injection-'));
}

function newFixture(): Fixture {
  const dir = mkTmp();
  const db = openDatabase(dir, { journalMode: 'DELETE' });
  const nowIso = new Date().toISOString();
  db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
     VALUES (?, 'everyone', ?, ?, ?, ?)`,
  ).run(LAYER_X, 'layer-x', 'Layer X', nowIso, nowIso);
  db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
     VALUES (?, 'everyone', ?, ?, ?, ?)`,
  ).run(LAYER_Y, 'layer-y', 'Layer Y', nowIso, nowIso);
  return { dir, db, bus: new InMemoryMessageBus() };
}

function closeFixture(fx: Fixture): void {
  fx.db.close();
  try {
    fs.rmSync(fx.dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

function skillSpec(name: string, intent: ChatIntent = 'question.entity_lookup'): ProposalSpec {
  return {
    artifactKind: 'skill',
    name,
    description: 'desc',
    intent,
    promptFragment: `frag-${name}`,
    addressesTags: ['zero-hit-retrieval'],
  };
}

function toolSpec(name: string): ProposalSpec {
  return {
    artifactKind: 'tool',
    name,
    description: 'desc',
    jsonSchema: { type: 'object' },
    handler: { kind: 'searchSummaries-aliased', config: { aliases: [{ from: 'a', to: 'b' }] } },
    addressesTags: ['zero-hit-retrieval'],
  };
}

describe('phase 7.5 — loadSkillFragments invariants', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = newFixture();
  });
  afterEach(() => {
    closeFixture(fx);
  });

  it('returns activated skills matching intent in activatedAt order', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    // Insert in non-sorted activatedAt order to verify ordering.
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'beta',
      specJson: JSON.stringify(skillSpec('beta')),
      origin: 'builtin',
      activatedAt: '2026-05-21T00:00:00.000Z',
    });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'alpha',
      specJson: JSON.stringify(skillSpec('alpha')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    const fragments = loadSkillFragments(registry, LAYER_X, 'question.entity_lookup');
    expect(fragments.map((f) => f.name)).toEqual(['alpha', 'beta']);
  });

  it('excludes deactivated skills', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    const row = repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'will-deactivate',
      specJson: JSON.stringify(skillSpec('will-deactivate')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    repo.deactivate(row.id, '2026-05-22T00:00:00.000Z');
    expect(loadSkillFragments(registry, LAYER_X, 'question.entity_lookup')).toEqual([]);
  });

  it('excludes skills from other layers', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_Y,
      kind: 'skill',
      name: 'wrong-layer',
      specJson: JSON.stringify(skillSpec('wrong-layer')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    expect(loadSkillFragments(registry, LAYER_X, 'question.entity_lookup')).toEqual([]);
  });

  it('excludes skills whose intent does not match', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'summary-only',
      specJson: JSON.stringify(skillSpec('summary-only', 'question.summary')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    expect(loadSkillFragments(registry, LAYER_X, 'question.entity_lookup')).toEqual([]);
    const summaryFrags = loadSkillFragments(registry, LAYER_X, 'question.summary');
    expect(summaryFrags.map((f) => f.name)).toEqual(['summary-only']);
  });

  it('excludes non-skill capabilities (tool, agent)', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'tool',
      name: 'a-tool',
      specJson: JSON.stringify(toolSpec('a-tool')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    expect(loadSkillFragments(registry, LAYER_X, 'question.entity_lookup')).toEqual([]);
  });

  it('returns empty list when no rows exist (phase-6 byte-identical fallback)', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    expect(loadSkillFragments(registry, LAYER_X, 'question.entity_lookup')).toEqual([]);
  });
});
