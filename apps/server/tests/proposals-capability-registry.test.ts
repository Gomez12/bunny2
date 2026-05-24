/**
 * Phase 7.4 — capability registry + in-memory overlay invariants.
 *
 * Pins ADR 0024 §1 ("in-memory capability overlay"):
 *  - `listActive(layerId)` returns live rows only when no overlay.
 *  - `withOverlay(...)` returns a view where overlay rows shadow live
 *    rows by `(layerId, kind, name)`.
 *  - Overlay rows for a non-matching `layerId` do NOT leak into other
 *    layers' lists.
 *  - The underlying live registry is NEVER mutated by overlay reads.
 *  - `activate(...)` writes one `layer_capabilities` row + publishes
 *    `proposal.activated` once.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { LayerCapability, ProposalSpec } from '@bunny2/shared';
import { openDatabase } from '../src/storage/sqlite';
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';
import { createCapabilityRegistry, PROPOSAL_ACTIVATED_EVENT_TYPE } from '../src/proposals';

const LAYER_X = '11111111-1111-1111-1111-111111111111';
const LAYER_Y = '22222222-2222-2222-2222-222222222222';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-cap-registry-'));
}

function newFixture(): Fixture {
  const dir = mkTmp();
  const db = openDatabase(dir, { journalMode: 'DELETE' });
  // Layers so layer FK on insertCapability holds.
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

function skillSpec(name: string): ProposalSpec {
  return {
    artifactKind: 'skill',
    name,
    description: 'test skill',
    intent: 'question.entity_lookup',
    promptFragment: 'test',
    addressesTags: ['zero-hit-retrieval'],
  };
}

function overlayRow(opts: { layerId: string; kind: 'skill'; name: string }): LayerCapability {
  return {
    id: `overlay-${opts.name}`,
    layerId: opts.layerId,
    kind: opts.kind,
    name: opts.name,
    specJson: JSON.stringify(skillSpec(opts.name)),
    origin: 'proposal:00000000-0000-0000-0000-000000000099',
    activatedAt: new Date().toISOString(),
    deactivatedAt: null,
  };
}

describe('phase 7.4 — capability registry overlay invariants', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = newFixture();
  });
  afterEach(() => {
    closeFixture(fx);
  });

  it('listActive without overlay returns the live rows in activation order', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'live-1',
      specJson: JSON.stringify(skillSpec('live-1')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'live-2',
      specJson: JSON.stringify(skillSpec('live-2')),
      origin: 'builtin',
      activatedAt: '2026-05-21T00:00:00.000Z',
    });
    const active = registry.listActive(LAYER_X);
    expect(active.map((c) => c.name)).toEqual(['live-1', 'live-2']);
  });

  it('withOverlay shadows colliding live rows by (kind, name) — overlay wins', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'shadow-me',
      specJson: JSON.stringify(skillSpec('live-shadow-me')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    const view = registry.withOverlay([
      overlayRow({ layerId: LAYER_X, kind: 'skill', name: 'shadow-me' }),
    ]);
    const active = view.listActive(LAYER_X);
    expect(active.length).toBe(1);
    expect(active[0]?.id).toBe('overlay-shadow-me');
    expect(active[0]?.origin).toContain('proposal:');
  });

  it('withOverlay appends non-colliding overlay rows alongside live rows', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'live-only',
      specJson: JSON.stringify(skillSpec('live-only')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    const view = registry.withOverlay([
      overlayRow({ layerId: LAYER_X, kind: 'skill', name: 'new-overlay' }),
    ]);
    const active = view.listActive(LAYER_X);
    expect(active.map((c) => c.name).sort()).toEqual(['live-only', 'new-overlay']);
  });

  it('withOverlay does not mutate the underlying live registry', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'skill',
      name: 'live-1',
      specJson: JSON.stringify(skillSpec('live-1')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    // Take a view and consume it.
    const view = registry.withOverlay([
      overlayRow({ layerId: LAYER_X, kind: 'skill', name: 'live-1' }),
    ]);
    void view.listActive(LAYER_X);
    // The base registry must STILL see only the live row, not the
    // overlay row.
    expect(registry.listActive(LAYER_X).map((c) => c.name)).toEqual(['live-1']);
    expect(registry.listActive(LAYER_X)[0]?.origin).toBe('builtin');
  });

  it('overlay for layer X does NOT leak into layer Y', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_Y,
      kind: 'skill',
      name: 'y-live',
      specJson: JSON.stringify(skillSpec('y-live')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    const view = registry.withOverlay([
      overlayRow({ layerId: LAYER_X, kind: 'skill', name: 'x-overlay' }),
    ]);
    expect(view.listActive(LAYER_Y).map((c) => c.name)).toEqual(['y-live']);
    expect(view.listActive(LAYER_X).map((c) => c.name)).toEqual(['x-overlay']);
  });

  it('activate writes one layer_capabilities row and publishes proposal.activated once', async () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });

    const events: unknown[] = [];
    fx.bus.subscribe(PROPOSAL_ACTIVATED_EVENT_TYPE, (e) => {
      events.push(e.payload);
    });

    const spec = skillSpec('activated-via-test');
    const cap = registry.activate({
      layerId: LAYER_X,
      kind: 'skill',
      name: spec.name,
      spec,
      origin: 'proposal:00000000-0000-0000-0000-000000000042',
    });
    // Allow the publish promise queued via .catch to resolve.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(cap.layerId).toBe(LAYER_X);
    const rows = repo.listActiveByLayer(LAYER_X);
    expect(rows.length).toBe(1);
    expect(rows[0]?.name).toBe('activated-via-test');
    expect(rows[0]?.origin).toBe('proposal:00000000-0000-0000-0000-000000000042');
    expect(events.length).toBe(1);
  });
});
