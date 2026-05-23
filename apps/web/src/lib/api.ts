/**
 * Thin client for the bunny2 server. Both functions return parsed JSON or
 * throw a typed error that the UI layer can map to an i18n key.
 *
 * The base URL is resolved in this order:
 *   1. `window.bunny2.apiBase` — injected by the Electron preload at the
 *      port the main process pre-probed for the sidecar (phase 1.6).
 *   2. `import.meta.env.VITE_API_BASE` — for Vite dev / standalone web.
 *   3. `http://127.0.0.1:4317` — matches `apps/server/src/config/schema.ts`.
 */

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

export async function fetchStatus(): Promise<StatusResponse> {
  let res: Response;
  try {
    res = await fetch(`${apiBase}/status`);
  } catch {
    throw new ApiError('errors.network', 0);
  }
  if (!res.ok) {
    throw new ApiError('errors.network', res.status);
  }
  return (await res.json()) as StatusResponse;
}

export async function postChat(input: { message: string; model?: string }): Promise<ChatResponse> {
  const body: { message: string; model?: string } = { message: input.message };
  if (input.model !== undefined && input.model.length > 0) body.model = input.model;

  let res: Response;
  try {
    res = await fetch(`${apiBase}/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiError('errors.network', 0);
  }
  const parsed = (await res.json().catch(() => null)) as
    | (Partial<ChatResponse> & { error?: string })
    | null;
  if (!res.ok) {
    const key = parsed?.error ?? 'errors.network';
    throw new ApiError(key, res.status);
  }
  if (!parsed || typeof parsed.content !== 'string') {
    throw new ApiError('errors.network', res.status);
  }
  return parsed as ChatResponse;
}
