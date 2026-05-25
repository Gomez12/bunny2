import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { GroupResolver } from '../../auth/group-resolver';
import { createUsersRepo } from '../../repos/users-repo';
import { createGroupsRepo } from '../../repos/groups-repo';
import type { HonoVariables } from '../types';

/**
 * `GET /me/visible-users` and `GET /me/visible-groups` — non-admin
 * directory disclosure for the Members tab picker.
 *
 * Resolved via the `GroupResolver`: every authenticated caller
 * sees the union of users / groups they share at least one
 * transitive group with. A caller in no groups (besides the system
 * `everyone` virtual group, which is not modelled in
 * `user_group_memberships`) sees nobody. Soft-deleted users +
 * groups are excluded. The caller is excluded from the user list.
 *
 * Replaces the old "Members tab needs a non-admin user/group
 * picker" gap from the phase-3.6 close-out (see
 * `docs/dev/follow-ups/done/layer-members-picker.md`). The two
 * routes are the directory-disclosure boundary for non-admins:
 * anything else leaks the global user / group set.
 */
export interface RegisterMeVisibleRoutesDeps {
  readonly db: Database;
  readonly resolver: GroupResolver;
}

export interface VisibleUser {
  readonly id: string;
  readonly displayName: string;
}

export interface VisibleGroup {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export function registerMeVisibleRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: RegisterMeVisibleRoutesDeps,
): void {
  const usersRepo = createUsersRepo(deps.db);
  const groupsRepo = createGroupsRepo(deps.db);

  // ---------- GET /me/visible-users --------------------------------------
  app.get('/me/visible-users', (c) => {
    const user = c.get('user');
    if (user === undefined) {
      // The auth middleware should have rejected the request before us;
      // defensive 401 so a misconfigured wiring doesn't leak.
      return c.json({ users: [] }, 401);
    }
    const visible = collectVisibleUserIds(deps.resolver, user.id);
    // Drop self before hydrating.
    visible.delete(user.id);
    const users: VisibleUser[] = [];
    if (visible.size > 0) {
      // listUsers excludes soft-deleted by default — exactly the shape
      // we want for the picker.
      for (const u of usersRepo.listUsers()) {
        if (visible.has(u.id)) {
          users.push({ id: u.id, displayName: u.displayName });
        }
      }
      users.sort((a, b) => a.displayName.localeCompare(b.displayName));
    }
    return c.json({ users });
  });

  // ---------- GET /me/visible-groups -------------------------------------
  //
  // Visible groups = the caller's own transitive group set. A picker
  // that needs "groups I could add as a layer member" wants this
  // exact set — adding any group I'm not in to a project layer would
  // grant access to people I cannot see.
  app.get('/me/visible-groups', (c) => {
    const user = c.get('user');
    if (user === undefined) {
      return c.json({ groups: [] }, 401);
    }
    const transitiveGroupIds = deps.resolver.expandUserGroups(user.id);
    const groups: VisibleGroup[] = [];
    if (transitiveGroupIds.size > 0) {
      for (const g of groupsRepo.listGroups()) {
        if (transitiveGroupIds.has(g.id)) {
          groups.push({ id: g.id, name: g.name, slug: g.slug });
        }
      }
      groups.sort((a, b) => a.name.localeCompare(b.name));
    }
    return c.json({ groups });
  });
}

/**
 * Build the union of every user id reachable from the caller via at
 * least one shared transitive group. Implementation: expand the
 * caller's groups, then for each group expand the members. The
 * GroupResolver caches both expansions, so repeated calls within the
 * cache TTL are O(1) per group.
 */
function collectVisibleUserIds(resolver: GroupResolver, userId: string): Set<string> {
  const groupIds = resolver.expandUserGroups(userId);
  const out = new Set<string>();
  for (const groupId of groupIds) {
    const expansion = resolver.expandGroupMembers(groupId);
    for (const id of expansion.userIds) out.add(id);
  }
  return out;
}
