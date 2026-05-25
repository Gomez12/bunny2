import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import {
  AddLayerMemberRequestSchema,
  AddLayerVisibilityRequestSchema,
  CreateLayerRequestSchema,
  RegisterLayerAttachmentRequestSchema,
  SetLayerLocalesRequestSchema,
  UpdateLayerRequestSchema,
  type LayerType,
} from '@bunny2/shared';
import type { LocalesConfig } from '../../config/schema';
import type { GroupResolver } from '../../auth/group-resolver';
import { ADMIN_GROUP_ID_KEY } from '../../auth/seed';
import { getMeta } from '../../storage/kv-meta';
import { createLayersRepo, type Layer } from '../../repos/layers-repo';
import {
  createLayerVisibilityRepo,
  type LayerVisibilityRepo,
} from '../../repos/layer-visibility-repo';
import { createLayerMembersRepo } from '../../repos/layer-members-repo';
import { createLayerLocalesRepo } from '../../repos/layer-locales-repo';
import { createLayerAttachmentsRepo } from '../../repos/layer-attachments-repo';
import { createUsersRepo } from '../../repos/users-repo';
import { createGroupsRepo } from '../../repos/groups-repo';
import { canEditLayer } from '../../layers/authz';
import { LAYER_EVENT_TYPES } from '../../layers/events';
import { createRequireLayer } from '../middleware/layer';
import type { LayerResolver } from '../../layers/resolver';
import type { HonoVariables } from '../types';

/**
 * Phase 3.4 — `/layers/*` routes.
 *
 * All routes here sit behind:
 *   - `requireAuth` (global, `router.ts`)
 *   - `requirePasswordCurrent` (global)
 *   - `withEffectiveLayers` (global; populates `c.var.effectiveLayers`)
 *
 * Per-route authorization is computed inline via `canEditLayer` per the
 * §4.4 table; there is NO router-level admin gate on `/layers/*`. The
 * "visibility 404 vs edit 403" asymmetry on `:slug` routes is deliberate:
 * a non-member sees 404 (they shouldn't be able to probe slug
 * existence); a member without edit rights sees 403.
 *
 * Cache invalidation runs via the existing `layer.*` bus subscriber
 * (`apps/server/src/layers/subscribers.ts`) — `bus.publish` awaits its
 * subscribers in the in-memory adapter, so by the time a route returns,
 * the resolver cache has been invalidated.
 */

const BAD_REQUEST = { error: 'errors.layer.badRequest' } as const;
const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;
const FORBIDDEN = { error: 'errors.layer.forbidden' } as const;
const NOT_DELETABLE = { error: 'errors.layer.notDeletable' } as const;
const TYPE_NOT_CREATABLE = { error: 'errors.layer.typeNotCreatable' } as const;
const SLUG_TAKEN = { error: 'errors.layer.slugTaken' } as const;
const MEMBERS_ON_PROJECT = { error: 'errors.layer.membersOnProject' } as const;
const ATTACHMENT_CONFIG_INVALID = { error: 'errors.layer.attachmentConfigInvalid' } as const;
const ATTACHMENT_ALREADY_REGISTERED = {
  error: 'errors.layer.attachmentAlreadyRegistered',
} as const;
const VISIBILITY_DIRECTION_NOT_SUPPORTED = {
  error: 'errors.layer.visibilityDirectionNotSupported',
} as const;
const VISIBILITY_CYCLE = { error: 'errors.layer.visibilityCycle' } as const;
/**
 * Phase 3.6 — collapsed "parent not visible" and "parent not found" into
 * a single `404 errors.layer.visibilityParentNotFound` response. The
 * previous separate `errors.layer.visibilityParentNotVisible` key let a
 * caller distinguish "slug exists somewhere in the system" from "slug
 * doesn't exist at all" by comparing error codes at the same 400 status
 * — a slug-existence probe. The §0 / §10 risks invariant (no slug-
 * existence leak; same shape as GitHub on a private repo) requires both
 * branches return byte-identical responses. ADR `0010` and the phase-3
 * close-out §14 record the decision.
 */
