import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { GroupResolver } from '../auth/group-resolver';
import { createUsersRepo } from '../repos/users-repo';
import { createGroupsRepo } from '../repos/groups-repo';
import { createLayersRepo } from '../repos/layers-repo';
import { createLayerVisibilityRepo } from '../repos/layer-visibility-repo';
import { getMeta, setMeta } from '../storage/kv-meta';
import {
  LAYER_EVENT_TYPES,
  type LayerCreatedPayload,
  type LayerVisibilityAddedPayload,
} from './events';

/**
 * Phase 3.2 — idempotent layer seed.
 *
 * Runs at boot AFTER `seedAdminIfNeeded` (so the admin user + admin
 * group exist), AFTER the transitive group resolver is built (we need
 * it to enumerate each user's groups for the personal→group edges),
 * and BEFORE `Bun.serve` accepts requests.
 *
 * Idempotency is two-tier:
 *
 *  1. Fast path — `kv_meta.layers_seed_done = 'true'`. The first call
 *     on a fresh data-dir does the work; subsequent calls observe the
 *     marker and return.
 *  2. Correctness path — every insert is preceded by a slug / edge
 *     lookup. Re-running with the marker manually cleared still cannot
 *     duplicate a row. This protects against:
 *      - a partial first run that wrote some rows but crashed before
 *        the marker was set,
 *      - a data-dir that was migrated from a hand-rolled state.
 *
 * Bus events: one `layer.created` per inserted layer and one
 * `layer.visibility.added` per inserted edge. NO event when the row
 * already exists — re-running the seed must be observable as a no-op
 * by every subscriber (including the resolver invalidator in
 * `subscribers.ts`).
 *
 * Slug rules:
 *  - `everyone` (literal).
 *  - `personal-<username>` if the username matches `/^[a-z0-9_-]+$/`
 *    (lowercase a-z / 0-9 / dash / underscore — same character set the
 *    `groups.slug` UNIQUE COLLATE NOCASE column accepts via 0002).
 *    Otherwise `personal-<first-8-chars-of-userId-without-dashes>`,
 *    per `docs/dev/plans/done/phase-03-layers.md` §10 risk row "personal-
 *    layer collision when a username has special characters".
 *  - `group-<group.slug>` (group slugs are already validated upstream).
 */

export const LAYERS_SEED_DONE_KEY = 'layers_seed_done';

export const EVERYONE_LAYER_SLUG = 'everyone';
export const EVERYONE_LAYER_NAME = 'Everyone';

export interface SeedLayersDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  /** Required: the seed needs transitive groups for personal→group edges. */
  readonly transitiveGroups: GroupResolver;
  readonly now?: Date;
}

export interface SeedLayersResult {
  readonly seeded: boolean;
  readonly everyoneLayerId: string;
  /** New rows inserted on this call (zero on a fast-path no-op). */
  readonly created: {
    readonly layers: number;
    readonly visibilityEdges: number;
  };
}

const VALID_SLUG_LOCAL_PART = /^[a-z0-9_-]+$/;

/** Exported so the unit test can assert the fallback rule directly. */
export function personalLayerSlugFor(username: string, userId: string): string {
  const local = username.toLowerCase();
  if (VALID_SLUG_LOCAL_PART.test(local)) {
    return `personal-${local}`;
  }
  // UUIDs are 8-4-4-4-12 with dashes; strip dashes and take the leading
  // 8 hex chars. Collisions are astronomically unlikely at the seed
  // scale, and the column's UNIQUE constraint catches them if they ever
  // do happen.
  const compactId = userId.replaceAll('-', '');
  return `personal-${compactId.slice(0, 8)}`;
}

