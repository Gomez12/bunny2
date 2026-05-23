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

// ---------- layers (phase 3.5) ---------------------------------------------

export type LayerType = 'personal' | 'project' | 'group' | 'everyone';
export type LayerVisibilityDirection = 'top_down' | 'bottom_up' | 'both';
export type LayerAttachmentKind = 'agent' | 'skill' | 'mcp_server';

export interface Layer {
  readonly id: string;
  readonly type: LayerType;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly ownerUserId: string | null;
  readonly ownerGroupId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
  readonly version: number;
}

export interface LayerListResponse {
  readonly layers: readonly Layer[];
}

export interface LayerDetailResponse {
  readonly layer: Layer;
}

export interface LayerUserMember {
  readonly layerId: string;
  readonly userId: string;
  readonly role: string;
  readonly createdAt: string;
}

export interface LayerGroupMember {
  readonly layerId: string;
  readonly groupId: string;
  readonly role: string;
  readonly createdAt: string;
}

export interface LayerLocale {
  readonly layerId: string;
  readonly locale: string;
  readonly isDefault: boolean;
  readonly createdAt: string;
}

export interface LayerAttachment {
  readonly id: string;
  readonly layerId: string;
  readonly kind: LayerAttachmentKind;
  readonly refId: string;
  readonly config: Record<string, unknown>;
  readonly createdAt: string;
}

export interface LayerVisibilityEdge {
  readonly parentLayerId: string;
  readonly childLayerId: string;
  readonly direction: LayerVisibilityDirection;
  readonly createdAt: string;
}

export interface CreateLayerPayload {
  readonly type: 'project';
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
}

export interface UpdateLayerPayload {
  readonly name?: string;
  readonly description?: string | null;
}

export interface AddLayerMemberPayload {
  readonly userId?: string;
  readonly groupId?: string;
  readonly role?: 'member' | 'owner';
}

export interface AddLayerVisibilityPayload {
  readonly parentSlug: string;
  readonly direction: 'bottom_up';
}

export interface SetLayerLocalesPayload {
  readonly locales: readonly string[];
  readonly defaultLocale?: string;
}

export interface RegisterLayerAttachmentPayload {
  readonly kind: LayerAttachmentKind;
  readonly refId: string;
  readonly config?: Record<string, unknown>;
}

export interface SystemLocalesResponse {
  readonly locales: readonly string[];
  readonly default: string;
}

export interface ListLayersQuery {
  readonly type?: LayerType;
  readonly search?: string;
  readonly includeDeleted?: boolean;
}