const VISIBILITY_PARENT_NOT_FOUND = {
  error: 'errors.layer.visibilityParentNotFound',
} as const;
const MEMBER_USER_NOT_FOUND = { error: 'errors.layer.memberUserNotFound' } as const;
const MEMBER_GROUP_NOT_FOUND = { error: 'errors.layer.memberGroupNotFound' } as const;
const MEMBER_NOT_FOUND = { error: 'errors.layer.memberNotFound' } as const;
const ATTACHMENT_NOT_FOUND = { error: 'errors.layer.attachmentNotFound' } as const;

/** Max chars of `config_json` allowed inside an emitted bus payload. */
const EVENT_CONFIG_PREVIEW_MAX = 500;

export interface LayersRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  readonly resolver: GroupResolver;
  readonly layerResolver: LayerResolver;
  readonly locales: LocalesConfig;
  readonly now?: () => Date;
}

export function registerLayersRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: LayersRouteDeps,
): void {
  const layersRepo = createLayersRepo(deps.db);
  const visibilityRepo = createLayerVisibilityRepo(deps.db);
  const membersRepo = createLayerMembersRepo(deps.db);
  const localesRepo = createLayerLocalesRepo(deps.db);
  const attachmentsRepo = createLayerAttachmentsRepo(deps.db);
  const usersRepo = createUsersRepo(deps.db);
  const groupsRepo = createGroupsRepo(deps.db);
  const clock = deps.now ?? (() => new Date());
  const requireLayer = createRequireLayer();

  /**
   * Lazily looks up `admin_group_id` once per request and resolves
   * "is the caller a transitive site-admin?" via the existing
   * `GroupResolver.isUserInGroup` path used by `requireAdmin`.
   */
  function computeIsSiteAdmin(userId: string): boolean {
    const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY);
    if (adminGroupId === null || adminGroupId === '') return false;
    return deps.resolver.isUserInGroup(userId, adminGroupId);
  }

  // ---------- GET /layers --------------------------------------------------

  app.get('/layers', (c) => {
    const user = c.get('user');
    const effective = c.get('effectiveLayers') ?? [];
    const typeParam = c.req.query('type');
    const search = c.req.query('search');
    const includeDeleted = c.req.query('includeDeleted') === 'true';

    let candidates: readonly Layer[];

    if (includeDeleted) {
      // Site-admin only sees soft-deleted layers; non-admins silently
      // get the same answer as `includeDeleted=false`. Returning 403
      // here would leak that the toggle exists at all.
      if (!computeIsSiteAdmin(user.id)) {
        candidates = effective;
      } else {
        candidates = layersRepo.listLayers({ includeDeleted: true });
      }
    } else {
      candidates = effective;
    }

    let filtered = candidates;
    if (typeParam !== undefined && typeParam !== '') {
      filtered = filtered.filter((l) => l.type === typeParam);
    }
    if (search !== undefined && search !== '') {
      const needle = search.toLowerCase();
      filtered = filtered.filter(
        (l) => l.slug.toLowerCase().includes(needle) || l.name.toLowerCase().includes(needle),
      );
    }
    return c.json({ layers: filtered });
  });

  // ---------- POST /layers -------------------------------------------------

  app.post('/layers', async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = CreateLayerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { type, slug, name, description } = parsed.data;

    if (type !== 'project') {
      return c.json(TYPE_NOT_CREATABLE, 400);
    }
    if (layersRepo.getLayerBySlug(slug) !== null) {
      return c.json(SLUG_TAKEN, 409);
    }

    const everyoneLayer = layersRepo.getLayerBySlug('everyone');
    const layerId = crypto.randomUUID();
    const nowIso = clock().toISOString();

    // All three writes (layer + owner row + bottom_up→everyone edge) land
    // atomically. We deliberately publish AFTER the tx commits — holding
    // the SQLite write lock across `bus.publish` would await every
    // subscriber under the lock, and the layer subscriber's broad
    // invalidate path doesn't need transactional visibility.
    const tx = deps.db.transaction(() => {
      layersRepo.insertLayer({
        id: layerId,
        type: 'project',
        slug,
        name,
        description: description ?? null,
        now: nowIso,
      });
      membersRepo.addUserMember({
        layerId,
        userId: user.id,
        role: 'owner',
        now: nowIso,
      });
      if (everyoneLayer !== null) {
        visibilityRepo.addEdge({
          parentLayerId: everyoneLayer.id,
          childLayerId: layerId,
          direction: 'bottom_up',
          now: nowIso,
        });
      }
    });
    tx();

    const created = layersRepo.getLayerById(layerId);
    if (created === null) {
      // Inserts that throw roll back the transaction; a missing row
      // here means a defect in the repo. Surface as 500 — but use the
      // generic shape to avoid leaking internals.
      return c.json({ error: 'errors.server.unavailable' }, 500);
    }

    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.Created,
      payload: {
        layerId,
        type: 'project',
        slug,
        name,
        ownerUserId: null,
        ownerGroupId: null,
      },
      correlationId,
    });
    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.MemberAdded,
      payload: {
        layerId,
        userId: user.id,
        kind: 'user',
        role: 'owner',
      },
      correlationId,
    });
    if (everyoneLayer !== null) {
      await deps.bus.publish({
        type: LAYER_EVENT_TYPES.VisibilityAdded,
        payload: {
          parentLayerId: everyoneLayer.id,
          childLayerId: layerId,
          direction: 'bottom_up',
        },
        correlationId,
      });
    }

    // Belt-and-suspenders: the `layer.*` subscriber already invalidated
    // the cache. We still invalidate the caller's entry inline so the
    // very next handler in the same process sees the new layer without
    // depending on subscriber ordering.
    deps.layerResolver.invalidate(user.id);

    return c.json({ layer: created }, 201);
  });

  // ---------- GET /layers/:slug -------------------------------------------

  app.get('/layers/:slug', requireLayer, (c) => {
    return c.json({ layer: c.get('layer') });
  });

  // ---------- PATCH /layers/:slug -----------------------------------------

  app.patch('/layers/:slug', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = UpdateLayerRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }

    const patch: { name?: string; description?: string | null } = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;

    const nowIso = clock().toISOString();
    const updated = layersRepo.updateLayer(layer.id, patch, nowIso);

    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.Updated,
      payload: { layerId: updated.id, slug: updated.slug },
      correlationId,
    });
    deps.layerResolver.invalidate();

    return c.json({ layer: updated });
  });

  // ---------- DELETE /layers/:slug ----------------------------------------

  app.delete('/layers/:slug', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    if (layer.type !== 'project') {
      return c.json(NOT_DELETABLE, 400);
    }

    layersRepo.softDeleteLayer(layer.id, clock().toISOString());

    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.Deleted,
      payload: {
        layerId: layer.id,
        slug: layer.slug,
        type: layer.type,
        ownerUserId: layer.ownerUserId,
        ownerGroupId: layer.ownerGroupId,
      },
      correlationId,
    });
    // Broad invalidate — any user that had the deleted layer in their
    // effective set must re-resolve on the next request. This is
    // belt-and-suspenders alongside the `layer.*` bus subscriber
    // (`apps/server/src/layers/subscribers.ts`); a test fixture that
    // doesn't register subscribers still gets the right answer.
    deps.layerResolver.invalidate();

    return c.json({ ok: true });
  });

  // ---------- POST /layers/:slug/members ----------------------------------

  app.post('/layers/:slug/members', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    if (layer.type !== 'project') {
      return c.json(MEMBERS_ON_PROJECT, 400);
    }
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = AddLayerMemberRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { userId, groupId, role } = parsed.data;
    const nowIso = clock().toISOString();

    if (userId !== undefined) {
      const target = usersRepo.findUserById(userId);
      if (target === null || target.deletedAt !== null) {
        return c.json(MEMBER_USER_NOT_FOUND, 404);
      }
      membersRepo.addUserMember({ layerId: layer.id, userId, role, now: nowIso });
      await deps.bus.publish({
        type: LAYER_EVENT_TYPES.MemberAdded,
        payload: { layerId: layer.id, userId, kind: 'user', role },
        correlationId,
      });
      deps.layerResolver.invalidate();
      return c.json({ ok: true }, 201);
    }

    if (groupId === undefined) {
      // XOR guarded by the schema; defensive branch.
      return c.json(BAD_REQUEST, 400);
    }
    const targetGroup = groupsRepo.findGroupById(groupId);
    if (targetGroup === null || targetGroup.deletedAt !== null) {
      return c.json(MEMBER_GROUP_NOT_FOUND, 404);
    }
    membersRepo.addGroupMember({ layerId: layer.id, groupId, role, now: nowIso });
    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.MemberAdded,
      payload: { layerId: layer.id, groupId, kind: 'group', role },
      correlationId,
    });
    deps.layerResolver.invalidate();
    return c.json({ ok: true }, 201);
  });

  // ---------- DELETE /layers/:slug/members/:memberId ----------------------

  app.delete('/layers/:slug/members/:memberId', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    if (layer.type !== 'project') {
      return c.json(MEMBERS_ON_PROJECT, 400);
    }
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }

    const memberId = c.req.param('memberId');

    // The `:memberId` may be either a user id or a group id. We resolve
    // both lookups; if a record matches both (shouldn't happen — UUIDs
    // don't collide across tables — but be defensive), prefer the user
    // branch per the plan.
    const isUser =
      membersRepo.listUserMembers(layer.id).some((m) => m.userId === memberId) === true;
    const isGroup =
      isUser === false &&
      membersRepo.listGroupMembers(layer.id).some((m) => m.groupId === memberId) === true;

    if (!isUser && !isGroup) {
      return c.json(MEMBER_NOT_FOUND, 404);
    }

    if (isUser) {
      membersRepo.removeUserMember(layer.id, memberId);
      await deps.bus.publish({
        type: LAYER_EVENT_TYPES.MemberRemoved,
        payload: { layerId: layer.id, userId: memberId, kind: 'user' },
        correlationId,
      });
    } else {
      membersRepo.removeGroupMember(layer.id, memberId);
      await deps.bus.publish({
        type: LAYER_EVENT_TYPES.MemberRemoved,
        payload: { layerId: layer.id, groupId: memberId, kind: 'group' },
        correlationId,
      });
    }
    deps.layerResolver.invalidate();
    return c.json({ ok: true });
  });

  // ---------- POST /layers/:slug/visibility -------------------------------

  app.post('/layers/:slug/visibility', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = AddLayerVisibilityRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { parentSlug, direction } = parsed.data;

    if (direction !== 'bottom_up') {
      // §11.6 — adding top_down / both needs a "parent owner accepts"
      // handshake we're not building in v1.
      return c.json(VISIBILITY_DIRECTION_NOT_SUPPORTED, 400);
    }

    const parent = layersRepo.getLayerBySlug(parentSlug);
    // 3.6: collapse "parent doesn't exist", "parent is soft-deleted",
    // and "parent exists but the caller can't see it" into the SAME
    // 404 response so the caller cannot probe slug existence. The two
    // branches must be byte-identical — that's the only invariant the
    // ADR `0010` 404-policy actually gives the caller.
    const effective = c.get('effectiveLayers') ?? [];
    if (
      parent === null ||
      parent.deletedAt !== null ||
      !effective.some((l) => l.id === parent.id)
    ) {
      return c.json(VISIBILITY_PARENT_NOT_FOUND, 404);
    }
    if (parent.id === layer.id) {
      return c.json(VISIBILITY_CYCLE, 400);
    }

    if (wouldCreateCycle(visibilityRepo, parent.id, layer.id)) {
      return c.json(VISIBILITY_CYCLE, 400);
    }

    const nowIso = clock().toISOString();
    try {
      visibilityRepo.addEdge({
        parentLayerId: parent.id,
        childLayerId: layer.id,
        direction: 'bottom_up',
        now: nowIso,
      });
    } catch (err) {
      // Repo rejects self-edges and the PK enforces uniqueness — both
      // map to "already-present-or-invalid", which is a no-op from the
      // route's perspective. We still log so a real bug surfaces.
      console.error('[layers] visibility addEdge failed:', err);
      return c.json(BAD_REQUEST, 400);
    }

    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.VisibilityAdded,
      payload: {
        parentLayerId: parent.id,
        childLayerId: layer.id,
        direction: 'bottom_up',
      },
      correlationId,
    });
    // Visibility flips can change effective sets for users we don't
    // know up front — kill the whole cache.
    deps.layerResolver.invalidate();
    return c.json({ ok: true }, 201);
  });

  // ---------- DELETE /layers/:slug/visibility/:parentSlug -----------------

  app.delete('/layers/:slug/visibility/:parentSlug', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }

    const parentSlug = c.req.param('parentSlug');
    const parent = layersRepo.getLayerBySlug(parentSlug);
    if (parent === null) {
      return c.json(VISIBILITY_PARENT_NOT_FOUND, 404);
    }
    visibilityRepo.removeEdge(parent.id, layer.id);
    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.VisibilityRemoved,
      payload: { parentLayerId: parent.id, childLayerId: layer.id },
      correlationId,
    });
    deps.layerResolver.invalidate();
    return c.json({ ok: true });
  });

  // ---------- POST /layers/:slug/locales ----------------------------------

  app.post('/layers/:slug/locales', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = SetLayerLocalesRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { locales, defaultLocale } = parsed.data;

    // Validate every requested locale against the system list.
    const supported = new Set(deps.locales.supported);
    for (const loc of locales) {
      if (!supported.has(loc)) {
        return c.json({ error: 'errors.layer.localeNotConfigured', locale: loc }, 400);
      }
    }
    if (defaultLocale !== undefined && !locales.includes(defaultLocale)) {
      return c.json({ error: 'errors.layer.defaultLocaleNotInSet' }, 400);
    }

    const nowIso = clock().toISOString();
    localesRepo.setLocales(layer.id, locales, defaultLocale ?? null, nowIso);

    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.LocaleSet,
      payload: {
        layerId: layer.id,
        locales,
        defaultLocale: defaultLocale ?? null,
      },
      correlationId,
    });
    return c.json({ ok: true, locales: localesRepo.listLocales(layer.id) });
  });

  // ---------- GET /layers/:slug/attachments -------------------------------

  /**
   * List attachments for a layer. Any visible member can read — the
   * Attachments tab needs to render on mount and after every
   * register / remove so the list survives a page reload. Authz is
   * delegated to `requireLayer` (404 leak shape matches `/layers/:slug`).
   * Sibling shape recommended by `docs/dev/follow-ups/done/
   * layer-attachments-on-get.md` over nesting into the detail route
   * so each tab fetches what it needs independently.
   */
  app.get('/layers/:slug/attachments', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const attachments = attachmentsRepo.listAttachments(layer.id);
    return c.json({ attachments });
  });

  // ---------- POST /layers/:slug/attachments ------------------------------

  app.post('/layers/:slug/attachments', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = RegisterLayerAttachmentRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { kind, refId, config } = parsed.data;

    // `config` is typed as `unknown` in the shared schema (see
    // `RegisterLayerAttachmentRequestSchema` JSDoc): the route owns the
    // "must be a JSON object" rule. Arrays, scalars, and `null` are
    // rejected with `errors.layer.attachmentConfigInvalid` — this is
    // the resolution of the 3.1 open question about silently-coerced
    // configs (a permissive `z.unknown()` would have stored `42` as the
    // attachment config, which the repo then de-coerces to `{}` on
    // read — silently dropping data).
    let configRecord: Record<string, unknown> = {};
    if (config !== undefined) {
      if (config === null || Array.isArray(config) || typeof config !== 'object') {
        return c.json(ATTACHMENT_CONFIG_INVALID, 400);
      }
      configRecord = config as Record<string, unknown>;
    }

    const id = crypto.randomUUID();
    const nowIso = clock().toISOString();
    let created;
    try {
      created = attachmentsRepo.insertAttachment({
        id,
        layerId: layer.id,
        kind,
        refId,
        config: configRecord,
        now: nowIso,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.toLowerCase().includes('unique')) {
        return c.json(ATTACHMENT_ALREADY_REGISTERED, 409);
      }
      console.error('[layers] insertAttachment failed:', err);
      return c.json(BAD_REQUEST, 400);
    }

    const configPreview = truncateJson(created.config, EVENT_CONFIG_PREVIEW_MAX);
    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.AttachmentRegistered,
      payload: {
        layerId: layer.id,
        attachmentId: created.id,
        kind: created.kind,
        refId: created.refId,
        configPreview,
      },
      correlationId,
    });
    return c.json({ attachment: created }, 201);
  });

  // ---------- DELETE /layers/:slug/attachments/:id ------------------------

  app.delete('/layers/:slug/attachments/:id', requireLayer, async (c) => {
    const correlationId = crypto.randomUUID();
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }

    const id = c.req.param('id');
    const attachments = attachmentsRepo.listAttachments(layer.id);
    const found = attachments.find((a) => a.id === id);
    if (found === undefined) {
      // Don't leak existence across layers — 404 whether the id is
      // unknown OR belongs to another layer.
      return c.json(ATTACHMENT_NOT_FOUND, 404);
    }
    attachmentsRepo.removeAttachment(id);
    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.AttachmentRemoved,
      payload: { layerId: layer.id, attachmentId: id, kind: found.kind, refId: found.refId },
      correlationId,
    });
    return c.json({ ok: true });
  });
}

