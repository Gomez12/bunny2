/**
 * Phase 7.6 — `/l/:slug/capabilities/*` HTTP routes.
 *
 * Surfaces the per-layer registry of activated tools / skills / agents.
 * Read is open to any layer member; deactivate is admin-only.
 *
 * Routes:
 *  - `GET  /l/:slug/capabilities`               — list active rows
 *  - `POST /l/:slug/capabilities/:id/deactivate` — admin; soft-deactivate
 *
 * The deactivate route does NOT call the repo directly — every mutation
 * to `layer_capabilities` MUST go through `capabilityRegistry.deactivate(...)`
 * so the bus event + per-kind hooks (agent unsubscribe) fire.
 *
 * Cross-layer probes return 404 (mirrors the `errors.layer.notVisible`
 * shape; never 403, never leaks the row's existence).
 */

import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import { z } from 'zod';
import { canEditLayer } from '../../layers/authz';
import { createRequireLayer } from '../middleware/layer';
import { ADMIN_GROUP_ID_KEY } from '../../auth/seed';
import { getMeta } from '../../storage/kv-meta';
import type { GroupResolver } from '../../auth/group-resolver';
import type { HonoVariables } from '../types';
import {
  createLayerCapabilitiesRepo,
  type LayerCapabilityRow,
} from '../../proposals/repos/layer-capabilities-repo';
import type { CapabilityRegistry } from '../../proposals';

const BAD_REQUEST = { error: 'errors.capabilities.badRequest' } as const;
const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;
const FORBIDDEN = { error: 'errors.layer.forbidden' } as const;
const NOT_FOUND = { error: 'errors.capabilities.notFound' } as const;

const EmptyBodySchema = z.object({}).strict();

export interface LayerCapabilitiesRouteDeps {
  readonly db: Database;
  readonly resolver: GroupResolver;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly now?: () => Date;
}

interface CapabilitySummary {
  readonly id: string;
  readonly layerId: string;
  readonly kind: 'tool' | 'skill' | 'agent';
  readonly name: string;
  readonly origin: string;
  readonly activatedAt: string;
  readonly deactivatedAt: string | null;
}

function summarize(row: LayerCapabilityRow): CapabilitySummary {
  return {
    id: row.id,
    layerId: row.layerId,
    kind: row.kind,
    name: row.name,
    origin: row.origin,
    activatedAt: row.activatedAt,
    deactivatedAt: row.deactivatedAt,
  };
}

export function registerLayerCapabilitiesRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: LayerCapabilitiesRouteDeps,
): void {
  const requireLayer = createRequireLayer();
  const clock = deps.now ?? ((): Date => new Date());
  const capabilitiesRepo = createLayerCapabilitiesRepo(deps.db);

  function computeIsSiteAdmin(userId: string): boolean {
    const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY);
    if (adminGroupId === null || adminGroupId === '') return false;
    return deps.resolver.isUserInGroup(userId, adminGroupId);
  }

  // ---------- GET /l/:slug/capabilities ----------------------------------

  app.get('/l/:slug/capabilities', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const rows = capabilitiesRepo.listActiveByLayer(layer.id);
    console.log('[capabilities.list.ok]', {
      event: 'capabilities.list.ok',
      layerId: layer.id,
      count: rows.length,
    });
    return c.json({ items: rows.map(summarize), total: rows.length });
  });

  // ---------- POST /l/:slug/capabilities/:id/deactivate ------------------

  app.post('/l/:slug/capabilities/:id/deactivate', requireLayer, async (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    const id = c.req.param('id');
    const row = capabilitiesRepo.getById(id);
    if (row === null || row.layerId !== layer.id) {
      return c.json(NOT_FOUND, 404);
    }
    // Permit empty bodies; reject malformed JSON.
    const contentType = c.req.header('content-type') ?? '';
    if (contentType.includes('application/json')) {
      let raw: unknown = {};
      try {
        raw = await c.req.json();
      } catch {
        const len = c.req.header('content-length');
        if (len !== undefined && len !== '0') return c.json(BAD_REQUEST, 400);
      }
      const parsed = EmptyBodySchema.safeParse(raw);
      if (!parsed.success) return c.json(BAD_REQUEST, 400);
    }
    const capabilityId = deps.capabilityRegistry.deactivate({
      layerId: layer.id,
      kind: row.kind,
      name: row.name,
      deactivatedBy: user.id,
      now: clock().toISOString(),
    });
    console.log('[capabilities.deactivate.ok]', {
      event: 'capabilities.deactivate.ok',
      layerId: layer.id,
      capabilityId: id,
      wasActive: capabilityId !== null,
    });
    return c.json({ status: 'deactivated' as const, capabilityId: id });
  });
}
