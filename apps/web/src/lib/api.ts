/**
 * Thin client for the bunny2 server.
 *
 * Each function returns parsed JSON or throws an {@link ApiError} that the
 * UI layer can map to an i18n key. Every request includes
 * `credentials: 'include'` so the HttpOnly session cookie set by
 * `POST /auth/login` flows on subsequent calls.
 *
 * The base URL is resolved in this order:
 *   1. `window.bunny2.apiBase` — injected by the Electron preload at the
 *      port the main process pre-probed for the sidecar (phase 1.6).
 *   2. `import.meta.env.VITE_API_BASE` — for Vite dev / standalone web.
 *   3. `http://127.0.0.1:4317` — matches `apps/server/src/config/schema.ts`.
 */

import type {
  ChatBoardItem as SharedChatBoardItem,
  ChatConversation as SharedChatConversation,
  ChatConversationSummary as SharedChatConversationSummary,
  ChatMessage as SharedChatMessage,
  ChatMessageFeedback as SharedChatMessageFeedback,
  ChatFeedbackValue as SharedChatFeedbackValue,
} from '@bunny2/shared';
import type {
  AddCompanyExternalLinkPayload,
  AddLayerMemberPayload,
  AddLayerVisibilityPayload,
  AdminBusDlqRow,
  AdminGroupDetailResponse,
  AdminGroupListResponse,
  AdminGroupRow,
  AdminResetPasswordResponse,
  AdminScheduledTaskRow,
  AdminUserCreateResponse,
  AdminUserDetailResponse,
  AdminUserListResponse,
  AdminUserRow,
  CalendarEvent,
  Company,
  Contact,
  CreateCalendarEventPayload,
  CreateCompanyPayload,
  CreateContactPayload,
  CreateGroupPayload,
  CreateLayerPayload,
  CreateScheduledTaskPayload,
  CreateTodoPayload,
  CreateUserPayload,
  EntityExternalLink,
  EntitySummary,
  GoogleCalendarSyncResult,
  Layer,
  LayerAttachment,
  LayerDetailResponse,
  LayerListResponse,
  LayerLocale,
  LayerVisibilityListItem,
  ListLayersQuery,
  LoginResponse,
  MeResponse,
  RegisterLayerAttachmentPayload,
  SafeGroup,
  SafeUser,
  ScheduledTaskHandlerInfo,
  ScheduledTaskRecentRun,
  ScheduledTaskRunSummary,
  ScheduledTaskSummary,
  SetLayerLocalesPayload,
  SystemLocalesResponse,
  Todo,
  UpdateCalendarEventPayload,
  UpdateCompanyPayload,
  UpdateContactPayload,
  UpdateGroupPayload,
  UpdateLayerPayload,
  UpdateScheduledTaskPayload,
  UpdateTodoPayload,
  UpdateUserPayload,
} from './api-types';
import {
  calendarServerBase,
  calendarServerDetail,
  calendarServerGoogleIngest,
} from './calendar-routes';
import {
  companiesServerBase,
  companyServerDetail,
  companyServerExternalLink,
  companyServerExternalLinks,
} from './companies-routes';
import { contactServerDetail, contactsServerBase } from './contacts-routes';
import { todoServerDetail, todosServerBase } from './todos-routes';

interface BunnyBridge {
  readonly apiBase: string;
}

function readBridgeApiBase(): string | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { bunny2?: BunnyBridge };
  const base = w.bunny2?.apiBase;
  return typeof base === 'string' && base.length > 0 ? base : null;
}

export const apiBase: string =
  readBridgeApiBase() ?? ((import.meta.env.VITE_API_BASE ?? 'http://127.0.0.1:4317') as string);

export interface StatusResponse {
  readonly app: string;
  readonly version: string;
  readonly phase: string;
  readonly ok: boolean;
  readonly dataDir: string;
  readonly configFile: string | null;
  readonly sqlite: { readonly schemaVersion: string | null };
  readonly lancedb: { readonly ready: boolean; readonly tables: readonly string[] };
  readonly bus: { readonly adapter: string; readonly events: number };
  readonly llm: {
    readonly endpoint: string;
    readonly defaultModel: string;
    readonly calls: number;
  };
  readonly auth: {
    readonly sessions: number;
    readonly users: number;
    readonly groups: number;
  };
}

export interface ChatResponse {
  readonly content: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly correlationId: string;
}

export class ApiError extends Error {
  readonly errorKey: string;
  readonly status: number;
  constructor(errorKey: string, status: number, message?: string) {
    super(message ?? errorKey);
    this.name = 'ApiError';
    this.errorKey = errorKey;
    this.status = status;
  }
}

interface ErrorEnvelope {
  readonly error?: string;
}

async function parseJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function errorKeyFrom(body: ErrorEnvelope | null, status: number): string {
  if (body?.error !== undefined && body.error.length > 0) return body.error;
  if (status === 401) return 'errors.auth.unauthorized';
  if (status === 409) return 'errors.auth.mustChangePassword';
  return 'errors.network';
}

