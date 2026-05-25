/**
 * Phase 4 (ui-exposure-gaps) — pure view-state for `AdminUserDetailPage`.
 *
 * Mirrors `scheduled-tasks-page-state.ts`: render-branch projection only,
 * so the loading / error / empty / ready matrix is testable without a
 * DOM runtime (see `docs/dev/follow-ups/web-component-tests.md`).
 *
 * The page itself owns navigation + refresh side effects; this module
 * only flattens `loading | error | { user, directGroups }` into the
 * branch the component renders.
 */

import type { AdminUserDetailResponse, SafeGroup, SafeUser } from '../../lib/api-types';

export type AdminUserDetailInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly detail: AdminUserDetailResponse };

export type AdminUserDetailView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | {
      readonly kind: 'ready';
      readonly user: SafeUser;
      readonly directGroups: readonly SafeGroup[];
      readonly hasGroups: boolean;
    };

export function adminUserDetailView(input: AdminUserDetailInput): AdminUserDetailView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  return {
    kind: 'ready',
    user: input.detail.user,
    directGroups: input.detail.directGroups,
    hasGroups: input.detail.directGroups.length > 0,
  };
}

/**
 * i18n key for the active/deleted/must-change-password status badge.
 * The list page rolls its own ternary inline; the detail page calls
 * this so the labels stay in sync if the badge gains more states.
 */
export function userStatusLabelKey(user: SafeUser): string {
  if (user.deletedAt !== null) return 'admin.users.status.deleted';
  if (user.mustChangePassword) return 'admin.users.detail.status.mustChangePassword';
  return 'admin.users.status.active';
}
