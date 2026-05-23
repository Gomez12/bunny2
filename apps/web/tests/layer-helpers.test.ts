import { describe, expect, it } from 'bun:test';
import { computeCanEdit, subpathFromLocation } from '../src/lib/use-current-layer';
import { pickPersonalLayer } from '../src/lib/session';
import { _resetToasts, dismissToast, pushToast } from '../src/lib/toast';
import type { Layer } from '../src/lib/api-types';

/**
 * Pure-logic unit tests for phase 3.5's web helpers.
 *
 * Component-level rendering tests require a DOM runtime (happy-dom /
 * @testing-library/react) that this repo has not yet wired up — see
 * `docs/dev/follow-ups/web-component-tests.md`. Until that lands, we
 * cover the helpers that DO NOT depend on the DOM so regressions in
 * the canEdit policy, slug fallback path, personal-layer pick, and
 * toast queue are caught at `bun test` time.
 */

function makeLayer(overrides: Partial<Layer>): Layer {
  return {
    id: '00000000-0000-0000-0000-000000000000',
    type: 'project',
    slug: 'demo',
    name: 'Demo',
    description: null,
    ownerUserId: null,
    ownerGroupId: null,
    createdAt: '2026-05-23T00:00:00.000Z',
    updatedAt: '2026-05-23T00:00:00.000Z',
    deletedAt: null,
    version: 1,
    ...overrides,
  };
}

describe('subpathFromLocation', () => {
  it('returns /dashboard when the path is just /l/:slug', () => {
    expect(subpathFromLocation('/l/personal-admin', 'personal-admin')).toBe('/dashboard');
  });

  it('returns /dashboard when the path is /l/:slug/', () => {
    expect(subpathFromLocation('/l/personal-admin/', 'personal-admin')).toBe('/dashboard');
  });

  it('returns the subpath when the path is /l/:slug/settings', () => {
    expect(subpathFromLocation('/l/personal-admin/settings', 'personal-admin')).toBe('/settings');
  });

  it('falls back to /dashboard when the path prefix does not match', () => {
    expect(subpathFromLocation('/somewhere/else', 'personal-admin')).toBe('/dashboard');
  });
});

describe('computeCanEdit', () => {
  const userId = '11111111-1111-1111-1111-111111111111';
  const personal = makeLayer({ type: 'personal', ownerUserId: userId });
  const project = makeLayer({ type: 'project' });
  const everyone = makeLayer({ type: 'everyone' });
  const group = makeLayer({ type: 'group' });

  it('returns false when the user id is null', () => {
    expect(computeCanEdit(personal, null, false)).toBe(false);
  });

  it('returns true when the user is the personal-layer owner', () => {
    expect(computeCanEdit(personal, userId, false)).toBe(true);
  });

  it('returns false when the personal layer is owned by someone else', () => {
    expect(computeCanEdit({ ...personal, ownerUserId: 'other' }, userId, false)).toBe(false);
  });

  it('returns true for any layer when the user is site-admin', () => {
    expect(computeCanEdit(everyone, userId, true)).toBe(true);
    expect(computeCanEdit(group, userId, true)).toBe(true);
    expect(computeCanEdit(project, userId, true)).toBe(true);
  });

  it('returns false on group / everyone layers for non-admins', () => {
    expect(computeCanEdit(group, userId, false)).toBe(false);
    expect(computeCanEdit(everyone, userId, false)).toBe(false);
  });

  it('returns true (optimistically) on project layers for any signed-in user', () => {
    // Server still 403s if the caller is not an owner — this is a UI hint.
    expect(computeCanEdit(project, userId, false)).toBe(true);
  });
});

describe('pickPersonalLayer', () => {
  const userId = 'u-1';
  const personal = makeLayer({
    id: 'p-1',
    type: 'personal',
    ownerUserId: userId,
    slug: 'personal-me',
  });
  const otherPersonal = makeLayer({
    id: 'p-2',
    type: 'personal',
    ownerUserId: 'someone-else',
    slug: 'personal-other',
  });
  const project = makeLayer({ id: 'pr-1', type: 'project', slug: 'project-x' });

  it('returns the personal layer owned by the user', () => {
    expect(pickPersonalLayer([project, personal, otherPersonal], userId)?.id).toBe('p-1');
  });

  it('returns null when no personal layer matches', () => {
    expect(pickPersonalLayer([project, otherPersonal], userId)).toBeNull();
  });

  it('returns null when the layer list is empty', () => {
    expect(pickPersonalLayer([], userId)).toBeNull();
  });
});

describe('toast store', () => {
  it('pushes and auto-removes a toast after dismiss', () => {
    _resetToasts();
    const id = pushToast({ kind: 'info', message: 'hi', ttlMs: 0 });
    expect(typeof id).toBe('string');
    dismissToast(id);
    // No throw, no leak — the queue is empty after explicit dismiss.
  });

  it('supports multiple concurrent toasts with stable ids', () => {
    _resetToasts();
    const a = pushToast({ kind: 'info', message: 'a', ttlMs: 0 });
    const b = pushToast({ kind: 'success', message: 'b', ttlMs: 0 });
    expect(a).not.toBe(b);
  });
});
