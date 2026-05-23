import type { MessageBus } from '@bunny2/bus';
import type { LlmClient } from '../llm';

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
}

/**
 * Dependencies injected into `createApp`. Tests construct these with real
 * implementations (real bus, real sqlite-backed event log, real telemetry
 * wrapper around a mock provider) so HTTP integration tests exercise the
 * full pipeline.
 */
export interface AppDeps {
  readonly bus: MessageBus;
  readonly llmClient: LlmClient;
  readonly status: () => StatusBody;
}
