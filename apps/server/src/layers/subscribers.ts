import type { Database } from 'bun:sqlite';
import type { BusEvent, MessageBus, Unsubscribe } from '@bunny2/bus';
import type { GroupResolver } from '../auth/group-resolver';
import type { LayerResolver } from './resolver';
import { createUsersRepo } from '../repos/users-repo';
import { createGroupsRepo } from '../repos/groups-repo';
import { createLayersRepo } from '../repos/layers-repo';
import { createLayerVisibilityRepo } from '../repos/layer-visibility-repo';
import {
  ALL_LAYER_EVENT_TYPES,
  LAYER_EVENT_TYPES,
  type LayerCreatedPayload,
  type LayerVisibilityAddedPayload,
} from './events';
import { personalLayerSlugFor, EVERYONE_LAYER_SLUG } from './seed';

/**
 * Phase 3.2 — bus subscribers wiring the layer model to user/group/layer
 * mutations.
 *
 * Mirrors the existing phase-2 wiring convention (the group resolver
 * subscribes to user/group events at construction time) — subscriptions
 * are registered once at boot and live for the process lifetime. The
 * factory returns an `Unsubscribe[]` so tests can tear down between
 * fixtures; production discards it.
 *
 * Side-effects per event:
 *
 *  - `user.created`   → seed the user's personal layer + bottom_up edge
 *                       to `everyone`, broad invalidate.
 *  - `user.deleted`   → soft-delete the user's personal layer,
 *                       invalidate(userId).
 *  - `group.created`  → seed the group layer + bottom_up edge to
 *                       `everyone`, broad invalidate.
 *  - `group.deleted`  → soft-delete the group layer, broad invalidate.
 *  - `group.member_added` / `group.member_removed`:
 *        kind === 'user'  → invalidate(affectedUserId).
 *        kind === 'group' → broad invalidate (the affected branch can
 *                           reach many users; enumerating is cheaper
 *                           than re-resolving every user, but a broad
 *                           invalidate is cheapest in practice and
 *                           layers change rarely).
 *  - `layer.*`        → broad invalidate (layers change rarely; cheap).
 *
 * The handlers swallow errors — a subscriber that throws should not
 * crash the boot. They DO log to stderr via `console.error` so a
 * misconfigured wiring is observable in tests.
 */

export interface RegisterLayerSubscribersDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  /** The same resolver that `c.var.effectiveLayers` reads in 3.3. */
  readonly resolver: LayerResolver;
  /** Used for personal→group edges on `user.created`. */
  readonly transitiveGroups: GroupResolver;
  readonly now?: () => Date;
}

interface UserCreatedPayload {
  userId: string;
  username: string;
}
interface UserDeletedPayload {
  userId: string;
}
interface GroupCreatedPayload {
  groupId: string;
  slug: string;
  name: string;
}
interface GroupDeletedPayload {
  groupId: string;
}
interface GroupMemberAddedRemovedPayload {
  groupId: string;
  kind: 'user' | 'group';
  userId?: string;
  childGroupId?: string;
}

