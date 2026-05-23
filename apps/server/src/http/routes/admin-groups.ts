import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import {
  AddGroupMemberRequestSchema,
  CreateGroupRequestSchema,
  UpdateGroupRequestSchema,
  type Group as SafeGroup,
  type User as SafeUser,
} from '@bunny2/shared';
import {
  createGroupsRepo,
  type Group as StoredGroup,
  type GroupsRepo,
} from '../../repos/groups-repo';
import { createUsersRepo, type User as StoredUser } from '../../repos/users-repo';
import type { GroupResolver } from '../../auth/group-resolver';
import type { HonoVariables } from '../types';

/**
 * Phase 2.4 — `/admin/groups/*`.
 *
 * Every route here sits behind:
 *   - `requireAuth` (global, in `router.ts`)
 *   - `requirePasswordCurrent` (global; lets `/auth/password` + logout
 *     through but blocks every other route when `mustChangePassword`)
 *   - `requireAdmin` (per-prefix; mounted on `/admin/*`)
 *
 * The handler bodies therefore never re-check auth or admin status.
 *
 * Bus events emitted (mirror `auth-and-sessions.md` §8):
 *   `group.created`, `group.updated`, `group.deleted`,
 *   `group.member_added` (kind: 'user' | 'group'),
 *   `group.member_removed` (kind: 'user' | 'group').
 *
 * Correlation id per request, generated here and threaded into every
 * publish — same pattern as `routes/auth.ts` and `routes/chat.ts`.
 */

export interface AdminGroupsRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  readonly resolver: GroupResolver;
  readonly now?: () => Date;
}

const ADMIN_SLUG = 'admin' as const;

const NOT_FOUND = { error: 'errors.admin.groupNotFound' } as const;
const SLUG_TAKEN = { error: 'errors.admin.groupSlugTaken' } as const;
const CYCLE = { error: 'errors.admin.groupCycle' } as const;
const SELF_MEMBER = { error: 'errors.admin.groupSelfMember' } as const;
const MISSING_KIND = { error: 'errors.admin.missingMemberKind' } as const;
const USER_NOT_FOUND = { error: 'errors.admin.userNotFound' } as const;
const BAD_REQUEST = { error: 'errors.admin.badRequest' } as const;

