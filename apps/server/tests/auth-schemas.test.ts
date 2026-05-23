import { describe, expect, it } from 'bun:test';
import {
  ChangePasswordRequestSchema,
  CreateGroupRequestSchema,
  CreateUserRequestSchema,
  GroupSchema,
  LoginRequestSchema,
  LoginResponseSchema,
  SessionSchema,
  UserSchema,
} from '@bunny2/shared';

const validUser = {
  id: crypto.randomUUID(),
  username: 'alice',
  displayName: 'Alice',
  mustChangePassword: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  version: 1,
};

describe('@bunny2/shared auth schemas', () => {
  it('parses a valid User', () => {
    expect(UserSchema.parse(validUser)).toEqual(validUser);
  });

  it('rejects a User without a uuid id', () => {
    expect(() => UserSchema.parse({ ...validUser, id: 'not-a-uuid' })).toThrow();
  });

  it('parses a valid Group', () => {
    const g = {
      id: crypto.randomUUID(),
      slug: 'engineering',
      name: 'Engineering',
      description: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      deletedAt: null,
      version: 1,
    };
    expect(GroupSchema.parse(g)).toEqual(g);
  });

  it('parses a valid Session', () => {
    const s = {
      id: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      createdAt: '2026-01-01T00:00:00.000Z',
      lastSeenAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-15T00:00:00.000Z',
      revokedAt: null,
    };
    expect(SessionSchema.parse(s)).toEqual(s);
  });

  it('LoginRequest requires a non-empty username and password', () => {
    expect(LoginRequestSchema.parse({ username: 'a', password: 'b' })).toBeDefined();
    expect(() => LoginRequestSchema.parse({ username: '', password: 'b' })).toThrow();
  });

  it('LoginResponse round-trips', () => {
    const r = { user: validUser, mustChangePassword: true };
    expect(LoginResponseSchema.parse(r)).toEqual(r);
  });

  it('ChangePasswordRequest requires newPassword ≥ 8 chars', () => {
    expect(() => ChangePasswordRequestSchema.parse({ newPassword: 'short' })).toThrow();
    expect(ChangePasswordRequestSchema.parse({ newPassword: 'long-enough' })).toBeDefined();
  });

  it('CreateUserRequest accepts minimal payload', () => {
    expect(CreateUserRequestSchema.parse({ username: 'eve', displayName: 'Eve' })).toBeDefined();
  });

  it('CreateGroupRequest enforces a lowercase-slug pattern', () => {
    expect(
      CreateGroupRequestSchema.parse({ slug: 'engineering', name: 'Engineering' }),
    ).toBeDefined();
    expect(() =>
      CreateGroupRequestSchema.parse({ slug: 'Engineering', name: 'Engineering' }),
    ).toThrow();
    expect(() => CreateGroupRequestSchema.parse({ slug: 'has space', name: 'X' })).toThrow();
  });
});
