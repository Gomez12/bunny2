/**
 * Phase 2.5 — `lastAdminGuard` arithmetic.
 *
 * The pure helper is exported from `routes/admin-users.ts` precisely so
 * we can hammer its branches without a DB or HTTP fixture. PATCH and
 * DELETE both feed into the same function; covering it here lets the
 * HTTP tests remain expressive about end-to-end flows while the math
 * gets covered structurally.
 */
import { describe, expect, it } from 'bun:test';
import { lastAdminGuard } from '../src/http/routes/admin-users';
import type { GroupResolver, GroupExpansion } from '../src/auth/group-resolver';

function stubResolver(expansion: GroupExpansion): GroupResolver {
  return {
    isUserInGroup() {
      return false;
    },
    expandGroupMembers() {
      return expansion;
    },
    expandUserGroups() {
      return new Set<string>();
    },
    wouldCreateCycle() {
      return false;
    },
    invalidateAll() {
      /* no-op */
    },
  };
}

const ADMIN_GROUP_ID = 'admin-group-uuid';
const ENG_GROUP_ID = 'eng-group-uuid';
const SALES_GROUP_ID = 'sales-group-uuid';
const TARGET = 'target-user';
const OTHER_ADMIN = 'other-admin-user';

describe('lastAdminGuard', () => {
  it('rejects a DELETE that would drop the admin user set to zero', () => {
    const resolver = stubResolver({
      userIds: new Set([TARGET]),
      groupIds: new Set([ADMIN_GROUP_ID]),
    });
    const result = lastAdminGuard({
      resolver,
      adminGroupId: ADMIN_GROUP_ID,
      targetUserId: TARGET,
      newGroupIds: new Set<string>(),
    });
    expect(result.ok).toBe(false);
  });

  it('allows a DELETE when another transitive admin user remains', () => {
    const resolver = stubResolver({
      userIds: new Set([TARGET, OTHER_ADMIN]),
      groupIds: new Set([ADMIN_GROUP_ID]),
    });
    const result = lastAdminGuard({
      resolver,
      adminGroupId: ADMIN_GROUP_ID,
      targetUserId: TARGET,
      newGroupIds: new Set<string>(),
    });
    expect(result.ok).toBe(true);
  });

  it('rejects a PATCH that removes the only admin from admin', () => {
    const resolver = stubResolver({
      userIds: new Set([TARGET]),
      groupIds: new Set([ADMIN_GROUP_ID]),
    });
    const result = lastAdminGuard({
      resolver,
      adminGroupId: ADMIN_GROUP_ID,
      targetUserId: TARGET,
      newGroupIds: new Set([ENG_GROUP_ID]),
    });
    expect(result.ok).toBe(false);
  });

  it('allows a PATCH that keeps the user in a transitively-admin group', () => {
    // Engineering is a sub-group of admin; the target is in engineering.
    const resolver = stubResolver({
      userIds: new Set([TARGET]),
      groupIds: new Set([ADMIN_GROUP_ID, ENG_GROUP_ID]),
    });
    const result = lastAdminGuard({
      resolver,
      adminGroupId: ADMIN_GROUP_ID,
      targetUserId: TARGET,
      newGroupIds: new Set([ENG_GROUP_ID]),
    });
    expect(result.ok).toBe(true);
  });

  it('handles a non-admin target — postCount stays equal to the admin user count', () => {
    const resolver = stubResolver({
      userIds: new Set([OTHER_ADMIN]),
      groupIds: new Set([ADMIN_GROUP_ID]),
    });
    // Target is not an admin; setting any non-admin groupIds → no change.
    const result = lastAdminGuard({
      resolver,
      adminGroupId: ADMIN_GROUP_ID,
      targetUserId: TARGET,
      newGroupIds: new Set([SALES_GROUP_ID]),
    });
    expect(result.ok).toBe(true);
  });
});
