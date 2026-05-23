import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { EntityRef } from '@bunny2/shared';
import { createRequireLayer } from '../http/middleware/layer';
import type { HonoVariables } from '../http/types';
import type { EntityModule } from './module';
import type { EntityStore } from './store';

/**
 * Phase 4.0 — generic per-kind HTTP router factory.
 *
 * Each per-kind sub-phase (4a..4d) calls `mountEntityRoutes(app, { ... })`
 * once at boot. The factory produces:
 *
 *   GET    /l/:slug/<kind>            — list summaries (layer-scoped)
 *   POST   /l/:slug/<kind>            — create
 *   GET    /l/:slug/<kind>/:entitySlug
 *   PATCH  /l/:slug/<kind>/:entitySlug
 *   DELETE /l/:slug/<kind>/:entitySlug                 (soft-delete)
 *   POST   /l/:slug/<kind>/:entitySlug/restore
 *   POST   /l/:slug/<kind>/:entitySlug/external-links
 *   DELETE /l/:slug/<kind>/:entitySlug/external-links/:linkId
 *
 * All routes:
 *  - sit behind the same middleware chain as `/layers/*` (requireAuth →
 *    requirePasswordCurrent → withEffectiveLayers → requireLayer);
 *  - return `404 errors.layer.notVisible` for any layer the caller
 *    cannot see (mirrors the phase-3 contract — see ADR 0010);
 *  - return `404 errors.entity.notFound` when the entity is missing OR
 *    lives in a different layer (no cross-layer existence probe);
 *  - return localized error keys ONLY — never English sentences (see
 *    `AGENTS.md §Errors`).
 *
 * 4.0 ships this factory but does NOT call it (no concrete kind exists).
 * Per-kind sub-phases (4a.1, 4b.1, ...) import this and register their
 * own module + store.
 */

const ENTITY_NOT_FOUND = { error: 'errors.entity.notFound' } as const;
const ENTITY_NOT_IN_LAYER = { error: 'errors.entity.notInLayer' } as const;
const ENTITY_SLUG_TAKEN = { error: 'errors.entity.slugTaken' } as const;
const ENTITY_VALIDATION = { error: 'errors.entity.validation' } as const;
const BAD_REQUEST = { error: 'errors.layer.badRequest' } as const;
const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;

export interface MountEntityRoutesDeps<Payload> {
  readonly module: EntityModule<Payload>;
  readonly store: EntityStore<Payload>;
  readonly bus: MessageBus;
  readonly db: Database;
  readonly now?: () => Date;
}

