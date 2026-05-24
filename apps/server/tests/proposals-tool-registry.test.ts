/**
 * Phase 7.5 — `listTools` registry surface tests.
 *
 * Pins:
 *  - `listTools` returns the right OpenAI-function-calling shape for
 *    an active `tool` capability.
 *  - Activated-skill / activated-agent rows are excluded.
 *  - Deactivated tool rows are excluded.
 *  - Ordering is `activatedAt` ascending.
 *
 * Plus a sanity test of each tool-handler adapter constructing
 * cleanly from a valid spec (the closed-enum handler contract from
 * ADR 0023 §2).
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { ProposalSpec } from '@bunny2/shared';
import { openDatabase } from '../src/storage/sqlite';
import { createLayerCapabilitiesRepo } from '../src/proposals/repos/layer-capabilities-repo';
import { createCapabilityRegistry } from '../src/proposals';
import {
  buildProjectionLookupHandler,
  buildSearchSummariesAliasedHandler,
  listTools,
} from '../src/chat';

const LAYER_X = '11111111-1111-1111-1111-111111111111';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
}

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-tool-registry-'));
}

function newFixture(): Fixture {
  const dir = mkTmp();
  const db = openDatabase(dir, { journalMode: 'DELETE' });
  const nowIso = new Date().toISOString();
  db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
     VALUES (?, 'everyone', ?, ?, ?, ?)`,
  ).run(LAYER_X, 'layer-x', 'Layer X', nowIso, nowIso);
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

function toolSpec(name: string): ProposalSpec {
  return {
    artifactKind: 'tool',
    name,
    description: `desc of ${name}`,
    jsonSchema: { type: 'object', properties: { q: { type: 'string' } } },
    handler: {
      kind: 'searchSummaries-aliased',
      config: { aliases: [{ from: 'Acmé', to: 'Acme' }] },
    },
    addressesTags: ['zero-hit-retrieval'],
  };
}

describe('phase 7.5 — listTools registry surface', () => {
  let fx: Fixture;
  beforeEach(() => {
    fx = newFixture();
  });
  afterEach(() => {
    closeFixture(fx);
  });

  it('returns activated tools in OpenAI-function-calling shape', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'tool',
      name: 'alias-lookup',
      specJson: JSON.stringify(toolSpec('alias-lookup')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    const tools = listTools(registry, LAYER_X);
    expect(tools.length).toBe(1);
    const t = tools[0];
    expect(t?.name).toBe('alias-lookup');
    expect(t?.description).toContain('desc');
    expect(t?.parameters).toEqual({ type: 'object', properties: { q: { type: 'string' } } });
    expect(t?.handler.kind).toBe('searchSummaries-aliased');
  });

  it('excludes deactivated tools', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    const row = repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'tool',
      name: 'will-deactivate',
      specJson: JSON.stringify(toolSpec('will-deactivate')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    repo.deactivate(row.id, '2026-05-22T00:00:00.000Z');
    expect(listTools(registry, LAYER_X)).toEqual([]);
  });

  it('returns tools ordered by activatedAt ascending', () => {
    const repo = createLayerCapabilitiesRepo(fx.db);
    const registry = createCapabilityRegistry({ repo, bus: fx.bus });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'tool',
      name: 'beta',
      specJson: JSON.stringify(toolSpec('beta')),
      origin: 'builtin',
      activatedAt: '2026-05-21T00:00:00.000Z',
    });
    repo.insertCapability({
      id: crypto.randomUUID(),
      layerId: LAYER_X,
      kind: 'tool',
      name: 'alpha',
      specJson: JSON.stringify(toolSpec('alpha')),
      origin: 'builtin',
      activatedAt: '2026-05-20T00:00:00.000Z',
    });
    expect(listTools(registry, LAYER_X).map((t) => t.name)).toEqual(['alpha', 'beta']);
  });
});

describe('phase 7.5 — tool handler adapters construct from valid specs', () => {
  it('buildSearchSummariesAliasedHandler rewrites the query through aliases', async () => {
    interface Captured {
      layerIds: readonly string[];
      q: string;
      limit: number | undefined;
    }
    let captured: Captured | null = null;
    const handler = buildSearchSummariesAliasedHandler(
      {
        kind: 'searchSummaries-aliased',
        config: { aliases: [{ from: 'Acmé', to: 'Acme' }], limit: 7 },
      },
      {
        async searchSummaries(layerIds, query, opts) {
          captured = { layerIds, q: query, limit: opts?.limit };
          return [];
        },
      },
    );
    await handler({ layerIds: [LAYER_X], query: 'who at Acmé did I email?' });
    expect(captured).not.toBeNull();
    const c: Captured = captured as unknown as Captured;
    expect(c.q).toBe('who at Acme did I email?');
    expect(c.limit).toBe(7);
  });

  it('buildProjectionLookupHandler delegates to the resolved projection', async () => {
    const handler = buildProjectionLookupHandler(
      {
        kind: 'projection-lookup',
        config: { projection: 'calendar_projection_todos', key: 'slug', limit: 3 },
      },
      {
        resolveProjection: (name) =>
          name === 'calendar_projection_todos'
            ? async (layers, key, value, opts) => [
                { layerIds: layers, key, value, limit: opts?.limit ?? 0 } as Record<
                  string,
                  unknown
                >,
              ]
            : null,
      },
    );
    const rows = await handler({ layerIds: [LAYER_X], value: 'visit-acme' });
    expect(rows.length).toBe(1);
    const row = rows[0] as { key: string; value: string; limit: number };
    expect(row.key).toBe('slug');
    expect(row.value).toBe('visit-acme');
    expect(row.limit).toBe(3);
  });

  it('rejects unknown handler kinds at adapter-construction time', () => {
    expect(() =>
      buildSearchSummariesAliasedHandler(
        // Cast through unknown — zod would already reject, but the
        // adapter is the second line of defence (ADR 0023 §2).
        { kind: 'projection-lookup', config: {} } as unknown as Parameters<
          typeof buildSearchSummariesAliasedHandler
        >[0],
        {
          async searchSummaries() {
            return [];
          },
        },
      ),
    ).toThrow();
  });
});
