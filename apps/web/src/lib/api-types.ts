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

// ---------- entities (phase 4.0 + 4a.5) -------------------------------------

/**
 * Audit + bookkeeping metadata every entity carries. Mirrors
 * `EntityMetaSchema` in `packages/shared/src/entity.ts` — kept as a
 * hand-written interface here so the web bundle does not depend on
 * `zod` at runtime (same rationale as the rest of this file).
 */
export interface EntityMeta {
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly deletedAt: string | null;
  readonly deletedBy: string | null;
  readonly version: number;
  readonly originalLocale: string;
}

export type EntitySyncState = 'idle' | 'syncing' | 'error';

export interface EntityExternalLink {
  readonly id: string;
  readonly connector: string;
  readonly externalId: string;
  readonly syncState: EntitySyncState;
  readonly syncedAt: string | null;
  readonly error: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface EntitySummary {
  readonly id: string;
  readonly kind: string;
  readonly layerId: string;
  readonly slug: string;
  readonly meta: EntityMeta;
  readonly title: string;
  readonly subtitle: string | null;
  readonly searchableText: string;
}

export interface Entity<Payload> extends EntitySummary {
  readonly payload: Payload;
  readonly externalLinks: readonly EntityExternalLink[];
  readonly translations?: Readonly<Record<string, Payload>>;
}

// ---------- companies (phase 4a.5) ------------------------------------------

export interface CompanyAddress {
  readonly street?: string;
  readonly houseNumber?: string;
  readonly postalCode?: string;
  readonly city?: string;
  readonly country?: string;
}

export interface CompanyPayload {
  readonly legalName?: string;
  readonly tradeName?: string;
  readonly kvkNumber?: string;
  readonly website?: string;
  readonly address?: CompanyAddress;
  readonly phone?: string;
  readonly email?: string;
  readonly industry?: string;
  readonly description?: string;
}

export type Company = Entity<CompanyPayload>;

export interface CreateCompanyPayload {
  readonly title: string;
  readonly slug?: string;
  readonly originalLocale: string;
  readonly payload: CompanyPayload;
}

export interface UpdateCompanyPayload {
  readonly title?: string;
  readonly payload: CompanyPayload;
}

export interface AddCompanyExternalLinkPayload {
  readonly connector: string;
  readonly externalId: string;
  readonly payload?: Record<string, unknown>;
}

// ---------- contacts (phase 4b.5) -------------------------------------------

export interface ContactEmail {
  readonly value: string;
  readonly label?: string;
  readonly isPrimary?: boolean;
}

export interface ContactPhone {
  readonly value: string;
  readonly label?: string;
  readonly isPrimary?: boolean;
}

export interface ContactPayload {
  readonly givenName?: string;
  readonly familyName?: string;
  readonly displayName?: string;
  readonly emails?: readonly ContactEmail[];
  readonly phones?: readonly ContactPhone[];
  readonly companyEntityId?: string;
  readonly jobTitle?: string;
  readonly notes?: string;
  readonly birthday?: string;
}

export type Contact = Entity<ContactPayload>;

export interface CreateContactPayload {
  readonly title: string;
  readonly slug?: string;
  readonly originalLocale: string;
  readonly payload: ContactPayload;
}

export interface UpdateContactPayload {
  readonly title?: string;
  readonly payload: ContactPayload;
}
