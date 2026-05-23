import type { Database } from 'bun:sqlite';
import type { GroupResolver } from '../auth/group-resolver';
import type { Layer } from '../repos/layers-repo';
import { createLayerVisibilityRepo } from '../repos/layer-visibility-repo';
import { createLayerMembersRepo } from '../repos/layer-members-repo';

/**
 * Phase 3.2 — effective-layer-set resolver.
 *
 * Given a `userId`, returns the deduped, sorted, frozen set of `Layer`
 * rows the user can see according to:
 *
 *  1. The user's personal layer (slug `personal-<…>`).
 *  2. Every group layer for a group the user is in transitively (via
 *     the phase-2 `GroupResolver`).
 *  3. The `everyone` layer.
 *  4. Every project layer where the user is a direct `layer_user_members`
 *     member, OR where one of the user's transitive groups is a direct
 *     `layer_group_members` member.
 *  5. Following `layer_visibility_edges`:
 *      - `bottom_up`: a child→parent edge ADDS the parent when the child
 *        is reachable (the child "sees" everything above it, per
 *        `overall.md` §5.4).
 *      - `top_down`: a child→parent edge ADDS the child when the parent
 *        is reachable.
 *      - `both`: both directions count.
 *
 * Soft-deleted layers (`deleted_at IS NOT NULL`) are filtered out — the
 * resolver is the authoritative answer to "which layers may this user
 * see right now?", and any phase-4+ consumer (e.g. the LanceDB filter in
 * phase 6) inherits that filter for free.
 *
 * Cache: in-process LRU keyed on `userId`, defaulting to 5 min TTL and
 * 5000 entries (mirrors `auth/group-resolver.ts`). The cache is
 * intentionally small — a missed bus invalidation cannot stick forever
 * because of the TTL bound, and the resolver only runs once per request
 * (`c.var.effectiveLayers` enrichment lands in 3.3).
 *
 * Constructed via the `createLayerResolver` factory so tests can swap
 * the `db` and `transitiveGroups` deps; phase-2 patterns do the same.
 */

export interface LayerResolver {
  /**
   * Returns a frozen, sorted, deduped array of `Layer` rows visible to
   * `userId`. Same array reference is returned for a cache hit; tests
   * lean on this to assert invalidation.
   */
  effectiveLayers(userId: string): Promise<readonly Layer[]>;
  /**
   * Drops the cached set for `userId`, or — when called with no
   * argument — every cached set. No-op if the key is missing.
   */
  invalidate(userId?: string): void;
}

export interface CreateLayerResolverDeps {
  readonly db: Database;
  readonly transitiveGroups: GroupResolver;
  /** Override for tests; default is `Date.now`. */
  readonly clock?: () => number;
  /** Cache TTL in milliseconds. Default 5 min. */
  readonly ttlMs?: number;
  /** Cache cap. Default 5000 entries. */
  readonly max?: number;
}

const CACHE_TTL_MS_DEFAULT = 5 * 60_000;
const CACHE_CAP_DEFAULT = 5000;

/**
 * Tiny insertion-order LRU with per-entry TTL. Re-implements the
 * `LruCache` in `auth/group-resolver.ts` rather than lifting it to a
 * shared module — the file is 30 lines and the alternative touches
 * phase-2 code for no real benefit.
 */
class LruCache<K, V> {
  private readonly map = new Map<K, { value: V; insertedAt: number }>();
  constructor(
    private readonly cap: number,
    private readonly ttlMs: number,
    private readonly clock: () => number,
  ) {}

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (entry === undefined) return undefined;
    if (this.clock() - entry.insertedAt > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.cap) {
      const oldest = this.map.keys().next();
      if (!oldest.done) {
        this.map.delete(oldest.value);
      }
    }
    this.map.set(key, { value, insertedAt: this.clock() });
  }

  delete(key: K): void {
    this.map.delete(key);
  }

  clear(): void {
    this.map.clear();
  }
}

interface LayerRow {
  id: string;
  type: 'personal' | 'project' | 'group' | 'everyone';
  slug: string;
  name: string;
  description: string | null;
  owner_user_id: string | null;
  owner_group_id: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  version: number;
}

function rowToLayer(row: LayerRow): Layer {
  return {
    id: row.id,
    type: row.type,
    slug: row.slug,
    name: row.name,
    description: row.description,
    ownerUserId: row.owner_user_id,
    ownerGroupId: row.owner_group_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
    version: row.version,
  };
}