export async function seedLayersIfNeeded(deps: SeedLayersDeps): Promise<SeedLayersResult> {
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();

  const usersRepo = createUsersRepo(deps.db);
  const groupsRepo = createGroupsRepo(deps.db);
  const layersRepo = createLayersRepo(deps.db);
  const visibilityRepo = createLayerVisibilityRepo(deps.db);

  let createdLayers = 0;
  let createdEdges = 0;

  // -------- helpers (use the correctness path under the fast path) --------

  /**
   * Inserts a layer when no row with the given slug exists. Returns the
   * layer's id either way so callers can wire visibility edges without
   * caring whether the row pre-existed.
   *
   * Emits `layer.created` ONLY when an insert actually happened.
   */
  async function ensureLayer(input: {
    type: 'personal' | 'project' | 'group' | 'everyone';
    slug: string;
    name: string;
    ownerUserId?: string | null;
    ownerGroupId?: string | null;
  }): Promise<string> {
    const existing = layersRepo.getLayerBySlug(input.slug);
    if (existing !== null) {
      return existing.id;
    }
    const id = crypto.randomUUID();
    layersRepo.insertLayer({
      id,
      type: input.type,
      slug: input.slug,
      name: input.name,
      ownerUserId: input.ownerUserId ?? null,
      ownerGroupId: input.ownerGroupId ?? null,
      now: nowIso,
    });
    createdLayers++;
    const payload: LayerCreatedPayload = {
      layerId: id,
      type: input.type,
      slug: input.slug,
      name: input.name,
      ownerUserId: input.ownerUserId ?? null,
      ownerGroupId: input.ownerGroupId ?? null,
      seeded: true,
    };
    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.Created,
      payload,
      correlationId: crypto.randomUUID(),
    });
    return id;
  }

  /**
   * Adds a `bottom_up` visibility edge if it's not already present.
   * `listEdgesForChild` is cheap (indexed) and we only call it during
   * boot, so the per-row check is fine.
   */
  async function ensureBottomUpEdge(childLayerId: string, parentLayerId: string): Promise<void> {
    if (childLayerId === parentLayerId) return;
    const edges = visibilityRepo.listEdgesForChild(childLayerId);
    if (edges.some((e) => e.parentLayerId === parentLayerId)) {
      return;
    }
    visibilityRepo.addEdge({
      parentLayerId,
      childLayerId,
      direction: 'bottom_up',
      now: nowIso,
    });
    createdEdges++;
    const payload: LayerVisibilityAddedPayload = {
      parentLayerId,
      childLayerId,
      direction: 'bottom_up',
      seeded: true,
    };
    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.VisibilityAdded,
      payload,
      correlationId: crypto.randomUUID(),
    });
  }

  // ---------------------- fast-path early return -------------------------

  const done = getMeta(deps.db, LAYERS_SEED_DONE_KEY);
  if (done === 'true') {
    const everyone = layersRepo.getLayerBySlug(EVERYONE_LAYER_SLUG);
    return {
      seeded: false,
      everyoneLayerId: everyone?.id ?? '',
      created: { layers: 0, visibilityEdges: 0 },
    };
  }

  // ---------------------- 1. everyone layer ------------------------------

  const everyoneId = await ensureLayer({
    type: 'everyone',
    slug: EVERYONE_LAYER_SLUG,
    name: EVERYONE_LAYER_NAME,
  });

  // ---------------------- 2. group layers (before personal) --------------
  //
  // Personal layers reference group layers via `bottom_up` edges; seed
  // groups first so the edge target ids exist.

  const groupLayerIdByGroupId = new Map<string, string>();
  for (const group of groupsRepo.listGroups()) {
    if (group.deletedAt !== null) continue;
    const layerId = await ensureLayer({
      type: 'group',
      slug: `group-${group.slug}`,
      name: `Group — ${group.name}`,
      ownerGroupId: group.id,
    });
    groupLayerIdByGroupId.set(group.id, layerId);
    await ensureBottomUpEdge(layerId, everyoneId);
  }

  // ---------------------- 3. personal layers -----------------------------

  for (const user of usersRepo.listUsers()) {
    if (user.deletedAt !== null) continue;
    const slug = personalLayerSlugFor(user.username, user.id);
    const layerId = await ensureLayer({
      type: 'personal',
      slug,
      name: `Personal — ${user.displayName}`,
      ownerUserId: user.id,
    });
    await ensureBottomUpEdge(layerId, everyoneId);
    // Edge to every group layer the user is in transitively.
    for (const groupId of deps.transitiveGroups.expandUserGroups(user.id)) {
      const groupLayerId = groupLayerIdByGroupId.get(groupId);
      if (groupLayerId === undefined) continue;
      await ensureBottomUpEdge(layerId, groupLayerId);
    }
  }

  // ---------------------- 4. marker --------------------------------------

  setMeta(deps.db, LAYERS_SEED_DONE_KEY, 'true', nowIso);

  return {
    seeded: true,
    everyoneLayerId: everyoneId,
    created: { layers: createdLayers, visibilityEdges: createdEdges },
  };
}
