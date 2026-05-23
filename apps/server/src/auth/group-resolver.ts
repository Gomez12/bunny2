import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';

/**
 * Transitive group resolver — phase 2.4.
 *
 * Resolves "is user U in (transitively) group G?" plus expansions in both
 * directions, against the `users`, `groups`, `user_group_memberships`,
 * and `group_group_memberships` tables. Memberships form a DAG: a group
 * can have other groups as children, and a user attaches to a group via
 * `user_group_memberships`. A user is in group G if G transitively
 * contains the user's direct groups.
 *
 * ---------------------------------------------------------------------
 * CTE sketches (read these before changing the SQL):
 * ---------------------------------------------------------------------
 *
 * Direction of `group_group_memberships`:
 *   `parent_group_id` CONTAINS `child_group_id` (parent → child edge).
 * So a parent group's transitive members include every user/group
 * reachable by following edges DOWNWARD (parent → child → grand-child).
 *
 * 1. `user → containing groups` (used by isUserInGroup, expandUserGroups):
 *
 *    WITH RECURSIVE ancestors(group_id) AS (
 *      SELECT group_id FROM user_group_memberships WHERE user_id = ?
 *      UNION                       -- not UNION ALL: dedupe + cycle-safe
 *      SELECT ggm.parent_group_id
 *        FROM group_group_memberships ggm
 *        JOIN ancestors a ON ggm.child_group_id = a.group_id
 *    )
 *    SELECT group_id FROM ancestors;
 *
 * 2. `group → descendant group set` (used by expandGroupMembers and
 *    wouldCreateCycle as the downward walk from `child`):
 *
 *    WITH RECURSIVE descendants(group_id) AS (
 *      SELECT ?
 *      UNION                       -- include the seed group itself
 *      SELECT ggm.child_group_id
 *        FROM group_group_memberships ggm
 *        JOIN descendants d ON ggm.parent_group_id = d.group_id
 *    )
 *    SELECT group_id FROM descendants;
 *
 * 3. Cycle detection on `addGroupToGroup(parent, child)`:
 *    A new edge `parent → child` would close a loop iff `parent` is
 *    already reachable from `child` via existing edges. Walk DOWNWARD
 *    from `child`; if `parent` is in that set we'd create a cycle.
 *    Also returns true for the trivial `parent === child` case.
 *
 * Using `UNION` (not `UNION ALL`) makes every recursive step dedupe,
 * which both prunes the work AND defends against pathological cycle
 * rows that should not exist (we block them on insert, but defence in
 * depth — a stray INSERT bypassing the route must not hang the CTE).
 *
 * ---------------------------------------------------------------------
 * Cache:
 * ---------------------------------------------------------------------
 *
 * Two maps:
 *   - `isUserInGroupCache`: key = `${userId}\x1f${groupId}` → boolean.
 *   - `expandGroupMembersCache`: key = groupId → { userIds, groupIds }.
 *   - `expandUserGroupsCache`: key = userId → Set<string>.
 *
 * Invalidation:
 *   - Bus subscriber clears all three on any of `group.created`,
 *     `group.updated`, `group.deleted`, `group.member_added`,
 *     `group.member_removed`, `user.created`, `user.deleted`. The set
 *     is intentionally coarse: a single membership flip can change
 *     answers for any user via diamond inheritance, and a partial
 *     invalidation strategy would have to walk the same CTEs we are
 *     caching.
 *   - 60-second defensive TTL on top of the event-driven invalidation
 *     protects against missed events in pathological bus-restart
 *     scenarios (e.g. tests that recreate the bus without recreating
 *     the resolver — not done today, but a cheap safety net).
 *   - LRU cap of 5000 entries per map. This is a small DoS defence:
 *     a hostile request stream cannot drive memory unbounded by
 *     probing arbitrary (user, group) pairs.
 *
 * Cache scope is per resolver instance. The resolver lives for the
 * lifetime of `createApp` so it's process-scoped in production and
 * fixture-scoped in tests.
 */

/**
 * Per-key LRU. Map preserves insertion order; touching an entry re-inserts
 * it at the end. Eviction pops the oldest (first) key when over cap.
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
    // Touch — move to end.
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

  clear(): void {
    this.map.clear();
  }
}

export interface GroupExpansion {
  readonly userIds: ReadonlySet<string>;
  readonly groupIds: ReadonlySet<string>;
}

export interface GroupResolver {
  isUserInGroup(userId: string, groupId: string): boolean;
  expandGroupMembers(groupId: string): GroupExpansion;
  expandUserGroups(userId: string): ReadonlySet<string>;
  /**
   * Returns true if adding edge `parent → child` would close a cycle, or
   * if `parent === child`. Pure read; does not mutate the DB or cache.
   */
  wouldCreateCycle(parentGroupId: string, childGroupId: string): boolean;
  /** Test-friendly hook: drop every cached answer. */
  invalidateAll(): void;
}

export interface CreateGroupResolverDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  /** Override for tests; default is `Date.now`. */
  readonly clock?: () => number;
  /** Override defaults — exposed mostly for tests. */
  readonly ttlMs?: number;
  readonly cacheCap?: number;
}

