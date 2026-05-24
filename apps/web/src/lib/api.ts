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
  AddCompanyExternalLinkPayload,
  AddLayerMemberPayload,
  AddLayerVisibilityPayload,
  AdminGroupDetailResponse,
  AdminGroupListResponse,
  AdminGroupRow,
  AdminResetPasswordResponse,
  AdminUserCreateResponse,
  AdminUserDetailResponse,
  AdminUserListResponse,
  AdminUserRow,
  Company,
  Contact,
  CreateCompanyPayload,
  CreateContactPayload,
  CreateGroupPayload,
  CreateLayerPayload,
  CreateUserPayload,
  EntityExternalLink,
  EntitySummary,
  Layer,
  LayerAttachment,
  LayerDetailResponse,
  LayerListResponse,
  LayerLocale,
  ListLayersQuery,
  LoginResponse,
  MeResponse,
  RegisterLayerAttachmentPayload,
  SafeGroup,
  SafeUser,
  SetLayerLocalesPayload,
  SystemLocalesResponse,
  UpdateCompanyPayload,
  UpdateContactPayload,
  UpdateGroupPayload,
  UpdateLayerPayload,
  UpdateUserPayload,
} from './api-types';
import {
  companiesServerBase,
  companyServerDetail,
  companyServerExternalLink,
  companyServerExternalLinks,
} from './companies-routes';
import { contactServerDetail, contactsServerBase } from './contacts-routes';

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

export async function addLayerVisibility(
  slug: string,
  body: AddLayerVisibilityPayload,
): Promise<void> {
  await request<{ ok: true }>(`/layers/${encodeURIComponent(slug)}/visibility`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
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
