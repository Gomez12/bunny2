import { z } from 'zod';

export const HttpConfigSchema = z.object({
  host: z.string().default('127.0.0.1'),
  port: z.number().int().positive().max(65535).default(4317),
});

export const ModelPricingSchema = z.object({
  inputPerMTokens: z.number().nonnegative(),
  outputPerMTokens: z.number().nonnegative(),
});

export const LlmConfigSchema = z.object({
  endpoint: z.string().default('mock://echo'),
  apiKey: z.string().default(''),
  defaultModel: z.string().default('mock-default'),
  // Reserved for phase 1.5+: per-model overrides (temperature, max tokens,
  // etc.). Empty default keeps phase 1.4 honest about what it ships.
  models: z.record(z.string(), z.unknown()).default({}),
  pricing: z.record(z.string(), ModelPricingSchema).default({}),
  retentionDays: z.number().int().positive().default(180),
});

/**
 * Phase 2 auth/session settings. Values flow through `loadConfig` so that
 * the session middleware introduced in 2.2 has stable defaults without a
 * second churn of the config schema.
 *
 * Defaults:
 *  - sessionTtlMinutes: 14 days absolute lifetime.
 *  - sessionIdleMinutes: 24 hours of inactivity before re-login.
 */
export const AuthConfigSchema = z.object({
  sessionTtlMinutes: z
    .number()
    .int()
    .positive()
    .default(60 * 24 * 14),
  sessionIdleMinutes: z
    .number()
    .int()
    .positive()
    .default(60 * 24),
});

/**
 * Phase 3.4 — system locale list.
 *
 * Authoritative answer to "which locales is this deployment willing to
 * accept on a `POST /layers/:slug/locales` call". Defaults mirror the
 * web bundle in `apps/web/src/i18n/index.ts` (`en`, `nl` with `en` as
 * the fallback). Operators may narrow the list per deployment; out of
 * v1 scope (phase-3 plan §11.5) is a DB-backed locales table.
 */
export const LocalesConfigSchema = z
  .object({
    supported: z.array(z.string().min(1)).min(1).default(['en', 'nl']),
    default: z.string().min(1).default('en'),
  })
  .refine((v) => v.supported.includes(v.default), {
    message: 'locales.default must be one of locales.supported',
  });

/**
 * Phase 4a.2 — runtime knob for the per-process connector poll runner.
 *
 * `runnerEnabled: true` (default) starts a `setInterval` that ticks every
 * `tickMs` and asks the dispatcher to refresh any external link whose
 * `synced_at` is older than that link's configured
 * `pollIntervalMinutes`. Set to `false` for smoke / CI runs that should
 * not touch the network.
 */
export const ConnectorsConfigSchema = z.object({
  runnerEnabled: z.boolean().default(true),
  tickMs: z.number().int().positive().default(60_000),
  /**
   * Phase 4b.2 — cap (in bytes) on the `multipart/form-data` body
   * accepted by `POST /l/:slug/<kind>/_ingest/:connectorId`. Default
   * 5 MB — a real vCard export from Google Contacts (~5000 contacts)
   * weighs ~3 MB; the cap protects against an accidental upload of a
   * raw mailbox export or a tar.gz misnamed as `.vcf`. Operators that
   * need to bulk-import larger files raise this in `bunny2.config.ts`.
   */
  ingestMaxBytes: z
    .number()
    .int()
    .positive()
    .default(5 * 1024 * 1024),
});

/**
 * Phase 4a.3 — runtime knobs for the per-process AI enrichment runner.
 *
 * `runnerEnabled: true` (default) starts the runner at boot. The runner
 * subscribes to `entity.<kind>.{created,updated}` for every module that
 * declares `enrichmentJobs` and to `entity.connector.sync.succeeded` —
 * see `apps/server/src/entities/enrichment-runner.ts`. Smoke / CI runs
 * that should not call the LLM pass `false`.
 *
 * `debounceMs` is the per-`(kind, entityId)` window during which
 * multiple events collapse into one job invocation (default 5s). Lower
 * values run jobs more eagerly; higher values save tokens at the cost
 * of a longer "freshness" lag.
 *
 * `maxRunsPerLayerPerMinute` caps the per-layer LLM-call rate at the
 * runner level (default 30). On overflow the runner publishes
 * `entity.enrichment.deferred` and re-arms the entry for the next
 * window slide.
 */
export const EnrichmentConfigSchema = z.object({
  runnerEnabled: z.boolean().default(true),
  debounceMs: z.number().int().positive().default(5_000),
  maxRunsPerLayerPerMinute: z.number().int().positive().default(30),
});

export const AppConfigSchema = z.object({
  dataDir: z.string().default('./.data'),
  http: HttpConfigSchema.default({}),
  llm: LlmConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  locales: LocalesConfigSchema.default({ supported: ['en', 'nl'], default: 'en' }),
  connectors: ConnectorsConfigSchema.default({
    runnerEnabled: true,
    tickMs: 60_000,
    ingestMaxBytes: 5 * 1024 * 1024,
  }),
  enrichment: EnrichmentConfigSchema.default({
    runnerEnabled: true,
    debounceMs: 5_000,
    maxRunsPerLayerPerMinute: 30,
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type HttpConfig = z.infer<typeof HttpConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type LocalesConfig = z.infer<typeof LocalesConfigSchema>;
export type ConnectorsConfig = z.infer<typeof ConnectorsConfigSchema>;
export type EnrichmentConfig = z.infer<typeof EnrichmentConfigSchema>;
export type ModelPricing = z.infer<typeof ModelPricingSchema>;