// ---------------------------------------------------------------------------

/**
 * Returns `true` iff inserting a `bottom_up` edge from `child → parent`
 * would close a cycle. The visibility graph is a DAG of "child sees
 * parent" edges; a cycle exists when `parent` can already reach `child`
 * by walking edges in the same direction (parent has its own parents,
 * etc.). We BFS upward from the proposed parent and reject if we hit
 * the child.
 *
 * Mirrors the shape of `resolver.ts` `walkEdges` but only follows
 * bottom_up / both edges in the parent-direction — same predicate the
 * resolver uses for reachability.
 */
function wouldCreateCycle(
  visibility: LayerVisibilityRepo,
  parentId: string,
  childId: string,
): boolean {
  if (parentId === childId) return true;
  const seen = new Set<string>([parentId]);
  let frontier = [parentId];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const edge of visibility.listEdgesForChild(id)) {
        if (edge.direction !== 'bottom_up' && edge.direction !== 'both') continue;
        if (edge.parentLayerId === childId) return true;
        if (!seen.has(edge.parentLayerId)) {
          seen.add(edge.parentLayerId);
          next.push(edge.parentLayerId);
        }
      }
    }
    frontier = next;
  }
  return false;
}

function truncateJson(value: unknown, max: number): string {
  const json = JSON.stringify(value);
  if (json === undefined) return '';
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

// Avoid TS "imported but only used as type" warnings on LayerType.
export type { LayerType };
