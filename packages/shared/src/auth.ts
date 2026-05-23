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
  sessionExpiresAt: z.string(),
});
export type LoginResponse = z.infer<typeof LoginResponseSchema>;

/**
 * Response shape for `GET /auth/me`. The `isAdmin` flag reflects direct
 * admin-group membership in phase 2.3; phase 2.4 switches to transitive
 * resolution. Callers should treat the flag as the source of truth and
 * not re-derive it from the user's group list.
 */
export const MeResponseSchema = z.object({
  user: UserSchema,
  mustChangePassword: z.boolean(),
  isAdmin: z.boolean(),
  sessionExpiresAt: z.string(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * Structural schema for the change-password request. The minimum-length
 * floor here (8) is a structural sanity check; the policy floor (length
 * 12 + non-letter) is enforced in the `/auth/password` route handler and
 * returns the `errors.auth.weakPassword` i18n key on rejection. We keep
 * the structural check loose so a 2.5 admin-set initial password can
 * share the same `min(8)` floor without tightening this schema for
 * everyone — see `docs/dev/architecture/auth-and-sessions.md`.
 */
export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).optional(),
  newPassword: z.string().min(8),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/**
 * `POST /admin/users` payload.
 *
 * - `username` regex `^[a-zA-Z0-9._-]{3,32}$` — 3..32 chars, letters,
 *   digits, dot, underscore, hyphen. The server lowercase-normalizes
 *   on insert (the `users.username` column uses NOCASE collation so
 *   case-insensitive uniqueness is enforced) but the schema tolerates
 *   any-case so the client error stays predictable.
 * - `displayName` 1..100 chars.
 * - `initialPassword` is OPTIONAL. When absent the server generates a
 *   24-char random password and includes it in the response body
 *   exactly once (it is never published to the bus). The structural
 *   `min(8)` floor here matches `ChangePasswordRequestSchema`; the
 *   policy floor (min 12 + non-letter) is enforced in the route via
 *   `validateNewPassword` so admin-set passwords share the bar with
 *   self-rotated ones.
 * - `groupIds` is an optional list of direct group memberships. Unknown
 *   ids are rejected with `errors.admin.userUnknownGroup`.
 */
export const CreateUserRequestSchema = z.object({
  username: z
    .string()
    .regex(
      /^[a-zA-Z0-9._-]{3,32}$/,
      'username must be 3..32 chars: letters, digits, dot, underscore, hyphen',
    ),
  displayName: z.string().min(1).max(100),
  initialPassword: z.string().min(8).optional(),
  groupIds: z.array(z.string().uuid()).optional(),
});
export type CreateUserRequest = z.infer<typeof CreateUserRequestSchema>;

/**
 * `PATCH /admin/users/:id` payload. Partial update: at least one of
 * `displayName` or `groupIds` must be present. `groupIds` REPLACES the
 * user's direct memberships with this exact list (the route computes
 * the diff and emits `group.member_added` / `group.member_removed`
 * events accordingly).
 */
export const UpdateUserRequestSchema = z
  .object({
    displayName: z.string().min(1).max(100).optional(),
    groupIds: z.array(z.string().uuid()).optional(),
  })
  .refine(
    (v) => v.displayName !== undefined || v.groupIds !== undefined,
    'at least one of displayName, groupIds must be present',
  );
export type UpdateUserRequest = z.infer<typeof UpdateUserRequestSchema>;

/**
 * `POST /admin/users/:id/reset-password` payload. `newPassword` is
 * optional; when absent, the server generates a 24-char random one and
 * returns it in the response exactly once. When present, the route
 * validates against the same policy floor as self-rotation.
 */
export const ResetPasswordRequestSchema = z.object({
  newPassword: z.string().min(8).optional(),
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;

export const CreateGroupRequestSchema = z.object({
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'slug must be lowercase alphanumeric with dashes'),
  name: z.string().min(1),
  description: z.string().optional(),
});
export type CreateGroupRequest = z.infer<typeof CreateGroupRequestSchema>;

/**
 * Patch for `PATCH /admin/groups/:id`. `slug` is deliberately omitted —
 * other code (the admin seed, the `requireAdmin` middleware) keys off
 * the `admin` slug and we don't support renaming. Description can be
 * cleared by passing `null`.
 */
export const UpdateGroupRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
  })
  .refine(
    (v) => v.name !== undefined || v.description !== undefined,
    'at least one of name, description must be present',
  );
export type UpdateGroupRequest = z.infer<typeof UpdateGroupRequestSchema>;

/**
 * `POST /admin/groups/:id/members` — exactly one of `userId` / `groupId`.
 * The route handler enforces the xor; this schema validates each shape.
 */
export const AddGroupMemberRequestSchema = z
  .object({
    userId: z.string().uuid().optional(),
    groupId: z.string().uuid().optional(),
  })
  .refine(
    (v) => (v.userId === undefined) !== (v.groupId === undefined),
    'exactly one of userId or groupId must be provided',
  );
export type AddGroupMemberRequest = z.infer<typeof AddGroupMemberRequestSchema>;