export function registerLayerSubscribers(deps: RegisterLayerSubscribersDeps): Unsubscribe[] {
  const now = deps.now ?? (() => new Date());
  const usersRepo = createUsersRepo(deps.db);
  const groupsRepo = createGroupsRepo(deps.db);
  const layersRepo = createLayersRepo(deps.db);
  const visibilityRepo = createLayerVisibilityRepo(deps.db);

  function everyoneLayerId(): string | null {
    return layersRepo.getLayerBySlug(EVERYONE_LAYER_SLUG)?.id ?? null;
  }

  async function publishLayerCreated(payload: LayerCreatedPayload): Promise<void> {
    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.Created,
      payload,
      correlationId: crypto.randomUUID(),
    });
  }

  async function publishVisibilityAdded(payload: LayerVisibilityAddedPayload): Promise<void> {
    await deps.bus.publish({
      type: LAYER_EVENT_TYPES.VisibilityAdded,
      payload,
      correlationId: crypto.randomUUID(),
    });
  }

  async function ensurePersonalLayer(userId: string, username: string): Promise<void> {
    const user = usersRepo.findUserById(userId);
    if (user === null || user.deletedAt !== null) return;
    const slug = personalLayerSlugFor(username, userId);
    if (layersRepo.getLayerBySlug(slug) !== null) return;
    const id = crypto.randomUUID();
    const nowIso = now().toISOString();
    layersRepo.insertLayer({
      id,
      type: 'personal',
      slug,
      name: `Personal — ${user.displayName}`,
      ownerUserId: userId,
      now: nowIso,
    });
    await publishLayerCreated({
      layerId: id,
      type: 'personal',
      slug,
      name: `Personal — ${user.displayName}`,
      ownerUserId: userId,
      ownerGroupId: null,
    });
    const everyoneId = everyoneLayerId();
    if (everyoneId !== null) {
      const edges = visibilityRepo.listEdgesForChild(id);
      if (!edges.some((e) => e.parentLayerId === everyoneId)) {
        visibilityRepo.addEdge({
          parentLayerId: everyoneId,
          childLayerId: id,
          direction: 'bottom_up',
          now: nowIso,
        });
        await publishVisibilityAdded({
          parentLayerId: everyoneId,
          childLayerId: id,
          direction: 'bottom_up',
        });
      }
    }
  }

  async function ensureGroupLayer(groupId: string, slug: string, name: string): Promise<void> {
    const group = groupsRepo.findGroupById(groupId);
    if (group === null || group.deletedAt !== null) return;
    const layerSlug = `group-${slug}`;
    if (layersRepo.getLayerBySlug(layerSlug) !== null) return;
    const id = crypto.randomUUID();
    const nowIso = now().toISOString();
    layersRepo.insertLayer({
      id,
      type: 'group',
      slug: layerSlug,
      name: `Group — ${name}`,
      ownerGroupId: groupId,
      now: nowIso,
    });
    await publishLayerCreated({
      layerId: id,
      type: 'group',
      slug: layerSlug,
      name: `Group — ${name}`,
      ownerGroupId: groupId,
      ownerUserId: null,
    });
    const everyoneId = everyoneLayerId();
    if (everyoneId !== null) {
      const edges = visibilityRepo.listEdgesForChild(id);
      if (!edges.some((e) => e.parentLayerId === everyoneId)) {
        visibilityRepo.addEdge({
          parentLayerId: everyoneId,
          childLayerId: id,
          direction: 'bottom_up',
          now: nowIso,
        });
        await publishVisibilityAdded({
          parentLayerId: everyoneId,
          childLayerId: id,
          direction: 'bottom_up',
        });
      }
    }
  }

  function softDeletePersonalLayerFor(userId: string): void {
    // The user row may already be soft-deleted; still look for the
    // matching personal layer by `owner_user_id`.
    const row = deps.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM layers
          WHERE type = 'personal' AND owner_user_id = ? AND deleted_at IS NULL`,
      )
      .get(userId);
    if (row === null) return;
    layersRepo.softDeleteLayer(row.id, now().toISOString());
  }

  function softDeleteGroupLayerFor(groupId: string): void {
    const row = deps.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM layers
          WHERE type = 'group' AND owner_group_id = ? AND deleted_at IS NULL`,
      )
      .get(groupId);
    if (row === null) return;
    layersRepo.softDeleteLayer(row.id, now().toISOString());
  }

  function safe<T>(label: string, fn: () => Promise<T> | T): Promise<void> {
    return Promise.resolve()
      .then(fn)
      .then(() => undefined)
      .catch((err: unknown) => {
        console.error(`[layers/subscribers] ${label} failed:`, err);
      });
  }

  const unsubs: Unsubscribe[] = [];

  unsubs.push(
    deps.bus.subscribe<UserCreatedPayload>(
      'user.created',
      async (e: BusEvent<UserCreatedPayload>) => {
        await safe('user.created', async () => {
          await ensurePersonalLayer(e.payload.userId, e.payload.username);
          deps.resolver.invalidate();
        });
      },
    ),
  );

  unsubs.push(
    deps.bus.subscribe<UserDeletedPayload>('user.deleted', (e: BusEvent<UserDeletedPayload>) => {
      void safe('user.deleted', () => {
        softDeletePersonalLayerFor(e.payload.userId);
        deps.resolver.invalidate(e.payload.userId);
      });
    }),
  );

  unsubs.push(
    deps.bus.subscribe<GroupCreatedPayload>(
      'group.created',
      async (e: BusEvent<GroupCreatedPayload>) => {
        await safe('group.created', async () => {
          await ensureGroupLayer(e.payload.groupId, e.payload.slug, e.payload.name);
          deps.resolver.invalidate();
        });
      },
    ),
  );

  unsubs.push(
    deps.bus.subscribe<GroupDeletedPayload>('group.deleted', (e: BusEvent<GroupDeletedPayload>) => {
      void safe('group.deleted', () => {
        softDeleteGroupLayerFor(e.payload.groupId);
        deps.resolver.invalidate();
      });
    }),
  );

  const onMembership = (e: BusEvent<GroupMemberAddedRemovedPayload>) => {
    void safe('group.member_*', () => {
      if (e.payload.kind === 'user' && e.payload.userId !== undefined) {
        deps.resolver.invalidate(e.payload.userId);
        return;
      }
      // group-in-group: enumerate every user transitively reachable
      // through the affected child branch and invalidate per-user, per
      // §4.5. The phase-2 transitive resolver's `expandGroupMembers`
      // walks downward from the seed group and collects every user in
      // the branch — exactly the set whose effective-layer-set may have
      // changed.
      if (e.payload.childGroupId === undefined) return;
      const expansion = deps.transitiveGroups.expandGroupMembers(e.payload.childGroupId);
      for (const userId of expansion.userIds) {
        deps.resolver.invalidate(userId);
      }
    });
  };
  unsubs.push(
    deps.bus.subscribe<GroupMemberAddedRemovedPayload>('group.member_added', onMembership),
  );
  unsubs.push(
    deps.bus.subscribe<GroupMemberAddedRemovedPayload>('group.member_removed', onMembership),
  );

  for (const type of ALL_LAYER_EVENT_TYPES) {
    unsubs.push(
      deps.bus.subscribe(type, () => {
        deps.resolver.invalidate();
      }),
    );
  }

  return unsubs;
}
