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

/**
 * Row returned by `GET /layers/:slug/visibility`. `relation` says
 * which side the queried layer sits on:
 *   - `parent` — the layer is the CHILD; the row describes a parent
 *     it inherits FROM.
 *   - `child`  — the layer is the PARENT; the row describes a child
 *     layer that is inherited BY it.
 * `parentLayerId/parentSlug/parentName` always describe the "other"
 * layer in the edge regardless of the relation; the UI labels each
 * sub-section accordingly.
 */
export interface LayerVisibilityListItem {
  readonly relation: 'parent' | 'child';
  readonly parentLayerId: string;
  readonly parentSlug: string;
  readonly parentName: string;
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
  /**
   * Per-kind extras projected by `EntityModule.summaryColumns` on the
   * server (companies-list-columns follow-up). Absent for kinds that
   * don't declare summary columns; the caller treats missing as an
   * empty object. Values are JSON-serialisable but otherwise
   * untyped at this layer — per-kind consumers narrow as needed.
   */
  readonly extras?: Readonly<Record<string, unknown>>;
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

// ---------- calendar events (phase 4c.5) ------------------------------------

export type CalendarAttendeeStatus = 'accepted' | 'declined' | 'tentative' | 'needs_action';

export interface CalendarAttendee {
  readonly value: string;
  readonly displayName?: string;
  readonly contactEntityId?: string;
  readonly status: CalendarAttendeeStatus;
}

export interface CalendarEventPayload {
  readonly summary?: string;
  readonly description?: string;
  readonly location?: string;
  readonly startsAt: string;
  readonly endsAt?: string;
  readonly allDay?: boolean;
  readonly rruleString?: string;
  readonly attendees?: readonly CalendarAttendee[];
  readonly conferenceUrl?: string;
  readonly externalCalendarId?: string;
  readonly meetingSummaryNote?: string;
}

export type CalendarEvent = Entity<CalendarEventPayload>;

export interface CreateCalendarEventPayload {
  readonly title: string;
  readonly slug?: string;
  readonly originalLocale: string;
  readonly payload: CalendarEventPayload;
}

export interface UpdateCalendarEventPayload {
  readonly title?: string;
  readonly payload: CalendarEventPayload;
}

export interface GoogleCalendarSyncResult {
  readonly created: number;
  readonly updated: number;
  readonly warnings: readonly string[];
}

// ---------- todos (phase 4d.5) ---------------------------------------------

export type TodoStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
/** 1 = highest, 5 = lowest, 3 = normal default. */
export type TodoPriority = 1 | 2 | 3 | 4 | 5;
export type TodoLinkedEntityKind = 'company' | 'contact';

export interface TodoLinkedEntityRef {
  readonly kind: TodoLinkedEntityKind;
  readonly entityId: string;
}

export interface TodoPayload {
  readonly description?: string;
  readonly status: TodoStatus;
  readonly priority: TodoPriority;
  readonly dueAt?: string;
  readonly linkedEntityRef?: TodoLinkedEntityRef;
  readonly completedAt?: string;
  readonly tags?: readonly string[];
}

export type Todo = Entity<TodoPayload>;

export interface CreateTodoPayload {
  readonly title: string;
  readonly slug?: string;
  readonly originalLocale: string;
  readonly payload: TodoPayload;
}

export interface UpdateTodoPayload {
  readonly title?: string;
  readonly payload: TodoPayload;
}

// ---------- whiteboards (phase 11.5) ---------------------------------------
//
// Hand-mirrored from `packages/shared/src/whiteboards.ts`. The scene
// shape is intentionally opaque per ADR 0028 — Excalidraw owns the
// element schema, the web client passes the JSON straight back into
// the canvas without inspecting individual elements.

export interface ExcalidrawElement {
  readonly version: number;
  readonly type: string;
  readonly id: string;
  readonly [key: string]: unknown;
}

export interface ExcalidrawFileEntry {
  readonly id: string;
  readonly mimeType: string;
  readonly dataURL: string;
  readonly created: number;
  readonly lastRetrieved?: number;
}

export interface ExcalidrawScene {
  readonly elements: readonly ExcalidrawElement[];
  readonly appState?: unknown;
}

export interface WhiteboardPayload {
  readonly scene: ExcalidrawScene;
  readonly files: Readonly<Record<string, ExcalidrawFileEntry>>;
}

export type Whiteboard = Entity<WhiteboardPayload>;

export interface CreateWhiteboardPayload {
  readonly title: string;
  readonly slug?: string;
  readonly originalLocale: string;
  readonly payload: WhiteboardPayload;
}

export interface UpdateWhiteboardPayload {
  readonly title?: string;
  readonly payload: WhiteboardPayload;
}

/**
 * Phase 11.5 — checkpoint PATCH body carrying the scene + thumbnail
 * bytes the web build rendered via Excalidraw's `exportToBlob`. The
 * server accepts the bytes (base64-encoded) and writes them to the
 * `whiteboards.thumbnail_blob` BLOB column inside the same logical
 * checkpoint as the scene update. The `etag` is opaque to the
 * server — recommended shape is SHA-256 hex of the bytes.
 */
export interface WhiteboardCheckpointPayload {
  readonly title?: string;
  readonly payload: WhiteboardPayload;
  readonly thumbnailBlobBase64?: string;
  readonly thumbnailEtag?: string;
}

export interface WhiteboardListWithThumbnailItem {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly lastCheckpointAt: string | null;
  readonly elementCount: number;
  readonly thumbnailBlobBase64: string | null;
}

// ---------- scheduled tasks (phase 5.6) ------------------------------------
//
// Hand-mirrored from `packages/shared/src/scheduled-tasks.ts` per the
// same rationale as the rest of this file — we keep the web bundle
// zod-free; the server's zod parse is the authoritative validator.

export type ScheduledTaskStatus = 'active' | 'paused' | 'canceled';
export type ScheduledTaskPauseReason = 'manual' | 'max_attempts';
export type ScheduledTaskRunStatus =
  | 'requested'
  | 'started'
  | 'succeeded'
  | 'failed'
  | 'skipped_offline'
  | 'skipped_no_handler'
  | 'skipped_crashed';
export type ScheduledTaskRunTrigger = 'schedule' | 'manual' | 'retry';

export interface CronSchedule {
  readonly kind: 'cron';
  readonly cronExpression: string;
  readonly cronTimezone: string;
}

export interface IntervalSchedule {
  readonly kind: 'interval';
  readonly intervalMinutes: number;
}

export type ScheduledTaskSchedule = CronSchedule | IntervalSchedule;

export interface ScheduledTaskSummary {
  readonly id: string;
  readonly layerId: string;
  readonly slug: string;
  readonly kind: string;
  readonly name: string;
  readonly status: ScheduledTaskStatus;
  readonly pauseReason: ScheduledTaskPauseReason | null;
  readonly schedule: ScheduledTaskSchedule;
  readonly maxAttempts: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  readonly nextRunAt: string;
  readonly lastRunAt: string | null;
  readonly attempt: number;
  readonly version: number;
  readonly createdAt: string;
  readonly createdBy: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly deletedAt: string | null;
}

export interface ScheduledTaskRunSummary {
  readonly id: string;
  readonly taskId: string;
  readonly status: ScheduledTaskRunStatus;
  readonly attempt: number;
  readonly triggeredBy: ScheduledTaskRunTrigger;
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly correlationId: string | null;
}

/** Recent-runs widget row — `ScheduledTaskRunSummary` + task hints. */
export interface ScheduledTaskRecentRun extends ScheduledTaskRunSummary {
  readonly taskSlug: string;
  readonly taskName: string;
}

export interface ScheduledTaskHandlerInfo {
  readonly kind: string;
  readonly defaultSchedule?: ScheduledTaskSchedule;
}

export interface CreateScheduledTaskPayload {
  readonly name: string;
  readonly slug?: string;
  readonly kind: string;
  readonly schedule: ScheduledTaskSchedule;
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly config?: Record<string, unknown>;
}

export interface UpdateScheduledTaskPayload {
  readonly name?: string;
  readonly schedule?: ScheduledTaskSchedule;
  readonly status?: 'active' | 'paused';
  readonly maxAttempts?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
  readonly config?: Record<string, unknown>;
}

/** Admin DLQ list row from `GET /admin/bus/dlq`. */
export interface AdminBusDlqRow {
  readonly id: string;
  readonly outboxId: string;
  readonly subscriberKey: string;
  readonly eventType: string;
  readonly payloadPreview: string;
  readonly attempts: number;
  readonly error: string;
  readonly failedAt: string;
}

/** Admin cross-layer task row from `GET /admin/scheduled-tasks`. */
export interface AdminScheduledTaskRow extends ScheduledTaskSummary {
  readonly layerSlug: string;
}