export function createLayerResolver(deps: CreateLayerResolverDeps): LayerResolver {
  const clock = deps.clock ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS_DEFAULT;
  const cap = deps.max ?? CACHE_CAP_DEFAULT;

  const cache = new LruCache<string, readonly Layer[]>(cap, ttlMs, clock);

  // Repos are stateless wrappers around prepared statements; constructing
  // them once per resolver keeps `db.query` cache hits warm.
  const visibility = createLayerVisibilityRepo(deps.db);
  const members = createLayerMembersRepo(deps.db);

  // Lookup helpers that the resolver uses repeatedly. The `personal`
  // and `everyone` lookups are cheap (slug-indexed UNIQUE), but the
  // edges + member-list walks dominate so they live behind their repos.

  function personalLayerIdForUser(userId: string): string | null {
    const row = deps.db
      .query<{ id: string }, [string]>(
        `SELECT id FROM layers
          WHERE type = 'personal' AND owner_user_id = ? AND deleted_at IS NULL`,
      )
      .get(userId);
    return row?.id ?? null;
  }

  function groupLayerIdsForGroups(groupIds: ReadonlySet<string>): Set<string> {
    if (groupIds.size === 0) return new Set<string>();
    const ids = [...groupIds];
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT id FROM layers
                  WHERE type = 'group' AND owner_group_id IN (${placeholders})
                    AND deleted_at IS NULL`;
    const rows = deps.db.query<{ id: string }, string[]>(sql).all(...ids);
    return new Set(rows.map((r) => r.id));
  }

  function everyoneLayerId(): string | null {
    const row = deps.db
      .query<
        { id: string },
        []
      >(`SELECT id FROM layers WHERE type = 'everyone' AND deleted_at IS NULL LIMIT 1`)
      .get();
    return row?.id ?? null;
  }

  function loadLayersByIds(ids: ReadonlySet<string>): Layer[] {
    if (ids.size === 0) return [];
    const list = [...ids];
    const placeholders = list.map(() => '?').join(',');
    const sql = `SELECT id, type, slug, name, description, owner_user_id, owner_group_id,
                        created_at, updated_at, deleted_at, version
                   FROM layers
                  WHERE id IN (${placeholders})
                    AND deleted_at IS NULL`;
    return deps.db
      .query<LayerRow, string[]>(sql)
      .all(...list)
      .map(rowToLayer);
  }

  /**
   * BFS over `layer_visibility_edges` starting from `seedIds`. The walk
   * grows `seedIds` in-place: for every newly-reachable layer we add the
   * parents that are reachable by `bottom_up`/`both` edges (child → parent
   * adds the parent), and the children that are reachable by
   * `top_down`/`both` edges (child → parent adds the child when the parent
   * is in the set).
   *
   * Stops when no new ids are added — guaranteed to terminate because
   * the layer set is finite and we never re-add an id.
   */
  function walkEdges(seedIds: Set<string>): void {
    let frontier = [...seedIds];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier) {
        // bottom_up / both: child→parent edge adds the parent when this id
        // is the child.
        for (const edge of visibility.listEdgesForChild(id)) {
          if (
            (edge.direction === 'bottom_up' || edge.direction === 'both') &&
            !seedIds.has(edge.parentLayerId)
          ) {
            seedIds.add(edge.parentLayerId);
            next.push(edge.parentLayerId);
          }
        }
        // top_down / both: child→parent edge adds the child when this id
        // is the parent.
        for (const edge of visibility.listEdgesForParent(id)) {
          if (
            (edge.direction === 'top_down' || edge.direction === 'both') &&
            !seedIds.has(edge.childLayerId)
          ) {
            seedIds.add(edge.childLayerId);
            next.push(edge.childLayerId);
          }
        }
      }
      frontier = next;
    }
  }

  async function effectiveLayers(userId: string): Promise<readonly Layer[]> {
    const cached = cache.get(userId);
    if (cached !== undefined) return cached;

    const ids = new Set<string>();

    // 1. Personal layer.
    const personalId = personalLayerIdForUser(userId);
    if (personalId !== null) ids.add(personalId);

    // 2. Transitive group layers.
    const transitiveGroups = deps.transitiveGroups.expandUserGroups(userId);
    for (const layerId of groupLayerIdsForGroups(transitiveGroups)) {
      ids.add(layerId);
    }

    // 3. Everyone.
    const everyoneId = everyoneLayerId();
    if (everyoneId !== null) ids.add(everyoneId);

    // 4. Project layer memberships — direct user memberships plus
    //    group-as-member rows resolved through the transitive groups.
    for (const row of members.listLayersForUser(userId)) {
      ids.add(row.layerId);
    }
    for (const groupId of transitiveGroups) {
      for (const row of members.listLayersForGroup(groupId)) {
        ids.add(row.layerId);
      }
    }

    // 5. Walk edges to expand the visibility transitive closure.
    walkEdges(ids);

    // 6. Materialise + filter soft-deleted (defence in depth; the per-step
    //    queries already filter `deleted_at IS NULL`, but a visibility
    //    edge pointing at a soft-deleted layer would still surface it
    //    here without the SELECT filter inside `loadLayersByIds`).
    const layers = loadLayersByIds(ids);
    layers.sort((a, b) =>
      a.type === b.type ? a.slug.localeCompare(b.slug) : a.type.localeCompare(b.type),
    );

    // Freeze the array AND the rows: callers (3.3 middleware) attach the
    // array to `c.var.effectiveLayers` and the contract is "read-only".
    const frozen = Object.freeze(layers.map((l) => Object.freeze(l)));
    cache.set(userId, frozen);
    return frozen;
  }

  function invalidate(userId?: string): void {
    if (userId === undefined) {
      cache.clear();
    } else {
      cache.delete(userId);
    }
  }

  return { effectiveLayers, invalidate };
}
