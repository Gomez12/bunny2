import { z } from 'zod';

/**
 * Cross-package zod schemas for the auth domain.
 *
 * Server-internal types (which carry `passwordHash` and `tokenHash`) live in
 * `apps/server/src/repos/*`. These schemas describe the safe shape that
 * crosses the HTTP boundary and is shared with the web client.
 *
 * Timestamps are ISO-8601 strings (`toISOString()`). We deliberately avoid
 * `z.string().datetime()` here — the constraint is strict in subtle ways
 * and we already control the producers.
 */

export const UserSchema = z.object({
  id: z.string().uuid(),
  username: z.string().min(1),
  displayName: z.string().min(1),
  mustChangePassword: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  version: z.number().int().positive(),
});
export type User = z.infer<typeof UserSchema>;

export const GroupSchema = z.object({
  id: z.string().uuid(),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  version: z.number().int().positive(),
});
export type Group = z.infer<typeof GroupSchema>;

export const SessionSchema = z.object({
  id: z.string().uuid(),
  userId: z.string().uuid(),
  createdAt: z.string(),
  lastSeenAt: z.string(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});
export type Session = z.infer<typeof SessionSchema>;

// ---------- request / response payloads (consumed by 2.3 / 2.5) ----------

export const LoginRequestSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;

export const LoginResponseSchema = z.object({
  user: UserSchema,
  mustChangePassword: z.boolean(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

export const CreateUserRequestSchema = z.object({
  username: z.string().min(1),
  displayName: z.string().min(1),
  initialPassword: z.string().min(8).optional(),
  groupIds: z.array(z.string().uuid()).optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

export const CreateGroupRequestSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric with dashes'),
  name: z.string().min(1),
  description: z.string().optional(),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;