export function registerAdminGroupsRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: AdminGroupsRouteDeps,
): void {
  const groupsRepo = createGroupsRepo(deps.db);
  const usersRepo = createUsersRepo(deps.db);
  const clock = deps.now ?? (() => new Date());

  // ---------- GET /admin/groups ------------------------------------------

  app.get('/admin/groups', (c) => {
    const includeDeleted = c.req.query('includeDeleted') === 'true';
    const groups = groupsRepo.listGroups({ includeDeleted });
    const rows = groups.map((g) => ({
      ...toSafeGroup(g),
      directUserMemberCount: countDirectUserMembers(deps.db, g.id),
      directSubGroupCount: groupsRepo.listDirectGroupChildren(g.id).length,
    }));
    return c.json({ groups: rows });
  });

  // ---------- GET /admin/groups/:id --------------------------------------

  app.get('/admin/groups/:id', (c) => {
    const id = c.req.param('id');
    const group = groupsRepo.findGroupById(id);
    if (group === null || group.deletedAt !== null) {
      return c.json(NOT_FOUND, 404);
    }
    const directUserIds = listDirectUserMemberIds(deps.db, id);
    const directUsers: SafeUser[] = directUserIds
      .map((uid) => usersRepo.findUserById(uid))
      .filter((u): u is StoredUser => u !== null && u.deletedAt === null)
      .map(toSafeUser);

    const directSubGroups: SafeGroup[] = groupsRepo
      .listDirectGroupChildren(id)
      .map((edge) => groupsRepo.findGroupById(edge.childGroupId))
      .filter((g): g is StoredGroup => g !== null && g.deletedAt === null)
      .map(toSafeGroup);

    const parentGroups: SafeGroup[] = listDirectGroupParents(deps.db, id)
      .map((pid) => groupsRepo.findGroupById(pid))
      .filter((g): g is StoredGroup => g !== null && g.deletedAt === null)
      .map(toSafeGroup);

    return c.json({
      group: toSafeGroup(group),
      directUsers,
      directSubGroups,
      parentGroups,
    });
  });

  // ---------- POST /admin/groups -----------------------------------------

  app.post('/admin/groups', async (c) => {
    const correlationId = crypto.randomUUID();
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = CreateGroupRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { slug, name, description } = parsed.data;

    if (groupsRepo.findGroupBySlug(slug) !== null) {
      return c.json(SLUG_TAKEN, 409);
    }

    const id = crypto.randomUUID();
    const nowIso = clock().toISOString();
    const created = groupsRepo.createGroup({
      id,
      slug,
      name,
      ...(description !== undefined ? { description } : {}),
      now: nowIso,
    });

    await deps.bus.publish({
      type: 'group.created',
      payload: { groupId: created.id, slug: created.slug, name: created.name },
      correlationId,
    });

    return c.json({ group: toSafeGroup(created) }, 201);
  });

  // ---------- PATCH /admin/groups/:id ------------------------------------

  app.patch('/admin/groups/:id', async (c) => {
    const correlationId = crypto.randomUUID();
    const id = c.req.param('id');

    const existing = groupsRepo.findGroupById(id);
    if (existing === null || existing.deletedAt !== null) {
      return c.json(NOT_FOUND, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = UpdateGroupRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }

    const patch: { name?: string; description?: string | null } = {};
    if (parsed.data.name !== undefined) patch.name = parsed.data.name;
    if (parsed.data.description !== undefined) patch.description = parsed.data.description;

    const updated = groupsRepo.updateGroup(id, patch, clock().toISOString());

    await deps.bus.publish({
      type: 'group.updated',
      payload: { groupId: updated.id, patch },
      correlationId,
    });

    return c.json({ group: toSafeGroup(updated) });
  });

  // ---------- DELETE /admin/groups/:id -----------------------------------

  app.delete('/admin/groups/:id', async (c) => {
    const correlationId = crypto.randomUUID();
    const id = c.req.param('id');
    const existing = groupsRepo.findGroupById(id);
    if (existing === null || existing.deletedAt !== null) {
      return c.json(NOT_FOUND, 404);
    }
    if (existing.slug === ADMIN_SLUG) {
      // The seeded admin group is permanent. Return 404 to mirror "not
      // found" — leaking "exists but protected" gives no useful info to
      // the caller and the docs make the rule explicit.
      return c.json(NOT_FOUND, 404);
    }
    groupsRepo.softDeleteGroup(id, clock().toISOString());
    await deps.bus.publish({
      type: 'group.deleted',
      payload: { groupId: existing.id, slug: existing.slug },
      correlationId,
    });
    return c.json({ ok: true });
  });

  // ---------- POST /admin/groups/:id/members -----------------------------

  app.post('/admin/groups/:id/members', async (c) => {
    const correlationId = crypto.randomUUID();
    const id = c.req.param('id');
    const parentGroup = groupsRepo.findGroupById(id);
    if (parentGroup === null || parentGroup.deletedAt !== null) {
      return c.json(NOT_FOUND, 404);
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = AddGroupMemberRequestSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(BAD_REQUEST, 400);
    }
    const { userId, groupId } = parsed.data;

    const nowIso = clock().toISOString();

    if (userId !== undefined) {
      const user = usersRepo.findUserById(userId);
      if (user === null || user.deletedAt !== null) {
        return c.json(USER_NOT_FOUND, 404);
      }
      groupsRepo.addUserToGroup(userId, id, nowIso);
      await deps.bus.publish({
        type: 'group.member_added',
        payload: { groupId: id, kind: 'user', userId },
        correlationId,
      });
      return c.json({ ok: true }, 201);
    }

    // Group-as-member branch.
    if (groupId === undefined) {
      // Schema enforces xor, but be defensive — the refinement makes
      // this branch unreachable today.
      return c.json(MISSING_KIND, 400);
    }
    if (groupId === id) {
      return c.json(SELF_MEMBER, 409);
    }
    const child = groupsRepo.findGroupById(groupId);
    if (child === null || child.deletedAt !== null) {
      return c.json(NOT_FOUND, 404);
    }
    if (deps.resolver.wouldCreateCycle(id, groupId)) {
      return c.json(CYCLE, 409);
    }
    groupsRepo.addGroupToGroup(id, groupId, nowIso);
    await deps.bus.publish({
      type: 'group.member_added',
      payload: { groupId: id, kind: 'group', childGroupId: groupId },
      correlationId,
    });
    return c.json({ ok: true }, 201);
  });

  // ---------- DELETE /admin/groups/:id/members/:memberId -----------------

  app.delete('/admin/groups/:id/members/:memberId', async (c) => {
    const correlationId = crypto.randomUUID();
    const id = c.req.param('id');
    const memberId = c.req.param('memberId');
    const kind = c.req.query('kind');
    if (kind !== 'user' && kind !== 'group') {
      return c.json(MISSING_KIND, 400);
    }

    const group = groupsRepo.findGroupById(id);
    if (group === null || group.deletedAt !== null) {
      return c.json(NOT_FOUND, 404);
    }

    if (kind === 'user') {
      groupsRepo.removeUserFromGroup(memberId, id);
      await deps.bus.publish({
        type: 'group.member_removed',
        payload: { groupId: id, kind: 'user', userId: memberId },
        correlationId,
      });
    } else {
      groupsRepo.removeGroupFromGroup(id, memberId);
      await deps.bus.publish({
        type: 'group.member_removed',
        payload: { groupId: id, kind: 'group', childGroupId: memberId },
        correlationId,
      });
    }
    return c.json({ ok: true });
  });
}

// ---------------------------------------------------------------------------

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

function countDirectUserMembers(db: Database, groupId: string): number {
  return (
    db
      .query<
        { n: number },
        [string]
      >('SELECT COUNT(*) AS n FROM user_group_memberships WHERE group_id = ?')
      .get(groupId)?.n ?? 0
  );
}

function listDirectUserMemberIds(db: Database, groupId: string): string[] {
  return db
    .query<{ user_id: string }, [string]>(
      'SELECT user_id FROM user_group_memberships WHERE group_id = ? ORDER BY created_at',
    )
    .all(groupId)
    .map((r) => r.user_id);
}

function listDirectGroupParents(db: Database, childGroupId: string): string[] {
  return db
    .query<{ parent_group_id: string }, [string]>(
      'SELECT parent_group_id FROM group_group_memberships WHERE child_group_id = ? ORDER BY created_at',
    )
    .all(childGroupId)
    .map((r) => r.parent_group_id);
}

// Avoid TS "imported but only used as type" warnings on GroupsRepo.
export type { GroupsRepo };