export function mountEntityRoutes<Payload>(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountEntityRoutesDeps<Payload>,
): void {
  const { module, store } = deps;
  const requireLayer = createRequireLayer();
  const base = `/l/:slug/${module.kind}`;

  // ---------- GET /l/:slug/<kind> ----------------------------------------

  app.get(base, requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const includeDeleted = c.req.query('includeDeleted') === 'true';
    const limit = parseIntOrNull(c.req.query('limit'));
    const offset = parseIntOrNull(c.req.query('offset'));
    const summaries = store.listSummaries([layer.id], {
      includeDeleted,
      ...(limit === null ? {} : { limit }),
      ...(offset === null ? {} : { offset }),
    });
    return c.json({ entities: summaries });
  });

  // ---------- POST /l/:slug/<kind> ---------------------------------------

  app.post(base, requireLayer, async (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const user = c.get('user');

    let body: { title?: unknown; slug?: unknown; payload?: unknown; originalLocale?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(BAD_REQUEST, 400);
    }

    if (typeof body.title !== 'string' || body.title === '') {
      return c.json(ENTITY_VALIDATION, 400);
    }
    if (typeof body.originalLocale !== 'string' || body.originalLocale === '') {
      return c.json(ENTITY_VALIDATION, 400);
    }
    const parsed = module.payloadSchema.safeParse(body.payload);
    if (!parsed.success) {
      return c.json(ENTITY_VALIDATION, 400);
    }
    const requestedSlug = typeof body.slug === 'string' && body.slug !== '' ? body.slug : undefined;

    if (requestedSlug !== undefined && store.getBySlug(layer.id, requestedSlug) !== null) {
      return c.json(ENTITY_SLUG_TAKEN, 409);
    }

    try {
      const created = await store.create({
        layerId: layer.id,
        ...(requestedSlug === undefined ? {} : { slug: requestedSlug }),
        title: body.title,
        originalLocale: body.originalLocale,
        payload: parsed.data,
        actorId: user.id,
      });
      return c.json({ entity: created }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('unique')) {
        return c.json(ENTITY_SLUG_TAKEN, 409);
      }
      console.error(`[entities/${module.kind}] create failed:`, err);
      return c.json(ENTITY_VALIDATION, 400);
    }
  });

  // ---------- GET /l/:slug/<kind>/:entitySlug ----------------------------

  app.get(`${base}/:entitySlug`, requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const entitySlug = c.req.param('entitySlug');
    const entity = store.getBySlug(layer.id, entitySlug);
    if (entity === null || entity.layerId !== layer.id) {
      return c.json(ENTITY_NOT_FOUND, 404);
    }
    return c.json({ entity });
  });

  // ---------- PATCH /l/:slug/<kind>/:entitySlug --------------------------

  app.patch(`${base}/:entitySlug`, requireLayer, async (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const user = c.get('user');
    const entitySlug = c.req.param('entitySlug');
    const existing = store.getBySlug(layer.id, entitySlug);
    if (existing === null) {
      return c.json(ENTITY_NOT_FOUND, 404);
    }
    if (existing.layerId !== layer.id) {
      return c.json(ENTITY_NOT_IN_LAYER, 404);
    }

    let body: { title?: unknown; payload?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = module.payloadSchema.safeParse(body.payload);
    if (!parsed.success) {
      return c.json(ENTITY_VALIDATION, 400);
    }
    const title = typeof body.title === 'string' && body.title !== '' ? body.title : undefined;
    const updated = await store.update({
      id: existing.id,
      ...(title === undefined ? {} : { title }),
      payload: parsed.data,
      actorId: user.id,
    });
    return c.json({ entity: updated });
  });

  // ---------- DELETE /l/:slug/<kind>/:entitySlug -------------------------

  app.delete(`${base}/:entitySlug`, requireLayer, async (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const user = c.get('user');
    const entitySlug = c.req.param('entitySlug');
    const existing = store.getBySlug(layer.id, entitySlug);
    if (existing === null || existing.layerId !== layer.id) {
      return c.json(ENTITY_NOT_FOUND, 404);
    }
    await store.softDelete({ id: existing.id, actorId: user.id });
    return c.json({ ok: true });
  });

  // ---------- POST /l/:slug/<kind>/:entitySlug/restore -------------------

  app.post(`${base}/:entitySlug/restore`, requireLayer, async (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const user = c.get('user');
    const entitySlug = c.req.param('entitySlug');
    const existing = store.getBySlug(layer.id, entitySlug);
    if (existing === null || existing.layerId !== layer.id) {
      return c.json(ENTITY_NOT_FOUND, 404);
    }
    const restored = await store.restore({ id: existing.id, actorId: user.id });
    return c.json({ entity: restored });
  });

  // ---------- POST /l/:slug/<kind>/:entitySlug/external-links ------------

  app.post(`${base}/:entitySlug/external-links`, requireLayer, async (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const entitySlug = c.req.param('entitySlug');
    const existing = store.getBySlug(layer.id, entitySlug);
    if (existing === null || existing.layerId !== layer.id) {
      return c.json(ENTITY_NOT_FOUND, 404);
    }
    let body: { connector?: unknown; externalId?: unknown; payload?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    if (
      typeof body.connector !== 'string' ||
      body.connector === '' ||
      typeof body.externalId !== 'string' ||
      body.externalId === ''
    ) {
      return c.json(ENTITY_VALIDATION, 400);
    }
    const payload =
      body.payload !== undefined && body.payload !== null && typeof body.payload === 'object'
        ? (body.payload as Record<string, unknown>)
        : undefined;
    const ref: EntityRef = {
      id: existing.id,
      kind: module.kind,
      layerId: existing.layerId,
      slug: existing.slug,
    };
    try {
      const link = store.addExternalLink({
        ref,
        connector: body.connector,
        externalId: body.externalId,
        ...(payload === undefined ? {} : { payload }),
      });
      return c.json({ externalLink: link }, 201);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('unique')) {
        return c.json({ error: 'errors.entity.syncFailed' }, 409);
      }
      console.error(`[entities/${module.kind}] addExternalLink failed:`, err);
      return c.json(ENTITY_VALIDATION, 400);
    }
  });

  // ---------- DELETE /l/:slug/<kind>/:entitySlug/external-links/:linkId --

  app.delete(`${base}/:entitySlug/external-links/:linkId`, requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const entitySlug = c.req.param('entitySlug');
    const existing = store.getBySlug(layer.id, entitySlug);
    if (existing === null || existing.layerId !== layer.id) {
      return c.json(ENTITY_NOT_FOUND, 404);
    }
    const linkId = c.req.param('linkId');
    const present = existing.externalLinks.some((l) => l.id === linkId);
    if (!present) {
      return c.json(ENTITY_NOT_FOUND, 404);
    }
    store.removeExternalLink(linkId);
    return c.json({ ok: true });
  });
}

function parseIntOrNull(raw: string | undefined): number | null {
  if (raw === undefined || raw === '') return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}