const CACHE_CAP_DEFAULT = 5000;
const CACHE_TTL_MS_DEFAULT = 60_000;

const INVALIDATING_EVENTS: readonly string[] = [
  'group.created',
  'group.updated',
  'group.deleted',
  'group.member_added',
  'group.member_removed',
  'user.created',
  'user.deleted',
];

export function createGroupResolver(deps: CreateGroupResolverDeps): GroupResolver {
  const clock = deps.clock ?? (() => Date.now());
  const ttlMs = deps.ttlMs ?? CACHE_TTL_MS_DEFAULT;
  const cap = deps.cacheCap ?? CACHE_CAP_DEFAULT;

  const isUserInGroupCache = new LruCache<string, boolean>(cap, ttlMs, clock);
  const expandUserGroupsCache = new LruCache<string, ReadonlySet<string>>(cap, ttlMs, clock);
  const expandGroupMembersCache = new LruCache<string, GroupExpansion>(cap, ttlMs, clock);

  function invalidateAll(): void {
    isUserInGroupCache.clear();
    expandUserGroupsCache.clear();
    expandGroupMembersCache.clear();
  }

  // Subscribe to invalidating events. Subscriptions are not unsubscribed
  // because the resolver shares the bus's lifetime in production. Tests
  // build a fresh bus per fixture, so leaks are bounded by test count.
  for (const type of INVALIDATING_EVENTS) {
    deps.bus.subscribe(type, () => {
      invalidateAll();
    });
  }

  // Prepared statements. The recursive CTEs use `UNION` (not `UNION ALL`)
  // so each step deduplicates — both for performance and for defence in
  // depth against stray cycle rows that should never exist.

  const ancestorsQuery = deps.db.query<{ group_id: string }, [string]>(
    `WITH RECURSIVE ancestors(group_id) AS (
       SELECT group_id FROM user_group_memberships WHERE user_id = ?
       UNION
       SELECT ggm.parent_group_id
         FROM group_group_memberships ggm
         JOIN ancestors a ON ggm.child_group_id = a.group_id
     )
     SELECT group_id FROM ancestors`,
  );

  const descendantsQuery = deps.db.query<{ group_id: string }, [string]>(
    `WITH RECURSIVE descendants(group_id) AS (
       SELECT ?
       UNION
       SELECT ggm.child_group_id
         FROM group_group_memberships ggm
         JOIN descendants d ON ggm.parent_group_id = d.group_id
     )
     SELECT group_id FROM descendants`,
  );

  // Users that are direct members of any group in a given set. Built as a
  // dynamic IN-list per call (the descendant set size is data-dependent).

  function listUsersInGroupSet(groupIds: ReadonlySet<string>): Set<string> {
    if (groupIds.size === 0) return new Set<string>();
    const ids = [...groupIds];
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT DISTINCT user_id FROM user_group_memberships WHERE group_id IN (${placeholders})`;
    const rows = deps.db.query<{ user_id: string }, string[]>(sql).all(...ids);
    return new Set(rows.map((r) => r.user_id));
  }

  function expandUserGroups(userId: string): ReadonlySet<string> {
    const cached = expandUserGroupsCache.get(userId);
    if (cached !== undefined) return cached;
    const rows = ancestorsQuery.all(userId);
    const set: ReadonlySet<string> = new Set(rows.map((r) => r.group_id));
    expandUserGroupsCache.set(userId, set);
    return set;
  }

  function expandGroupMembers(groupId: string): GroupExpansion {
    const cached = expandGroupMembersCache.get(groupId);
    if (cached !== undefined) return cached;
    const groupRows = descendantsQuery.all(groupId);
    const groupIds = new Set(groupRows.map((r) => r.group_id));
    const userIds = listUsersInGroupSet(groupIds);
    const expansion: GroupExpansion = { userIds, groupIds };
    expandGroupMembersCache.set(groupId, expansion);
    return expansion;
  }

  function isUserInGroup(userId: string, groupId: string): boolean {
    const key = `${userId}\x1f${groupId}`;
    const cached = isUserInGroupCache.get(key);
    if (cached !== undefined) return cached;
    const ancestors = expandUserGroups(userId);
    const result = ancestors.has(groupId);
    isUserInGroupCache.set(key, result);
    return result;
  }

  function wouldCreateCycle(parentGroupId: string, childGroupId: string): boolean {
    if (parentGroupId === childGroupId) return true;
    // A new edge `parent → child` closes a loop iff `parent` is already
    // reachable from `child` via existing parent→child edges. Walk
    // downward from `child` and look for `parent` in the descendant
    // set. We bypass the cache here because the answer depends on the
    // current graph (which we are about to mutate) and the descendant
    // expansion cache stores the full set — fine to consult, but a
    // direct query is just as cheap and keeps the cache cold on a path
    // that runs at most once per insert.
    const rows = descendantsQuery.all(childGroupId);
    for (const row of rows) {
      if (row.group_id === parentGroupId) return true;
    }
    return false;
  }

  return {
    isUserInGroup,
    expandGroupMembers,
    expandUserGroups,
    wouldCreateCycle,
    invalidateAll,
  };
}
