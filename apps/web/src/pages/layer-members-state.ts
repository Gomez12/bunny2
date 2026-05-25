/**
 * Phase 2 (UI exposure gaps) — pure-logic helpers for the layer
 * Members tab's Remove button.
 *
 * The web tests dir is pure-logic only (no DOM runtime); the
 * sole-owner guard lives here so the test in
 * `apps/web/tests/layer-members-state.test.ts` can exercise the
 * predicate without mounting the React tree. The component (in
 * `LayerSettingsPage.tsx`) calls these the same way.
 */

import type { LayerMembersResponse } from '../lib/api-types';

/**
 * Returns `true` iff the actor is currently the only owner of the
 * layer — counted across BOTH user-owner rows and group-owner rows.
 * The Members tab uses this to disable the Remove button on the
 * actor's own user row when removing themselves would leave the layer
 * with zero owners. Server-side this is not enforced (no rule
 * forbids zero owners today); the guard is a UI affordance only.
 *
 * Group ownership counts a single row regardless of group size — if
 * the actor is the sole user-owner but a group with N members also
 * holds the owner role, the layer still has an owner after the
 * actor's removal, so this returns `false`.
 */
export function isSoleOwner(actorUserId: string, members: LayerMembersResponse): boolean {
  const actorRow = members.users.find((u) => u.userId === actorUserId);
  if (actorRow === undefined || actorRow.role !== 'owner') return false;
  const ownerRows =
    members.users.filter((u) => u.role === 'owner').length +
    members.groups.filter((g) => g.role === 'owner').length;
  return ownerRows === 1;
}