async function request<T>(
  path: string,
  init: RequestInit & { allow401AsNull?: boolean } = {},
): Promise<T> {
  const { allow401AsNull: _allow401AsNull, ...rest } = init;
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      credentials: 'include',
      ...rest,
      headers: {
        ...(rest.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(rest.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('errors.network', 0);
  }
  if (!res.ok) {
    const body = await parseJson<ErrorEnvelope>(res);
    throw new ApiError(errorKeyFrom(body, res.status), res.status);
  }
  const body = await parseJson<T>(res);
  if (body === null) {
    throw new ApiError('errors.network', res.status);
  }
  return body;
}

// ---------- status + chat (existing) ----------------------------------------

export async function fetchStatus(): Promise<StatusResponse> {
  return request<StatusResponse>('/status');
}

export async function postChat(input: { message: string; model?: string }): Promise<ChatResponse> {
  const body: { message: string; model?: string } = { message: input.message };
  if (input.model !== undefined && input.model.length > 0) body.model = input.model;
  return request<ChatResponse>('/chat', { method: 'POST', body: JSON.stringify(body) });
}

// ---------- auth ------------------------------------------------------------

export async function login(input: { username: string; password: string }): Promise<LoginResponse> {
  return request<LoginResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function logout(): Promise<void> {
  await request<{ ok: true }>('/auth/logout', { method: 'POST' });
}

export type MeResult =
  | { readonly kind: 'guest' }
  | { readonly kind: 'gated' }
  | { readonly kind: 'authenticated'; readonly me: MeResponse };

/**
 * `GET /auth/me`.
 *
 * - 200 → `'authenticated'` with the parsed body.
 * - 401 → `'guest'` (no active session).
 * - 409 with `errors.auth.mustChangePassword` → `'gated'`. The user IS
 *   authenticated but the password-rotation gate (`requirePasswordCurrent`)
 *   is blocking the `/me` body. The caller must keep whatever
 *   `mustChangePassword: true` state it already has from `applyLogin` — we
 *   surface this distinct kind so the bootstrap doesn't drop back to
 *   `'guest'` on a force-rotate session.
 * - Anything else → throws {@link ApiError}.
 */
export async function fetchMe(): Promise<MeResult> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/auth/me`, { credentials: 'include' });
  } catch {
    throw new ApiError('errors.network', 0);
  }
  if (res.status === 401) return { kind: 'guest' };
  if (res.status === 409) {
    const body = await parseJson<ErrorEnvelope>(res);
    if (body?.error === 'errors.auth.mustChangePassword') {
      return { kind: 'gated' };
    }
    throw new ApiError(errorKeyFrom(body, res.status), res.status);
  }
  if (!res.ok) {
    const body = await parseJson<ErrorEnvelope>(res);
    throw new ApiError(errorKeyFrom(body, res.status), res.status);
  }
  const body = await parseJson<MeResponse>(res);
  if (body === null) {
    throw new ApiError('errors.network', res.status);
  }
  return { kind: 'authenticated', me: body };
}

export async function changePassword(input: {
  currentPassword?: string;
  newPassword: string;
}): Promise<void> {
  const payload: { currentPassword?: string; newPassword: string } = {
    newPassword: input.newPassword,
  };
  if (input.currentPassword !== undefined) payload.currentPassword = input.currentPassword;
  await request<{ ok: true }>('/auth/password', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

// ---------- admin: users ----------------------------------------------------

export async function listAdminUsers(
  opts: {
    includeDeleted?: boolean;
  } = {},
): Promise<readonly AdminUserRow[]> {
  const qs = opts.includeDeleted === true ? '?includeDeleted=true' : '';
  const res = await request<AdminUserListResponse>(`/admin/users${qs}`);
  return res.users;
}

export async function getAdminUser(id: string): Promise<AdminUserDetailResponse> {
  return request<AdminUserDetailResponse>(`/admin/users/${encodeURIComponent(id)}`);
}

export async function createAdminUser(
  payload: CreateUserPayload,
): Promise<AdminUserCreateResponse> {
  return request<AdminUserCreateResponse>('/admin/users', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateAdminUser(
  id: string,
  payload: UpdateUserPayload,
): Promise<{ user: SafeUser }> {
  return request<{ user: SafeUser }>(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function deleteAdminUser(id: string): Promise<void> {
  await request<{ ok: true }>(`/admin/users/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function resetAdminUserPassword(
  id: string,
  payload: { newPassword?: string } = {},
): Promise<AdminResetPasswordResponse> {
  const body =
    payload.newPassword !== undefined
      ? JSON.stringify({ newPassword: payload.newPassword })
      : JSON.stringify({});
  return request<AdminResetPasswordResponse>(
    `/admin/users/${encodeURIComponent(id)}/reset-password`,
    { method: 'POST', body },
  );
}

// ---------- admin: groups ---------------------------------------------------

export async function listAdminGroups(
  opts: {
    includeDeleted?: boolean;
  } = {},
): Promise<readonly AdminGroupRow[]> {
  const qs = opts.includeDeleted === true ? '?includeDeleted=true' : '';
  const res = await request<AdminGroupListResponse>(`/admin/groups${qs}`);
  return res.groups;
}

export async function getAdminGroup(id: string): Promise<AdminGroupDetailResponse> {
  return request<AdminGroupDetailResponse>(`/admin/groups/${encodeURIComponent(id)}`);
}

export async function createAdminGroup(payload: CreateGroupPayload): Promise<{ group: SafeGroup }> {
  return request<{ group: SafeGroup }>('/admin/groups', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function updateAdminGroup(
  id: string,
  payload: UpdateGroupPayload,
): Promise<{ group: SafeGroup }> {
  return request<{ group: SafeGroup }>(`/admin/groups/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  });
}

export async function deleteAdminGroup(id: string): Promise<void> {
  await request<{ ok: true }>(`/admin/groups/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function addAdminGroupMember(
  groupId: string,
  payload: { userId: string } | { groupId: string },
): Promise<void> {
  await request<{ ok: true }>(`/admin/groups/${encodeURIComponent(groupId)}/members`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function removeAdminGroupMember(
  groupId: string,
  memberId: string,
  kind: 'user' | 'group',
): Promise<void> {
  await request<{ ok: true }>(
    `/admin/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(memberId)}?kind=${kind}`,
    { method: 'DELETE' },
  );
}

// ---------- layers (phase 3.5) ---------------------------------------------

/** `GET /me/layers` — caller's effective layer set, for the switcher. */
export async function getMyLayers(): Promise<readonly Layer[]> {
  const res = await request<LayerListResponse>('/me/layers');
  return res.layers;
}

/** `GET /layers` — same set as `/me/layers` with filter/sort knobs. */
export async function listLayers(params: ListLayersQuery = {}): Promise<readonly Layer[]> {
  const qs = new URLSearchParams();
  if (params.type !== undefined) qs.set('type', params.type);
  if (params.search !== undefined && params.search.length > 0) qs.set('search', params.search);
  if (params.includeDeleted === true) qs.set('includeDeleted', 'true');
  const suffix = qs.toString();
  const res = await request<LayerListResponse>(`/layers${suffix.length > 0 ? `?${suffix}` : ''}`);
  return res.layers;
}

export async function getLayer(slug: string): Promise<Layer> {
  const res = await request<LayerDetailResponse>(`/layers/${encodeURIComponent(slug)}`);
  return res.layer;
}

export async function createLayer(body: CreateLayerPayload): Promise<Layer> {
  const res = await request<LayerDetailResponse>('/layers', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.layer;
}

export async function updateLayer(slug: string, body: UpdateLayerPayload): Promise<Layer> {
  const res = await request<LayerDetailResponse>(`/layers/${encodeURIComponent(slug)}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return res.layer;
}

export async function deleteLayer(slug: string): Promise<void> {
  await request<{ ok: true }>(`/layers/${encodeURIComponent(slug)}`, { method: 'DELETE' });
}

export async function addLayerMember(slug: string, body: AddLayerMemberPayload): Promise<void> {
  await request<{ ok: true }>(`/layers/${encodeURIComponent(slug)}/members`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function removeLayerMember(slug: string, memberId: string): Promise<void> {
  await request<{ ok: true }>(
    `/layers/${encodeURIComponent(slug)}/members/${encodeURIComponent(memberId)}`,
    { method: 'DELETE' },
  );
}

// ---------- /me/visible-users + /me/visible-groups -------------------------
//
// Layer-members-picker follow-up: directory disclosure boundary for
// non-admins. Returns the union of users / groups the caller shares
// at least one transitive group with. Self excluded; soft-deleted
// excluded.

export interface VisibleUser {
  readonly id: string;
  readonly displayName: string;
}

export interface VisibleGroup {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export async function listVisibleUsers(): Promise<readonly VisibleUser[]> {
  const res = await request<{ users: readonly VisibleUser[] }>('/me/visible-users');
  return res.users;
}

export async function listVisibleGroups(): Promise<readonly VisibleGroup[]> {
  const res = await request<{ groups: readonly VisibleGroup[] }>('/me/visible-groups');
  return res.groups;
}

export async function addLayerVisibility(
  slug: string,
  body: AddLayerVisibilityPayload,
): Promise<void> {
  await request<{ ok: true }>(`/layers/${encodeURIComponent(slug)}/visibility`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function listLayerVisibility(
  slug: string,
): Promise<readonly LayerVisibilityListItem[]> {
  const res = await request<{ edges: readonly LayerVisibilityListItem[] }>(
    `/layers/${encodeURIComponent(slug)}/visibility`,
  );
  return res.edges;
}

export async function removeLayerVisibility(slug: string, parentSlug: string): Promise<void> {
  await request<{ ok: true }>(
    `/layers/${encodeURIComponent(slug)}/visibility/${encodeURIComponent(parentSlug)}`,
    { method: 'DELETE' },
  );
}

export async function setLayerLocales(
  slug: string,
  body: SetLayerLocalesPayload,
): Promise<readonly LayerLocale[]> {
  const res = await request<{ ok: true; locales: readonly LayerLocale[] }>(
    `/layers/${encodeURIComponent(slug)}/locales`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return res.locales;
}

export async function listLayerAttachments(slug: string): Promise<readonly LayerAttachment[]> {
  const res = await request<{ attachments: readonly LayerAttachment[] }>(
    `/layers/${encodeURIComponent(slug)}/attachments`,
  );
  return res.attachments;
}

export async function registerLayerAttachment(
  slug: string,
  body: RegisterLayerAttachmentPayload,
): Promise<LayerAttachment> {
  const res = await request<{ attachment: LayerAttachment }>(
    `/layers/${encodeURIComponent(slug)}/attachments`,
    { method: 'POST', body: JSON.stringify(body) },
  );
  return res.attachment;
}

export async function removeLayerAttachment(slug: string, attachmentId: string): Promise<void> {
  await request<{ ok: true }>(
    `/layers/${encodeURIComponent(slug)}/attachments/${encodeURIComponent(attachmentId)}`,
    { method: 'DELETE' },
  );
}

export async function getSystemLocales(): Promise<SystemLocalesResponse> {
  return request<SystemLocalesResponse>('/system/locales');
}

// ---------- entity stats (phase 4a.4 — companies widget) -------------------

/**
 * Companies aggregate stats — shape mirrors the server-side
 * `CompanyStats` type in `apps/server/src/entities/companies/stats.ts`.
 * Future entity widgets (contacts in 4b.4, calendar in 4c.4, todos in
 * 4d.4) will declare their own per-kind shapes alongside this one.
 */
export interface CompanyStatsResponse {
  readonly total: number;
  readonly withKvk: number;
  readonly missingDescription: number;
  readonly recentlyEnriched: number;
}

export async function getCompanyStats(slug: string): Promise<CompanyStatsResponse> {
  const res = await request<{ stats: CompanyStatsResponse }>(
    `/l/${encodeURIComponent(slug)}/company/_stats`,
  );
  return res.stats;
}

/**
 * Contacts aggregate stats — shape mirrors the server-side
 * `ContactStats` type in `apps/server/src/entities/contacts/stats.ts`.
 * Second consumer of the §4a.4 stats route (`GET /l/:slug/<kind>/_stats`)
 * — empirical validation that the entity-foundation slot generalises
 * cleanly with zero contract changes.
 */
export interface ContactStatsResponse {
  readonly total: number;
  readonly withCompanyLink: number;
  readonly missingEmail: number;
  readonly recentlyEnriched: number;
}

export async function getContactStats(slug: string): Promise<ContactStatsResponse> {
  const res = await request<{ stats: ContactStatsResponse }>(
    `/l/${encodeURIComponent(slug)}/contact/_stats`,
  );
  return res.stats;
}

/**
 * Calendar-event aggregate stats — shape mirrors the server-side
 * `CalendarEventStats` type in
 * `apps/server/src/entities/calendar/stats.ts`. Third consumer of the
 * §4a.4 stats route (`GET /l/:slug/<kind>/_stats`) — empirical
 * validation that the entity-foundation slot generalises cleanly with
 * zero contract changes.
 *
 * The URL uses the singular `/calendar_event` segment per the §4.0
 * router naming; the web UI in 4c.5 will surface a friendlier
 * `/l/:slug/calendar` page that calls this URL underneath.
 */
export interface CalendarEventStatsResponse {
  readonly total: number;
  readonly upcomingNext7d: number;
  readonly withAttendeesLinked: number;
  readonly recentlyEnriched: number;
}

export async function getCalendarEventStats(slug: string): Promise<CalendarEventStatsResponse> {
  const res = await request<{ stats: CalendarEventStatsResponse }>(
    `/l/${encodeURIComponent(slug)}/calendar_event/_stats`,
  );
  return res.stats;
}

/**
 * Todos aggregate stats — shape mirrors the server-side `TodoStats`
 * type in `apps/server/src/entities/todos/stats.ts`. Fourth consumer
 * of the §4a.4 stats route (`GET /l/:slug/<kind>/_stats`) — empirical
 * validation that the entity-foundation slot generalises cleanly with
 * zero contract changes.
 *
 * The URL uses the singular `/todo` segment per the §4.0 router
 * naming; the 4d.5 web UI will surface a friendlier `/l/:slug/todos`
 * page that calls this URL underneath.
 */
export interface TodoStatsResponse {
  readonly totalOpen: number;
  readonly dueToday: number;
  readonly overdue: number;
  readonly highPriorityOpen: number;
}

export async function getTodoStats(slug: string): Promise<TodoStatsResponse> {
  const res = await request<{ stats: TodoStatsResponse }>(
    `/l/${encodeURIComponent(slug)}/todo/_stats`,
  );
  return res.stats;
}

// ---------- companies CRUD (phase 4a.5) ------------------------------------
//
// Web URLs use the plural `/l/:slug/companies` segment (see
// `apps/web/src/lib/companies-routes.ts`) but the server router mounts
// the singular `/l/:slug/company` per the §4.0 entity contract. Every
// helper below routes through the singular paths assembled in
// `companies-routes.ts` so the singular ↔ plural seam lives in one
// place. The 4a.1 close-out explicitly deferred a `routeSegment`
// override on `EntityModule` until a second entity needs a different
// mapping.

export async function listCompanies(layerSlug: string): Promise<readonly EntitySummary[]> {
  const res = await request<{ entities: readonly EntitySummary[] }>(companiesServerBase(layerSlug));
  return res.entities;
}

export async function getCompany(layerSlug: string, companySlug: string): Promise<Company> {
  const res = await request<{ entity: Company }>(companyServerDetail(layerSlug, companySlug));
  return res.entity;
}

export async function createCompany(
  layerSlug: string,
  body: CreateCompanyPayload,
): Promise<Company> {
  const res = await request<{ entity: Company }>(companiesServerBase(layerSlug), {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.entity;
}

export async function updateCompany(
  layerSlug: string,
  companySlug: string,
  body: UpdateCompanyPayload,
): Promise<Company> {
  const res = await request<{ entity: Company }>(companyServerDetail(layerSlug, companySlug), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return res.entity;
}

export async function softDeleteCompany(layerSlug: string, companySlug: string): Promise<void> {
  await request<{ ok: true }>(companyServerDetail(layerSlug, companySlug), { method: 'DELETE' });
}

/**
 * External links are nested under the company detail: a fresh
 * `getCompany(...)` returns them on `entity.externalLinks`. This
 * helper exists for code paths that want to re-poll links without
 * re-fetching the full company (e.g. the "Refresh" button next to a
 * KvK link). It re-uses the detail endpoint and projects the array.
 */
export async function listCompanyExternalLinks(
  layerSlug: string,
  companySlug: string,
): Promise<readonly EntityExternalLink[]> {
  const company = await getCompany(layerSlug, companySlug);
  return company.externalLinks;
}

export async function addCompanyExternalLink(
  layerSlug: string,
  companySlug: string,
  body: AddCompanyExternalLinkPayload,
): Promise<EntityExternalLink> {
  const res = await request<{ externalLink: EntityExternalLink }>(
    companyServerExternalLinks(layerSlug, companySlug),
    { method: 'POST', body: JSON.stringify(body) },
  );
  return res.externalLink;
}

export async function removeCompanyExternalLink(
  layerSlug: string,
  companySlug: string,
  linkId: string,
): Promise<void> {
  await request<{ ok: true }>(companyServerExternalLink(layerSlug, companySlug, linkId), {
    method: 'DELETE',
  });
}

// ---------- contacts CRUD (phase 4b.5) -------------------------------------
//
// Same singular ↔ plural seam as Companies — see the head note above the
// companies CRUD block and `apps/web/src/lib/contacts-routes.ts`. The
// server router mounts the singular `/l/:slug/contact` segment per the
// §4.0 entity contract; the web URLs use the friendlier plural form.

export async function listContacts(layerSlug: string): Promise<readonly EntitySummary[]> {
  const res = await request<{ entities: readonly EntitySummary[] }>(contactsServerBase(layerSlug));
  return res.entities;
}

export async function getContact(layerSlug: string, contactSlug: string): Promise<Contact> {
  const res = await request<{ entity: Contact }>(contactServerDetail(layerSlug, contactSlug));
  return res.entity;
}

export async function createContact(
  layerSlug: string,
  body: CreateContactPayload,
): Promise<Contact> {
  const res = await request<{ entity: Contact }>(contactsServerBase(layerSlug), {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.entity;
}

export async function updateContact(
  layerSlug: string,
  contactSlug: string,
  body: UpdateContactPayload,
): Promise<Contact> {
  const res = await request<{ entity: Contact }>(contactServerDetail(layerSlug, contactSlug), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return res.entity;
}

export async function softDeleteContact(layerSlug: string, contactSlug: string): Promise<void> {
  await request<{ ok: true }>(contactServerDetail(layerSlug, contactSlug), { method: 'DELETE' });
}

/**
 * External links are returned on the full contact envelope from
 * `getContact(...)`. This helper exists for symmetry with
 * `listCompanyExternalLinks` and for code paths that want to re-poll
 * the read-only provenance list (vCard imports create them) without
 * touching the rest of the form draft.
 */
export async function listContactExternalLinks(
  layerSlug: string,
  contactSlug: string,
): Promise<readonly EntityExternalLink[]> {
  const contact = await getContact(layerSlug, contactSlug);
  return contact.externalLinks;
}

// ---------- contacts ingest (phase 4b.2) ---------------------------------

export interface ContactsImportVcardResult {
  readonly created: number;
  readonly updated: number;
  readonly warnings: readonly string[];
}

/**
 * Phase 4b.2 — POST a `.vcf` file to the layer's contacts ingest
 * endpoint. The server returns 200 with a numeric summary and a list of
 * parse warnings.
 *
 * Errors map to `ApiError.errorKey`:
 *   - `errors.entity.connectorUnknown` (400) — bad URL slug.
 *   - `errors.connectors.vcard.invalidContentType` (400) — wrong MIME.
 *   - `errors.connectors.vcard.tooLarge` (413) — file over the server cap.
 *   - `errors.entity.connectorIngestFailed` (400) — connector threw.
 */
export async function importContactsVcard(
  layerSlug: string,
  file: File,
): Promise<ContactsImportVcardResult> {
  const form = new FormData();
  form.append('file', file);
  let res: Response;
  try {
    res = await fetch(`${apiBase}/l/${encodeURIComponent(layerSlug)}/contact/_ingest/vcard`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
  } catch {
    throw new ApiError('errors.network', 0);
  }
  if (!res.ok) {
    const body = await parseJson<ErrorEnvelope>(res);
    throw new ApiError(errorKeyFrom(body, res.status), res.status);
  }
  const body = await parseJson<ContactsImportVcardResult>(res);
  if (body === null) {
    throw new ApiError('errors.network', res.status);
  }
  return body;
}

// ---------- calendar events CRUD (phase 4c.5) ------------------------------
//
// Same singular ↔ plural seam as Companies / Contacts — see
// `apps/web/src/lib/calendar-routes.ts`. The server router mounts the
// singular `/l/:slug/calendar_event` segment per the §4.0 entity contract;
// the web UI's friendlier URL is `/l/:slug/calendar`.

export async function listCalendarEvents(
  layerSlug: string,
  opts: { readonly from?: string; readonly to?: string } = {},
): Promise<readonly EntitySummary[]> {
  // Phase 4c.5 follow-up — the server's §4.0 list endpoint now accepts
  // `?from=&to=` against the indexed `starts_at` column when the
  // calendar module declares a `timeColumn`. Caller passes the grid's
  // visible range so we don't fetch every event in the layer.
  const params = new URLSearchParams();
  if (opts.from !== undefined && opts.from !== '') params.set('from', opts.from);
  if (opts.to !== undefined && opts.to !== '') params.set('to', opts.to);
  const qs = params.toString();
  const url = qs === '' ? calendarServerBase(layerSlug) : `${calendarServerBase(layerSlug)}?${qs}`;
  const res = await request<{ entities: readonly EntitySummary[] }>(url);
  return res.entities;
}

export async function getCalendarEvent(
  layerSlug: string,
  eventSlug: string,
): Promise<CalendarEvent> {
  const res = await request<{ entity: CalendarEvent }>(calendarServerDetail(layerSlug, eventSlug));
  return res.entity;
}

export async function createCalendarEvent(
  layerSlug: string,
  body: CreateCalendarEventPayload,
): Promise<CalendarEvent> {
  const res = await request<{ entity: CalendarEvent }>(calendarServerBase(layerSlug), {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.entity;
}

export async function updateCalendarEvent(
  layerSlug: string,
  eventSlug: string,
  body: UpdateCalendarEventPayload,
): Promise<CalendarEvent> {
  const res = await request<{ entity: CalendarEvent }>(calendarServerDetail(layerSlug, eventSlug), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return res.entity;
}

export async function softDeleteCalendarEvent(layerSlug: string, eventSlug: string): Promise<void> {
  await request<{ ok: true }>(calendarServerDetail(layerSlug, eventSlug), {
    method: 'DELETE',
  });
}

/**
 * The full entity envelope from `getCalendarEvent` already carries the
 * `externalLinks` array. This helper exists for symmetry with the
 * Contacts / Companies analogues so the detail page can re-poll the
 * provenance list without re-fetching the rest of the form draft.
 */
export async function listCalendarEventExternalLinks(
  layerSlug: string,
  eventSlug: string,
): Promise<readonly EntityExternalLink[]> {
  const event = await getCalendarEvent(layerSlug, eventSlug);
  return event.externalLinks;
}

/**
 * Phase 4c.5 — kick a Google Calendar sync for the layer. POSTs a
 * synthetic empty file with the connector-expected content type to the
 * existing 4b.2 multipart ingest endpoint. The server returns a numeric
 * `{ created, updated, warnings }` summary; per ADR 0014 §7 the bus
 * never sees the file body.
 *
 * Errors map to `ApiError.errorKey`:
 *   - `errors.entity.connectorUnknown` (400) — connector not registered.
 *   - `errors.connectors.google.calendar.invalidConfig` (400) — no
 *     attachment configured for the layer.
 *   - `errors.connectors.google.calendar.unauthorized` (400) — Google
 *     rejected the stored refresh token.
 *   - `errors.connectors.google.calendar.syncFailed` (400) — generic
 *     upstream failure surfaced by the connector.
 *   - `errors.entity.connectorIngestFailed` (400) — connector threw a
 *     non-`errors.*` message (defensive default).
 */
export async function syncGoogleCalendar(layerSlug: string): Promise<GoogleCalendarSyncResult> {
  const form = new FormData();
  // The 4b.2 ingest router reads `file.type` for the content type; an
  // empty Blob with the right MIME satisfies the Google connector's
  // `application/x-google-calendar-list-request` gate without sending
  // any real bytes.
  form.append(
    'file',
    new Blob([], { type: 'application/x-google-calendar-list-request' }),
    'google-calendar-list-request.empty',
  );
  let res: Response;
  try {
    res = await fetch(`${apiBase}${calendarServerGoogleIngest(layerSlug)}`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
  } catch {
    throw new ApiError('errors.network', 0);
  }
  if (!res.ok) {
    const body = await parseJson<ErrorEnvelope>(res);
    throw new ApiError(errorKeyFrom(body, res.status), res.status);
  }
  const body = await parseJson<GoogleCalendarSyncResult>(res);
  if (body === null) {
    throw new ApiError('errors.network', res.status);
  }
  return body;
}

// ---------- todos CRUD (phase 4d.5) ----------------------------------------
//
// Same singular ↔ plural seam as Companies / Contacts / Calendar — see
// `apps/web/src/lib/todos-routes.ts`. The server router mounts the
// singular `/l/:slug/todo` segment per the §4.0 entity contract; the
// web UI's friendlier URL is `/l/:slug/todos`. The list endpoint
// returns `EntitySummary[]` (title + subtitle + meta only); the kanban
// view needs `status` / `priority` / `dueAt` which only live on the
// full payload, so the list page hydrates each summary via
// `getTodo(...)` after listing. The N+1 cost mirrors the calendar
// list page; the documented "summaryColumns" follow-up at
// `docs/dev/follow-ups/companies-list-columns.md` already tracks the
// gap.

export async function listTodos(layerSlug: string): Promise<readonly EntitySummary[]> {
  const res = await request<{ entities: readonly EntitySummary[] }>(todosServerBase(layerSlug));
  return res.entities;
}

export async function getTodo(layerSlug: string, todoSlug: string): Promise<Todo> {
  const res = await request<{ entity: Todo }>(todoServerDetail(layerSlug, todoSlug));
  return res.entity;
}

export async function createTodo(layerSlug: string, body: CreateTodoPayload): Promise<Todo> {
  const res = await request<{ entity: Todo }>(todosServerBase(layerSlug), {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return res.entity;
}

export async function updateTodo(
  layerSlug: string,
  todoSlug: string,
  body: UpdateTodoPayload,
): Promise<Todo> {
  const res = await request<{ entity: Todo }>(todoServerDetail(layerSlug, todoSlug), {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
  return res.entity;
}

export async function softDeleteTodo(layerSlug: string, todoSlug: string): Promise<void> {
  await request<{ ok: true }>(todoServerDetail(layerSlug, todoSlug), { method: 'DELETE' });
}

/**
 * Phase 4d.6 — todo → calendar projection bridge read endpoint.
 *
 * Returns the read-only todo projections for the layer, as written by
 * the server-side subscriber (`apps/server/src/entities/todos/calendar-projection.ts`).
 * The calendar UI fetches this in parallel with `listCalendarEvents`
 * and merges client-side via `mergeCalendarFeed(...)` so the user
 * sees todos appear as non-editable events on their due date.
 *
 * Server URL: `/l/:slug/calendar/_projections/todos` (the URL lives
 * under `/calendar/` even though the data is materialized from
 * `todos` — see ADR 0017).
 */
export interface TodoCalendarProjectionItem {
  readonly todoId: string;
  readonly layerId: string;
  readonly todoSlug: string;
  readonly title: string;
  readonly dueAt: string;
  readonly priority: number;
  readonly status: 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled' | string;
}

export interface TodoCalendarProjectionsResponse {
  readonly items: readonly TodoCalendarProjectionItem[];
}

export async function listTodoProjectionsForCalendar(
  layerSlug: string,
): Promise<TodoCalendarProjectionsResponse> {
  const res = await request<TodoCalendarProjectionsResponse>(
    `/l/${encodeURIComponent(layerSlug)}/calendar/_projections/todos`,
  );
  return res;
}

// ---------- scheduled tasks (phase 5.6) ------------------------------------

function scheduledTasksBase(layerSlug: string): string {
  return `/l/${encodeURIComponent(layerSlug)}/scheduled-tasks`;
}

export async function listScheduledTasks(
  layerSlug: string,
): Promise<readonly ScheduledTaskSummary[]> {
  const res = await request<{ tasks: readonly ScheduledTaskSummary[] }>(
    scheduledTasksBase(layerSlug),
  );
  return res.tasks;
}

export async function listScheduledTaskKinds(
  layerSlug: string,
): Promise<readonly ScheduledTaskHandlerInfo[]> {
  const res = await request<{ kinds: readonly ScheduledTaskHandlerInfo[] }>(
    `${scheduledTasksBase(layerSlug)}/_kinds`,
  );
  return res.kinds;
}

export async function listRecentScheduledRuns(
  layerSlug: string,
  limit = 10,
): Promise<readonly ScheduledTaskRecentRun[]> {
  const res = await request<{ runs: readonly ScheduledTaskRecentRun[] }>(
    `${scheduledTasksBase(layerSlug)}/_recent-runs?limit=${encodeURIComponent(String(limit))}`,
  );
  return res.runs;
}

export async function createScheduledTask(
  layerSlug: string,
  payload: CreateScheduledTaskPayload,
): Promise<ScheduledTaskSummary> {
  const res = await request<{ task: ScheduledTaskSummary }>(scheduledTasksBase(layerSlug), {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return res.task;
}

export async function updateScheduledTask(
  layerSlug: string,
  taskSlug: string,
  payload: UpdateScheduledTaskPayload,
): Promise<ScheduledTaskSummary> {
  const res = await request<{ task: ScheduledTaskSummary }>(
    `${scheduledTasksBase(layerSlug)}/${encodeURIComponent(taskSlug)}`,
    { method: 'PATCH', body: JSON.stringify(payload) },
  );
  return res.task;
}

export async function deleteScheduledTask(layerSlug: string, taskSlug: string): Promise<void> {
  await request<{ ok: true }>(`${scheduledTasksBase(layerSlug)}/${encodeURIComponent(taskSlug)}`, {
    method: 'DELETE',
  });
}

export async function pauseScheduledTask(
  layerSlug: string,
  taskSlug: string,
): Promise<ScheduledTaskSummary> {
  const res = await request<{ task: ScheduledTaskSummary }>(
    `${scheduledTasksBase(layerSlug)}/${encodeURIComponent(taskSlug)}/pause`,
    { method: 'POST' },
  );
  return res.task;
}

export async function resumeScheduledTask(
  layerSlug: string,
  taskSlug: string,
): Promise<ScheduledTaskSummary> {
  const res = await request<{ task: ScheduledTaskSummary }>(
    `${scheduledTasksBase(layerSlug)}/${encodeURIComponent(taskSlug)}/resume`,
    { method: 'POST' },
  );
  return res.task;
}

export async function runScheduledTaskNow(
  layerSlug: string,
  taskSlug: string,
): Promise<ScheduledTaskRunSummary> {
  const res = await request<{ run: ScheduledTaskRunSummary }>(
    `${scheduledTasksBase(layerSlug)}/${encodeURIComponent(taskSlug)}/runs`,
    { method: 'POST' },
  );
  return res.run;
}

export async function listScheduledTaskRuns(
  layerSlug: string,
  taskSlug: string,
  limit = 50,
): Promise<readonly ScheduledTaskRunSummary[]> {
  const res = await request<{ runs: readonly ScheduledTaskRunSummary[] }>(
    `${scheduledTasksBase(layerSlug)}/${encodeURIComponent(taskSlug)}/runs?limit=${encodeURIComponent(String(limit))}`,
  );
  return res.runs;
}

// ---------- admin: scheduled tasks + bus DLQ (phase 5.6) -------------------

export async function listAdminScheduledTasks(): Promise<readonly AdminScheduledTaskRow[]> {
  const res = await request<{ tasks: readonly AdminScheduledTaskRow[] }>('/admin/scheduled-tasks');
  return res.tasks;
}

export async function listAdminBusDlq(limit = 50): Promise<readonly AdminBusDlqRow[]> {
  const res = await request<{ items: readonly AdminBusDlqRow[] }>(
    `/admin/bus/dlq?limit=${encodeURIComponent(String(limit))}`,
  );
  return res.items;
}

export async function replayAdminBusDlq(outboxId: string): Promise<void> {
  await request<{ ok: true }>(`/admin/bus/dlq/${encodeURIComponent(outboxId)}/replay`, {
    method: 'POST',
  });
}

// ---------- per-layer chat (phase 6.5) -------------------------------------
//
// Routes are mounted under `/l/:slug/chat/*` by
// `apps/server/src/http/routes/layer-chat.ts`. The SSE message endpoint
// is NOT wrapped here — see `apps/web/src/lib/sse-fetch.ts` for the
// streaming helper. The functions below cover the synchronous JSON
// routes (conversation CRUD + feedback).

/**
 * The list endpoint returns the `Summary` shape (base conversation
 * fields + aggregated feedback counts); the create / get endpoints
 * still return the bare `ChatConversation`. Phase 6.5's
 * `LayerChatPage.tsx` reads only the shared base fields so the
 * widened list payload is forward-compatible.
 */
export type LayerChatConversation = SharedChatConversationSummary;
export type LayerChatConversationDetail = SharedChatConversation;
export type LayerChatMessage = SharedChatMessage;
export type LayerChatFeedback = SharedChatMessageFeedback;
export type LayerChatFeedbackValue = SharedChatFeedbackValue;
export type LayerChatBoardItem = SharedChatBoardItem;

function chatConversationsBase(layerSlug: string): string {
  return `/l/${encodeURIComponent(layerSlug)}/chat/conversations`;
}

export async function listLayerChatConversations(
  layerSlug: string,
): Promise<readonly LayerChatConversation[]> {
  const res = await request<{ conversations: readonly LayerChatConversation[] }>(
    chatConversationsBase(layerSlug),
  );
  return res.conversations;
}

export async function createLayerChatConversation(
  layerSlug: string,
  body: { title?: string; locale?: string } = {},
): Promise<LayerChatConversation> {
  const payload: { title?: string; locale?: string } = {};
  if (body.title !== undefined) payload.title = body.title;
  if (body.locale !== undefined) payload.locale = body.locale;
  // The create endpoint returns the bare `ChatConversation`; we
  // widen with zero counts so the result shape matches the list
  // shape (used by the page state to insert the new row).
  const res = await request<{ conversation: LayerChatConversationDetail }>(
    chatConversationsBase(layerSlug),
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
  return {
    ...res.conversation,
    feedbackUpCount: 0,
    feedbackDownCount: 0,
  };
}

export async function deleteLayerChatConversation(
  layerSlug: string,
  conversationId: string,
): Promise<void> {
  await request<{ ok: true }>(
    `${chatConversationsBase(layerSlug)}/${encodeURIComponent(conversationId)}`,
    { method: 'DELETE' },
  );
}

export async function listLayerChatMessages(
  layerSlug: string,
  conversationId: string,
): Promise<readonly LayerChatMessage[]> {
  const res = await request<{ messages: readonly LayerChatMessage[] }>(
    `${chatConversationsBase(layerSlug)}/${encodeURIComponent(conversationId)}/messages`,
  );
  return res.messages;
}

/**
 * Build the relative path the SSE helper posts to. The body is sent
 * by the SSE helper itself (`{ content }` only — no model override
 * per plan §10).
 */
export function layerChatMessageStreamPath(layerSlug: string, conversationId: string): string {
  return `${chatConversationsBase(layerSlug)}/${encodeURIComponent(conversationId)}/messages`;
}

/**
 * Phase 6.6 — board snapshot for the per-layer Kanban view. The
 * server returns raw run + step snapshots; the client buckets into
 * columns. Newest-first by message `createdAt`. The server caps the
 * `limit` at 200.
 */
export async function listLayerChatBoard(
  layerSlug: string,
  limit = 50,
): Promise<readonly LayerChatBoardItem[]> {
  const res = await request<{ items: readonly LayerChatBoardItem[] }>(
    `/l/${encodeURIComponent(layerSlug)}/chat/board?limit=${encodeURIComponent(String(limit))}`,
  );
  return res.items;
}

export async function postLayerChatFeedback(
  layerSlug: string,
  messageId: string,
  body: { value: LayerChatFeedbackValue; reason?: string },
): Promise<LayerChatFeedback> {
  const payload: { value: LayerChatFeedbackValue; reason?: string } = { value: body.value };
  if (body.value === 'down' && body.reason !== undefined && body.reason.length > 0) {
    payload.reason = body.reason;
  }
  const res = await request<{ feedback: LayerChatFeedback }>(
    `/l/${encodeURIComponent(layerSlug)}/chat/messages/${encodeURIComponent(messageId)}/feedback`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  return res.feedback;
}

// ---------- Phase 7.6 — proposals + capabilities --------------------------
//
// Per-layer improvement proposals (`/l/:slug/proposals/*`) and the
// per-layer activated-capability registry (`/l/:slug/capabilities`).
// All routes sit behind the standard auth + layer-visibility chain;
// the mutation routes additionally require admin. The web layer
// surfaces 403 / 404 via the shared `errors.*` keys.

export type ProposalStatus =
  | 'new'
  | 'approved'
  | 'rejected'
  | 'superseded'
  | 'activated'
  | 'deactivated';

export type ProposalArtifactKind = 'tool' | 'skill' | 'agent';

export interface ProposalSummary {
  readonly id: string;
  readonly layerId: string;
  readonly status: ProposalStatus;
  readonly artifactKind: ProposalArtifactKind;
  readonly problemSummary: string;
  readonly threshold: number;
  readonly mintedAt: string;
  readonly thumbsUpDelta: number;
  /**
   * Phase 8.4 — auto-activation audit (subset). The list page renders
   * a Source chip from these; `autoActivatedBy` is the closed literal
   * `'system'` per ADR 0026 §3, or `null` when the proposal was not
   * auto-touched. The full audit set lives on the detail response.
   */
  readonly autoActivatedAt: string | null;
  readonly autoActivatedBy: 'system' | null;
}

export interface ProposalEvidenceItem {
  readonly id: string;
  readonly messageId: string;
  readonly conversationId: string | null;
  readonly conversationTitle: string | null;
  readonly clusterReason: string;
  readonly detailJson: string | null;
  readonly messageContent: string | null;
  readonly messageRole: string | null;
}

export interface ProposalArtifactItem {
  readonly id: string;
  readonly variant: 'current' | 'proposed' | 'replanned';
  readonly transcript: unknown;
  readonly metrics: unknown;
  readonly ranAt: string;
}

export interface ProposalDetailResponse {
  readonly proposal: {
    readonly id: string;
    readonly layerId: string;
    readonly status: ProposalStatus;
    readonly artifactKind: ProposalArtifactKind;
    readonly problemSummary: string;
    readonly proposedSpec: unknown;
    readonly expectedImpact: {
      readonly thumbsUpDelta?: number;
      readonly tokensDelta?: number;
      readonly latencyDeltaMs?: number;
    };
    readonly threshold: number;
    readonly capabilitySnapshot: unknown;
    readonly mintedByRunId: string;
    readonly mintedAt: string;
    readonly approvedBy: string | null;
    readonly approvedAt: string | null;
    readonly rejectedBy: string | null;
    readonly rejectedAt: string | null;
    readonly rejectedReason: string | null;
    readonly activatedAt: string | null;
    /**
     * Phase 8.4 — six audit columns added in 8.1. The rollback fields
     * stay `null` until 8.5 ships the rollback route — the shape is
     * shipped now so 8.5 is a single-route patch.
     */
    readonly autoActivatedBy: 'system' | null;
    readonly autoActivatedAt: string | null;
    readonly autoActivationDecisionJson: string | null;
    readonly rolledBackAt: string | null;
    readonly rolledBackBy: string | null;
    readonly rolledBackReason: string | null;
  };
  readonly evidence: readonly ProposalEvidenceItem[];
  readonly artifacts: readonly ProposalArtifactItem[];
}

export interface ProposalListResponse {
  readonly items: readonly ProposalSummary[];
  readonly total: number;
}

export interface ProposalListParams {
  readonly status?: ProposalStatus;
  readonly sort?: 'newest' | 'impact' | 'threshold';
  readonly limit?: number;
  readonly offset?: number;
}

export async function fetchLayerProposals(
  layerSlug: string,
  params: ProposalListParams = {},
): Promise<ProposalListResponse> {
  const q = new URLSearchParams();
  if (params.status !== undefined) q.set('status', params.status);
  if (params.sort !== undefined) q.set('sort', params.sort);
  if (params.limit !== undefined) q.set('limit', String(params.limit));
  if (params.offset !== undefined) q.set('offset', String(params.offset));
  const suffix = q.toString();
  return request<ProposalListResponse>(
    `/l/${encodeURIComponent(layerSlug)}/proposals${suffix.length > 0 ? `?${suffix}` : ''}`,
  );
}

export async function fetchLayerProposalDetail(
  layerSlug: string,
  proposalId: string,
): Promise<ProposalDetailResponse> {
  return request<ProposalDetailResponse>(
    `/l/${encodeURIComponent(layerSlug)}/proposals/${encodeURIComponent(proposalId)}`,
  );
}

export interface ApproveOutcomeResponse {
  readonly outcome:
    | 'activated-asis'
    | 'activated-replanned'
    | 'superseded'
    | 'superseded-after-replan';
}

export async function approveLayerProposal(
  layerSlug: string,
  proposalId: string,
): Promise<ApproveOutcomeResponse> {
  return request<ApproveOutcomeResponse>(
    `/l/${encodeURIComponent(layerSlug)}/proposals/${encodeURIComponent(proposalId)}/approve`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export async function rejectLayerProposal(
  layerSlug: string,
  proposalId: string,
  reason: string,
): Promise<{ status: 'rejected'; rejectedAt: string }> {
  return request<{ status: 'rejected'; rejectedAt: string }>(
    `/l/${encodeURIComponent(layerSlug)}/proposals/${encodeURIComponent(proposalId)}/reject`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
}

/**
 * Phase 8.5 — manual rollback. Sends the required reason
 * (5..2000 chars; server re-validates) and returns the soft-deactivated
 * capability id. Errors are surfaced through the standard `ApiError`
 * path; the two server 409 keys (`errors.proposal.notActivated` /
 * `errors.proposal.alreadyDeactivated`) flow through `errorKeyOf` as-is.
 */
export async function rollbackLayerProposal(
  layerSlug: string,
  proposalId: string,
  reason: string,
): Promise<{ status: 'rolled-back'; capabilityId: string }> {
  return request<{ status: 'rolled-back'; capabilityId: string }>(
    `/l/${encodeURIComponent(layerSlug)}/proposals/${encodeURIComponent(proposalId)}/rollback`,
    { method: 'POST', body: JSON.stringify({ reason }) },
  );
}

export interface ReplaySandboxResponse {
  readonly outcome: string;
  readonly metrics: unknown;
  readonly variantArtifacts: { currentArtifactId: string; proposedArtifactId: string };
}

export async function replayProposalSandbox(
  layerSlug: string,
  proposalId: string,
): Promise<ReplaySandboxResponse> {
  return request<ReplaySandboxResponse>(
    `/l/${encodeURIComponent(layerSlug)}/proposals/${encodeURIComponent(proposalId)}/replay-sandbox`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

export interface LayerCapabilityItem {
  readonly id: string;
  readonly layerId: string;
  readonly kind: ProposalArtifactKind;
  readonly name: string;
  readonly origin: string;
  readonly activatedAt: string;
  readonly deactivatedAt: string | null;
}

export interface LayerCapabilityListResponse {
  readonly items: readonly LayerCapabilityItem[];
  readonly total: number;
}

export async function fetchLayerCapabilities(
  layerSlug: string,
): Promise<LayerCapabilityListResponse> {
  return request<LayerCapabilityListResponse>(`/l/${encodeURIComponent(layerSlug)}/capabilities`);
}

export async function deactivateLayerCapability(
  layerSlug: string,
  capabilityId: string,
): Promise<{ status: 'deactivated'; capabilityId: string }> {
  return request<{ status: 'deactivated'; capabilityId: string }>(
    `/l/${encodeURIComponent(layerSlug)}/capabilities/${encodeURIComponent(capabilityId)}/deactivate`,
    { method: 'POST', body: JSON.stringify({}) },
  );
}

// ---------- Phase 8.4 — per-layer proposal settings -----------------------
//
// Mirrors the server's zod (`LayerProposalSettingsInputSchema`) one-to-one
// — keep these shapes in sync with `packages/shared/src/proposals.ts`.
// The `AutoActivationDecision` re-export is consumed by the proposal
// detail page's decision panel.

export type {
  AutoActivationDecision,
  AutoActivationGateRecord,
  AutoActivationRejection,
} from '@bunny2/shared';

export interface LayerProposalSettings {
  readonly layerId: string;
  readonly autoActivationEnabled: boolean;
  readonly thresholdCutoff: number;
  readonly cooldownHours: number;
  readonly requireThumbsUpDeltaPositive: boolean;
  readonly maxTokensDelta: number | null;
  readonly updatedAt: string;
  readonly updatedBy: string;
}

export interface LayerProposalSettingsResponse {
  readonly source: 'default' | 'saved';
  readonly settings: LayerProposalSettings;
}

export interface LayerProposalSettingsInput {
  readonly autoActivationEnabled: boolean;
  readonly thresholdCutoff: number;
  readonly cooldownHours: number;
  readonly requireThumbsUpDeltaPositive: boolean;
  readonly maxTokensDelta: number | null;
}

export async function fetchLayerProposalSettings(
  layerSlug: string,
): Promise<LayerProposalSettingsResponse> {
  return request<LayerProposalSettingsResponse>(
    `/l/${encodeURIComponent(layerSlug)}/settings/proposals`,
  );
}

export async function saveLayerProposalSettings(
  layerSlug: string,
  input: LayerProposalSettingsInput,
): Promise<LayerProposalSettingsResponse> {
  return request<LayerProposalSettingsResponse>(
    `/l/${encodeURIComponent(layerSlug)}/settings/proposals`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}

// ---------- per-layer chat settings (model + embedding budget) ------------
//
// Mirrors the server's zod `LayerChatSettingsInputSchema` /
// `LayerChatSettingsResponseSchema` 1:1. Every field is nullable — NULL
// means "inherit the system default".

export interface LayerChatSettings {
  readonly layerId: string;
  readonly model: string | null;
  readonly embeddingDailyCap: number | null;
  readonly embeddingMonthlyCap: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LayerChatSettingsSpend {
  readonly day: string;
  readonly tokensToday: number;
  readonly tokensLast30Days: number;
}

export interface LayerChatSettingsResponse {
  readonly source: 'default' | 'saved';
  readonly settings: LayerChatSettings;
  readonly spend: LayerChatSettingsSpend;
}

export interface LayerChatSettingsInput {
  readonly model: string | null;
  readonly embeddingDailyCap: number | null;
  readonly embeddingMonthlyCap: number | null;
}

export async function fetchLayerChatSettings(
  layerSlug: string,
): Promise<LayerChatSettingsResponse> {
  return request<LayerChatSettingsResponse>(
    `/l/${encodeURIComponent(layerSlug)}/settings/chat`,
  );
}

export async function saveLayerChatSettings(
  layerSlug: string,
  input: LayerChatSettingsInput,
): Promise<LayerChatSettingsResponse> {
  return request<LayerChatSettingsResponse>(
    `/l/${encodeURIComponent(layerSlug)}/settings/chat`,
    { method: 'PUT', body: JSON.stringify(input) },
  );
}
