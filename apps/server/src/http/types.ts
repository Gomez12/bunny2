import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { User as SafeUser } from '@bunny2/shared';
import type { LlmClient } from '../llm';
import type { AuthConfig } from '../config/schema';
import type { Session } from '../repos/sessions-repo';
import type { GroupResolver } from '../auth/group-resolver';

/**
 * Snapshot returned by `GET /status`. Built by `index.ts` and passed as a
 * closure so route handlers do not have to know about the storage or LLM
 * call-log internals.
 */
export interface StatusBody {
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
    /**
     * `true` once the one-shot admin seed has run on this data-dir
     * (`kv_meta.admin_seed_done === 'true'`). Read by the renderer to
     * decide whether to surface a "first run" banner; never gates any
     * server-side behaviour itself.
     */
    readonly adminSeeded: boolean;
    /**
     * `true` if `kv_meta.admin_group_id` is currently populated. The
     * `requireAdmin` middleware reads the same key ONCE at factory
     * construction; a freshly-booted server therefore stays in the
     * "503 admin not seeded" state for the lifetime of the process if
     * the seed lands AFTER `createApp` (which only happens in
     * unusual test wiring — production seeds before `Bun.serve`).
     * Status is a per-request live read, so the two values can briefly
     * disagree across that race; use `adminSeeded` for the strict
     * "seed has run on this data-dir" answer.
     */
    readonly adminGroupResolved: boolean;
  };
}

/**
 * Dependencies injected into `createApp`. Tests construct these with real
 * implementations (real bus, real sqlite-backed event log, real telemetry
 * wrapper around a mock provider) so HTTP integration tests exercise the
 * full pipeline.
 *
 * `db` and `auth` are required from phase 2.2 onward: the auth middleware
 * needs the session-backing repositories and the TTL/idle config knobs.
 */
export interface AppDeps {
  readonly bus: MessageBus;
  readonly llmClient: LlmClient;
  readonly status: () => StatusBody;
  readonly db: Database;
  readonly auth: AuthConfig;
  /**
   * Transitive group resolver — phase 2.4. Built in `index.ts` against
   * the shared bus so the resolver's cache invalidation subscribers see
   * the same publishes the rest of the system emits. Tests build it via
   * `_helpers/app.ts`.
   */
  readonly resolver: GroupResolver;
}

/**
 * Hono `c.var` shape attached by the auth middleware. Route handlers
 * authored after 2.2 may read `c.var.session` / `c.var.user` without
 * casts because the router types the Hono instance via
 * `new Hono<{ Variables: HonoVariables }>()`.
 *
 * Public routes (status, /auth/login, /auth/logout, OPTIONS) skip the
 * middleware entirely; their handlers must NOT read these variables.
 */
export interface HonoVariables {
  session: Session;
  user: SafeUser;
}
