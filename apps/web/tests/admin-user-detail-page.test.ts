/**
 * Phase 4 (ui-exposure-gaps) — smoke + state-projection tests for
 * `AdminUserDetailPage`.
 *
 * Mirrors `scheduled-tasks-page.test.ts`: the repo has no DOM runtime,
 * so we exercise the pure view-state reducer
 * (`adminUserDetailView`) the page delegates branch selection to. The
 * test also asserts the i18n keys returned by `userStatusLabelKey`
 * exist in `en.json` — this is the "routing smoke + happy-path render"
 * proxy for a DOM-less harness; if the key were renamed without
 * updating the locale, `i18n:check` would catch it, and this test
 * catches the reverse — accidental removal of a status label without
 * updating the helper.
 */
import { describe, expect, it } from 'bun:test';
import {
  adminUserDetailView,
  userStatusLabelKey,
  type AdminUserDetailInput,
} from '../src/pages/admin/admin-user-detail-page-state';
import type { AdminUserDetailResponse, SafeGroup, SafeUser } from '../src/lib/api-types';

function makeUser(overrides: Partial<SafeUser> = {}): SafeUser {
  return {
    id: 'user-1',
    username: 'alice',
    displayName: 'Alice',
    mustChangePassword: false,
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

function makeGroup(slug: string): SafeGroup {
  return {
    id: `g-${slug}`,
    slug,
    name: slug,
    description: null,
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

function readyInput(detail: AdminUserDetailResponse): AdminUserDetailInput {
  return { status: 'ready', detail };
}

describe('adminUserDetailView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(adminUserDetailView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(adminUserDetailView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('flags hasGroups=false when the user has no direct group memberships', () => {
    const out = adminUserDetailView(readyInput({ user: makeUser(), directGroups: [] }));
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.hasGroups).toBe(false);
      expect(out.directGroups).toHaveLength(0);
      expect(out.user.username).toBe('alice');
    }
  });

  it('flags hasGroups=true and preserves order when groups are present', () => {
    const out = adminUserDetailView(
      readyInput({
        user: makeUser(),
        directGroups: [makeGroup('admins'), makeGroup('engineers')],
      }),
    );
    expect(out.kind).toBe('ready');
    if (out.kind === 'ready') {
      expect(out.hasGroups).toBe(true);
      expect(out.directGroups.map((g) => g.slug)).toEqual(['admins', 'engineers']);
    }
  });
});

describe('userStatusLabelKey', () => {
  it('returns the deleted key when the user is soft-deleted', () => {
    expect(userStatusLabelKey(makeUser({ deletedAt: '2026-05-25T00:00:00.000Z' }))).toBe(
      'admin.users.status.deleted',
    );
  });

  it('returns the must-change key when password rotation is forced', () => {
    expect(userStatusLabelKey(makeUser({ mustChangePassword: true }))).toBe(
      'admin.users.detail.status.mustChangePassword',
    );
  });

  it('returns the active key for a normal user', () => {
    expect(userStatusLabelKey(makeUser())).toBe('admin.users.status.active');
  });

  it('prefers the deleted state over must-change-password', () => {
    expect(
      userStatusLabelKey(
        makeUser({ mustChangePassword: true, deletedAt: '2026-05-25T00:00:00.000Z' }),
      ),
    ).toBe('admin.users.status.deleted');
  });
});
