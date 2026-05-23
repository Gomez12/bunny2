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
  AdminGroupDetailResponse,
  AdminGroupListResponse,
  AdminGroupRow,
  AdminResetPasswordResponse,
  AdminUserCreateResponse,
  AdminUserDetailResponse,
  AdminUserListResponse,
  AdminUserRow,
  CreateGroupPayload,
  CreateUserPayload,
  LoginResponse,
  MeResponse,
  SafeGroup,
  SafeUser,
  UpdateGroupPayload,
  UpdateUserPayload,
} from './api-types';

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
