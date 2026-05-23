import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import {
  CreateUserRequestSchema,
  ResetPasswordRequestSchema,
  UpdateUserRequestSchema,
  type Group as SafeGroup,
  type User as SafeUser,
} from '@bunny2/shared';
import { createUsersRepo, type User as StoredUser, type UsersRepo } from '../../repos/users-repo';
import {
  createGroupsRepo,
  type Group as StoredGroup,
  type GroupsRepo,
} from '../../repos/groups-repo';
import type { GroupResolver } from '../../auth/group-resolver';
import type { SessionService } from '../../auth/sessions';
import { hashPassword } from '../../auth/password';
import { validateNewPassword } from '../../auth/password-policy';
import { ADMIN_GROUP_ID_KEY, ADMIN_USER_ID_KEY } from '../../auth/seed';
import { getMeta } from '../../storage/kv-meta';
import type { HonoVariables } from '../types';

/**
 * Phase 2.5 — `/admin/users/*`.
 *
 * Routes here sit behind:
 *   - `requireAuth` (global, `router.ts`)
 *   - `requirePasswordCurrent` (global)
 *   - `requireAdmin` (per-prefix, `router.ts` mounts on `/admin/*`)
 *
 * Therefore handler bodies never re-check auth or admin status; every
 * caller is a signed-in admin who has rotated their initial password.
 *
 * Bus events emitted by 2.5 (see `event-bus.md` §Phase 2 events):
 *
 *   - `user.created { userId, username, createdBy, seeded: false }`
 *   - `user.updated { userId, patch, updatedBy }`
 *   - `user.deleted { userId, deletedBy }`
 *   - `user.password_changed { userId, by, forced }`
 *   - `session.expired { sessionId, userId, reason }` per revoked session
 *   - `group.member_added` / `group.member_removed` (same shape as 2.4)
 *
 * Safety nets:
 *
 *   - The seeded admin user (`kv_meta.admin_user_id`) cannot be deleted
 *     (404 to mask existence, same pattern as the seeded admin group in
 *     `admin-groups.ts`).
 *   - "Last admin" guard: any PATCH that removes a user from the admin
 *     group, and every DELETE, is rejected with 409
 *     `errors.admin.lastAdmin` if it would leave zero users transitively
 *     in the admin group. The math is pure-arithmetic (see `lastAdminGuard`
 *     below): users sit at leaves of the DAG so flipping U's memberships
 *     only changes U's own admin status.
 *   - An admin cannot reset their OWN password via this endpoint — the
 *     route 404s with `errors.admin.cannotResetOwnPassword` and the docs
 *     point them at `POST /auth/password`. This avoids a privilege-
 *     escalation footgun where a forgotten password could be silently
 *     re-granted without proof-of-presence.
 */

export interface AdminUsersRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  readonly resolver: GroupResolver;
  readonly sessions: SessionService;
  readonly now?: () => Date;
}

const NOT_FOUND = { error: 'errors.admin.userNotFound' } as const;
const USERNAME_TAKEN = { error: 'errors.admin.userUsernameTaken' } as const;
const UNKNOWN_GROUP = { error: 'errors.admin.userUnknownGroup' } as const;
const LAST_ADMIN = { error: 'errors.admin.lastAdmin' } as const;
const SELF_RESET = { error: 'errors.admin.cannotResetOwnPassword' } as const;
const WEAK_PASSWORD = { error: 'errors.auth.weakPassword' } as const;
const BAD_REQUEST = { error: 'errors.admin.badRequest' } as const;

const GENERATED_PASSWORD_BYTES = 18; // base64url of 18 bytes = 24 chars (no padding).

