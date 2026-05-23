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

export const AppConfigSchema = z.object({
  dataDir: z.string().default('./.data'),
  http: HttpConfigSchema.default({}),
  llm: LlmConfigSchema.default({}),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type HttpConfig = z.infer<typeof HttpConfigSchema>;
export type LlmConfig = z.infer<typeof LlmConfigSchema>;
export type ModelPricing = z.infer<typeof ModelPricingSchema>;
