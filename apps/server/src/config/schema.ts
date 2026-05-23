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

export const AppConfigSchema = z.object({
  dataDir: z.string().default('./.data'),
  http: HttpConfigSchema.default({}),
  llm: LlmConfigSchema.default({}),
  auth: AuthConfigSchema.default({}),
  locales: LocalesConfigSchema.default({ supported: ['en', 'nl'], default: 'en' }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type HttpConfig = z.infer<typeof HttpConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type LocalesConfig = z.infer<typeof LocalesConfigSchema>;
export type ModelPricing = z.infer<typeof ModelPricingSchema>;
