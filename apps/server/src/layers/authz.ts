import type { Database } from 'bun:sqlite';
import type { User as SafeUser } from '@bunny2/shared';
import type { Layer } from '../repos/layers-repo';

/**
 * Phase 3.4 — per-layer authorization.
 *
 * `canEditLayer` is the single source of truth for the "may this user
 * mutate this layer?" check used by every route under §4.4 of the
 * phase-3 plan that gates a write.
 *
 * The §4.4 table maps cleanly to the rules below:
 *
 *   - `everyone` layer  → site-admin only.
 *   - `personal` layer  → `layer.ownerUserId === user.id` OR site-admin.
 *   - `group` layer     → site-admin OR an admin of the owning group.
 *   - `project` layer   → site-admin OR a user member with `role = 'owner'`.
 *
 * Group-admin gap (v1 fallback)
 * -----------------------------
 * Phase 2 (`groups-repo.ts`, `user_group_memberships`, the transitive
 * `GroupResolver`) does NOT model a per-group "admin" role:
 * membership is a single bit, and the lone "is this user admin of
 * THIS group?" notion the codebase has today is whether the user is
 * a transitive member of the seeded `admin` group (which is global,
 * not per-group). There is no "admin sub-group of X" convention either.
 *
 * For v1, `canEditLayer` therefore falls back to **site-admin only**
 * for group layers. The gap is tracked in
 * `docs/dev/follow-ups/group-layer-admin-role.md` — once phase 4+
 * introduces a per-group role column or a group-admin sub-group
 * convention, swap the `false` branch below for the real check.
 *
 * The caller computes `isSiteAdmin` ONCE per request via the existing
 * `GroupResolver.isUserInGroup(user.id, ADMIN_GROUP_ID_KEY)` pattern
 * used in `http/middleware/admin.ts`; we accept it as a primitive so
 * unit tests don't need to wire a full resolver.
 */

export interface CanEditLayerArgs {
  readonly user: SafeUser;
  readonly layer: Layer;
  readonly db: Database;
  readonly isSiteAdmin: boolean;
}

export function canEditLayer(args: CanEditLayerArgs): boolean {
  const { user, layer, db, isSiteAdmin } = args;

  if (isSiteAdmin) return true;

  switch (layer.type) {
    case 'everyone':
      // Site-admin only — handled by the early return above.
      return false;

    case 'personal':
      return layer.ownerUserId !== null && layer.ownerUserId === user.id;

    case 'group':
      // v1 fallback: no per-group admin role exists yet — see follow-up
      // note in the file-level JSDoc.
      return false;

    case 'project': {
      const row = db
        .query<
          { role: string },
          [string, string]
        >(`SELECT role FROM layer_user_members WHERE layer_id = ? AND user_id = ?`)
        .get(layer.id, user.id);
      return row !== null && row.role === 'owner';
    }

    default:
      // Exhaustive guard — the `LayerType` enum is closed; an unknown
      // type means the schema changed without updating this helper.
      return false;
  }
}
