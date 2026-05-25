/**
 * Phase 2 (UI exposure gaps) — sole-owner guard predicate.
 *
 * Pure-logic smoke for the Members tab Remove button. The component
 * itself is exercised by the manual smoke flow; this test pins the
 * counting rule (users + groups, owner role only).
 */
import { describe, expect, it } from 'bun:test';
import type {
  LayerGroupMemberRow,
  LayerMembersResponse,
  LayerUserMemberRow,
  SafeGroup,
  SafeUser,
} from '../src/lib/api-types';
import { isSoleOwner } from '../src/pages/layer-members-state';

function makeUser(id: string, username: string): SafeUser {
  return {
    id,
    username,
    displayName: username,
    mustChangePassword: false,
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

function makeGroup(id: string, slug: string): SafeGroup {
  return {
    id,
    slug,
    name: slug,
    description: null,
    createdAt: '2026-05-25T00:00:00.000Z',
    updatedAt: '2026-05-25T00:00:00.000Z',
    deletedAt: null,
    version: 1,
  };
}

function userRow(id: string, role: 'owner' | 'member'): LayerUserMemberRow {
  return {
    userId: id,
    role,
    createdAt: '2026-05-25T00:00:00.000Z',
    user: makeUser(id, `u-${id}`),
  };
}

function groupRow(id: string, role: 'owner' | 'member'): LayerGroupMemberRow {
  return {
    groupId: id,
    role,
    createdAt: '2026-05-25T00:00:00.000Z',
    group: makeGroup(id, `g-${id}`),
  };
}

describe('isSoleOwner', () => {
  it('returns true when the actor is the only owner row across users + groups', () => {
    const members: LayerMembersResponse = {
      users: [userRow('alice', 'owner'), userRow('bob', 'member')],
      groups: [],
    };
    expect(isSoleOwner('alice', members)).toBe(true);
  });

  it('returns false when another user holds the owner role', () => {
    const members: LayerMembersResponse = {
      users: [userRow('alice', 'owner'), userRow('bob', 'owner')],
      groups: [],
    };
    expect(isSoleOwner('alice', members)).toBe(false);
  });

  it('returns false when a group also holds the owner role', () => {
    const members: LayerMembersResponse = {
      users: [userRow('alice', 'owner')],
      groups: [groupRow('eng', 'owner')],
    };
    expect(isSoleOwner('alice', members)).toBe(false);
  });

  it('returns false when the actor is a member, not an owner', () => {
    const members: LayerMembersResponse = {
      users: [userRow('alice', 'owner'), userRow('bob', 'member')],
      groups: [],
    };
    expect(isSoleOwner('bob', members)).toBe(false);
  });

  it('returns false when the actor is not in the member list at all', () => {
    const members: LayerMembersResponse = {
      users: [userRow('alice', 'owner')],
      groups: [],
    };
    expect(isSoleOwner('mallory', members)).toBe(false);
  });
});
