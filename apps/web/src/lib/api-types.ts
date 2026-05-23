/**
 * Wire-format types for the bunny2 HTTP API.
 *
 * Phase 2.6 chooses hand-written interfaces over importing the shared zod
 * schemas to keep the web bundle small and dependency-light. The shapes
 * mirror `packages/shared/src/auth.ts` and the response shapes assembled by
 * `apps/server/src/http/routes/*`. If they ever drift, the typecheck on
 * the server will catch a breaking change at compile time and the smoke
 * test will catch a runtime mismatch.
 */

export interface SafeUser {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly mustChangePassword: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly version: number;
}

export interface SafeGroup {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly version: number;
}

export interface LoginResponse {
  readonly user: SafeUser;
  readonly mustChangePassword: boolean;
  readonly sessionExpiresAt: string;
}

export interface MeResponse {
  readonly user: SafeUser;
  readonly mustChangePassword: boolean;
  readonly isAdmin: boolean;
  readonly sessionExpiresAt: string;
}

export interface AdminUserRow extends SafeUser {
  readonly directGroupIds: readonly string[];
}

export interface AdminUserListResponse {
  readonly users: readonly AdminUserRow[];
}

export interface AdminUserDetailResponse {
  readonly user: SafeUser;
  readonly directGroups: readonly SafeGroup[];
}

export interface AdminUserCreateResponse {
  readonly user: SafeUser;
  readonly generatedPassword?: string;
}

export interface AdminResetPasswordResponse {
  readonly ok: true;
  readonly generatedPassword?: string;
}

export interface AdminGroupRow extends SafeGroup {
  readonly directUserMemberCount: number;
  readonly directSubGroupCount: number;
}

export interface AdminGroupListResponse {
  readonly groups: readonly AdminGroupRow[];
}

export interface AdminGroupDetailResponse {
  readonly group: SafeGroup;
  readonly directUsers: readonly SafeUser[];
  readonly directSubGroups: readonly SafeGroup[];
  readonly parentGroups: readonly SafeGroup[];
}

export interface CreateUserPayload {
  readonly username: string;
  readonly displayName: string;
  readonly initialPassword?: string;
  readonly groupIds?: readonly string[];
}

export interface UpdateUserPayload {
  readonly displayName?: string;
  readonly groupIds?: readonly string[];
}

export interface CreateGroupPayload {
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
}

export interface UpdateGroupPayload {
  readonly name?: string;
  readonly description?: string | null;
}