export function registerAdminUsersRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AdminUsersRouteDeps,
): void {
  const usersRepo = createUsersRepo(deps.db);
  const groupsRepo = createGroupsRepo(deps.db);
  const clock = deps.now ?? (() => new Date());

  // ---------- GET /admin/users -------------------------------------------

  app.get('/admin/users', (c) => {
    const includeDeleted = c.req.query('includeDeleted') === 'true';
    const users = usersRepo.listUsers({ includeDeleted });
    const rows = users.map((u) => ({
      ...toSafeUser(u),
      directGroupIds: groupsRepo.listDirectUserMemberships(u.id).map((m) => m.groupId),
    }));
    return c.json({ users: rows });
  });

  // ---------- GET /admin/users/:id ---------------------------------------

  app.get('/admin/users/:id', (c) => {
    const id = c.req.param('id');
    const includeDeleted = c.req.query('includeDeleted') === 'true';
    const stored = usersRepo.findUserById(id);
    if (stored === null) {
      return c.json(NOT_FOUND, 404);
    }
    if (stored.deletedAt !== null && !includeDeleted) {
      return c.json(NOT_FOUND, 404);
    }
    const directGroups: SafeGroup[] = groupsRepo
      .listDirectUserMemberships(id)
      .map((m) => groupsRepo.findGroupById(m.groupId))
      .filter((g): g is StoredGroup => g !== null && g.deletedAt === null)
      .map(toSafeGroup);
    return c.json({ user: toSafeUser(stored), directGroups });
  });

  // ---------- POST /admin/users ------------------------------------------

  app.post('/admin/users', async (c) => {
    const correlationId = crypto.randomUUID();
    const actingAdmin = c.get('user');

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = CreateUserRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { username: rawUsername, displayName, initialPassword, groupIds } = parsed.data;
    const username = rawUsername.toLowerCase();

    if (usersRepo.findUserByUsername(username) !== null) {
      return c.json(USERNAME_TAKEN, 409);
    }
    if (groupIds !== undefined && !areAllKnownGroups(groupsRepo, groupIds)) {
      return c.json(UNKNOWN_GROUP, 400);
    }

    // Policy floor when the admin supplied a password explicitly; the
    // generated path uses a 24-char CSPRNG token which trivially clears
    // the bar.
    let plaintextForResponse: string | null = null;
    let plaintextToHash: string;
    if (initialPassword !== undefined) {
      const policy = validateNewPassword(initialPassword);
      if (!policy.ok) {
        return c.json(WEAK_PASSWORD, 400);
      }
      plaintextToHash = initialPassword;
    } else {
      plaintextToHash = generatePassword();
      plaintextForResponse = plaintextToHash;
    }

    const passwordHash = await hashPassword(plaintextToHash);
    const id = crypto.randomUUID();
    const nowIso = clock().toISOString();
    const created = usersRepo.createUser({
      id,
      username,
      displayName,
      passwordHash,
      // Admin-created users MUST rotate on first login. The bar is the
      // same regardless of whether the admin supplied a password.
      mustChangePassword: true,
      now: nowIso,
    });

    await deps.bus.publish({
      type: 'user.created',
      payload: {
        userId: created.id,
        username: created.username,
        createdBy: actingAdmin.id,
        seeded: false,
      },
      correlationId,
    });

    if (groupIds !== undefined) {
      for (const groupId of groupIds) {
        groupsRepo.addUserToGroup(created.id, groupId, nowIso);
        await deps.bus.publish({
          type: 'group.member_added',
          payload: { groupId, kind: 'user', userId: created.id },
          correlationId,
        });
      }
    }

    return c.json(
      {
        user: toSafeUser(created),
        ...(plaintextForResponse !== null ? { generatedPassword: plaintextForResponse } : {}),
      },
      201,
    );
  });

  // ---------- PATCH /admin/users/:id -------------------------------------

  app.patch('/admin/users/:id', async (c) => {
    const correlationId = crypto.randomUUID();
    const actingAdmin = c.get('user');
    const id = c.req.param('id');

    const stored = usersRepo.findUserById(id);
    if (stored === null || stored.deletedAt !== null) {
      return c.json(NOT_FOUND, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = UpdateUserRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { displayName, groupIds } = parsed.data;

    if (groupIds !== undefined && !areAllKnownGroups(groupsRepo, groupIds)) {
      return c.json(UNKNOWN_GROUP, 400);
    }

    // Last-admin guard — only relevant when groupIds is changing.
    if (groupIds !== undefined) {
      const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY);
      if (adminGroupId !== null && adminGroupId !== '') {
        const guard = lastAdminGuard({
          resolver: deps.resolver,
          adminGroupId,
          targetUserId: id,
          newGroupIds: new Set(groupIds),
        });
        if (!guard.ok) {
          return c.json(LAST_ADMIN, 409);
        }
      }
    }

    const nowIso = clock().toISOString();
    const patchForEvent: { displayName?: string; groupIds?: readonly string[] } = {};
    let updated: StoredUser = stored;
    if (displayName !== undefined) {
      updated = usersRepo.updateUser(id, { displayName }, nowIso);
      patchForEvent.displayName = displayName;
    }
    if (groupIds !== undefined) {
      const currentGroupIds = new Set(
        groupsRepo.listDirectUserMemberships(id).map((m) => m.groupId),
      );
      const desired = new Set(groupIds);
      const toAdd = [...desired].filter((g) => !currentGroupIds.has(g));
      const toRemove = [...currentGroupIds].filter((g) => !desired.has(g));
      for (const gid of toRemove) {
        groupsRepo.removeUserFromGroup(id, gid);
        await deps.bus.publish({
          type: 'group.member_removed',
          payload: { groupId: gid, kind: 'user', userId: id },
          correlationId,
        });
      }
      for (const gid of toAdd) {
        groupsRepo.addUserToGroup(id, gid, nowIso);
        await deps.bus.publish({
          type: 'group.member_added',
          payload: { groupId: gid, kind: 'user', userId: id },
          correlationId,
        });
      }
      patchForEvent.groupIds = groupIds;
    }

    if (patchForEvent.displayName !== undefined || patchForEvent.groupIds !== undefined) {
      await deps.bus.publish({
        type: 'user.updated',
        payload: { userId: id, patch: patchForEvent, updatedBy: actingAdmin.id },
        correlationId,
      });
    }

    return c.json({ user: toSafeUser(updated) });
  });

  // ---------- DELETE /admin/users/:id ------------------------------------

  app.delete('/admin/users/:id', async (c) => {
    const correlationId = crypto.randomUUID();
    const actingAdmin = c.get('user');
    const id = c.req.param('id');

    // Seeded admin user — refuse, mask as not-found.
    const seededAdminUserId = getMeta(deps.db, ADMIN_USER_ID_KEY);
    if (seededAdminUserId !== null && seededAdminUserId === id) {
      return c.json(NOT_FOUND, 404);
    }

    const stored = usersRepo.findUserById(id);
    if (stored === null || stored.deletedAt !== null) {
      return c.json(NOT_FOUND, 404);
    }

    // Last-admin guard: deleting target removes it from the admin group
    // transitively. Equivalent to a PATCH that empties groupIds, so we
    // pass `newGroupIds: empty` to the same helper.
    const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY);
    if (adminGroupId !== null && adminGroupId !== '') {
      const guard = lastAdminGuard({
        resolver: deps.resolver,
        adminGroupId,
        targetUserId: id,
        newGroupIds: new Set<string>(),
      });
      if (!guard.ok) {
        return c.json(LAST_ADMIN, 409);
      }
    }

    const nowDate = clock();
    const nowIso = nowDate.toISOString();
    usersRepo.softDeleteUser(id, nowIso);

    // Revoke every active session for this user with reason `user_deleted`.
    // The session service publishes `session.expired` per revoked row.
    await deps.sessions.revokeAllForUser(id, nowDate, {
      reason: 'user_deleted',
      correlationId,
    });

    await deps.bus.publish({
      type: 'user.deleted',
      payload: { userId: id, deletedBy: actingAdmin.id },
      correlationId,
    });

    return c.json({ ok: true });
  });

  // ---------- POST /admin/users/:id/reset-password -----------------------

  app.post('/admin/users/:id/reset-password', async (c) => {
    const correlationId = crypto.randomUUID();
    const actingAdmin = c.get('user');
    const id = c.req.param('id');

    // Self-reset is forbidden — admins must use `POST /auth/password`
    // which requires the current password as proof-of-presence. Mask
    // as 404 so we don't leak "this is the seeded admin" to anyone
    // probing the endpoint.
    if (id === actingAdmin.id) {
      return c.json(SELF_RESET, 404);
    }

    const stored = usersRepo.findUserById(id);
    if (stored === null || stored.deletedAt !== null) {
      return c.json(NOT_FOUND, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      // Empty body is allowed — schema treats `newPassword` as optional.
      body = {};
    }
    const parsed = ResetPasswordRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { newPassword } = parsed.data;

    let plaintextForResponse: string | null = null;
    let plaintextToHash: string;
    if (newPassword !== undefined) {
      const policy = validateNewPassword(newPassword);
      if (!policy.ok) {
        return c.json(WEAK_PASSWORD, 400);
      }
      plaintextToHash = newPassword;
    } else {
      plaintextToHash = generatePassword();
      plaintextForResponse = plaintextToHash;
    }
    const passwordHash = await hashPassword(plaintextToHash);

    const nowDate = clock();
    const nowIso = nowDate.toISOString();
    usersRepo.updateUser(id, { passwordHash, mustChangePassword: true }, nowIso);

    // Kill every session the target currently holds — the admin-forced
    // rotation must invalidate everything immediately. Publishes
    // `session.expired` per revoked row.
    await deps.sessions.revokeAllForUser(id, nowDate, {
      reason: 'admin_password_reset',
      correlationId,
    });

    await deps.bus.publish({
      type: 'user.password_changed',
      payload: { userId: id, by: actingAdmin.id, forced: true },
      correlationId,
    });

    return c.json({
      ok: true,
      ...(plaintextForResponse !== null ? { generatedPassword: plaintextForResponse } : {}),
    });
  });
}

// ---------------------------------------------------------------------------
// Helpers

function toSafeUser(stored: StoredUser): SafeUser {
  return {
    id: stored.id,
    username: stored.username,
    displayName: stored.displayName,
    mustChangePassword: stored.mustChangePassword,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
    version: stored.version,
  };
}

function toSafeGroup(stored: StoredGroup): SafeGroup {
  return {
    id: stored.id,
    slug: stored.slug,
    name: stored.name,
    description: stored.description,
    createdAt: stored.createdAt,
    updatedAt: stored.updatedAt,
    deletedAt: stored.deletedAt,
    version: stored.version,
  };
}

function areAllKnownGroups(repo: GroupsRepo, ids: readonly string[]): boolean {
  for (const id of ids) {
    const g = repo.findGroupById(id);
    if (g === null || g.deletedAt !== null) return false;
  }
  return true;
}

/**
 * 24 url-safe characters of CSPRNG entropy. 18 bytes → 144 bits, well
 * above the policy floor and identical to the seed-admin generator so
 * the operator experience is uniform.
 */
function generatePassword(): string {
  const buf = new Uint8Array(GENERATED_PASSWORD_BYTES);
  crypto.getRandomValues(buf);
  return Buffer.from(buf)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

/**
 * Pure-arithmetic "last admin" guard.
 *
 * Users sit at the leaves of the DAG (only groups can be group members),
 * so flipping U's direct memberships only changes U's own transitive
 * admin status — nobody else's. We can compute the post-change admin
 * count without any DB write, savepoint, or graph re-walk:
 *
 *   adminUsers       = resolver.expandGroupMembers(adminGroupId).userIds
 *   adminGroupSet    = resolver.expandGroupMembers(adminGroupId).groupIds
 *   wasAdmin         = adminUsers.has(targetUserId)
 *   willBeAdmin      = newGroupIds.some(g => adminGroupSet.has(g))
 *   postCount        = adminUsers.size - (wasAdmin?1:0) + (willBeAdmin?1:0)
 *
 * `ok` is `true` iff `postCount >= 1`. For DELETE we pass an empty set
 * for `newGroupIds`, so `willBeAdmin` is `false`.
 */
export function lastAdminGuard(input: {
  readonly resolver: GroupResolver;
  readonly adminGroupId: string;
  readonly targetUserId: string;
  readonly newGroupIds: ReadonlySet<string>;
}): { readonly ok: true } | { readonly ok: false } {
  const expansion = input.resolver.expandGroupMembers(input.adminGroupId);
  const wasAdmin = expansion.userIds.has(input.targetUserId) ? 1 : 0;
  let willBeAdmin = 0;
  for (const gid of input.newGroupIds) {
    if (expansion.groupIds.has(gid)) {
      willBeAdmin = 1;
      break;
    }
  }
  const postCount = expansion.userIds.size - wasAdmin + willBeAdmin;
  return postCount >= 1 ? { ok: true } : { ok: false };
}

export type { UsersRepo };
