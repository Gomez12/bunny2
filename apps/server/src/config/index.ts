import * as fs from 'node:fs';
import { AppConfigSchema, type AppConfig } from './schema';
import { resolveConfigFile, resolveDataDir } from './paths';

export interface LoadedConfig {
  config: AppConfig;
  configFile: string | null;
  dataDir: string;
}

/**
 * Apply env-based overrides to the validated config. Today the Electron
 * sidecar (phase 1.6) uses `BUNNY2_HTTP_PORT` / `BUNNY2_HTTP_HOST` to inject
 * a pre-probed free port; the same mechanism remains useful for tests and
 * deployments. Keeps the schema authoritative — env can only narrow values
 * that the schema already validates.
 */
function applyHttpEnvOverrides(parsed: AppConfig): AppConfig {
  const port = process.env['BUNNY2_HTTP_PORT'];
  const host = process.env['BUNNY2_HTTP_HOST'];
  if ((port === undefined || port.length === 0) && (host === undefined || host.length === 0)) {
    return parsed;
  }
  const http = { ...parsed.http };
  if (port !== undefined && port.length > 0) {
    const n = Number.parseInt(port, 10);
    if (!Number.isFinite(n) || n <= 0 || n > 65535) {
      throw new Error(`BUNNY2_HTTP_PORT is not a valid port: ${port}`);
    }
    http.port = n;
  }
  if (host !== undefined && host.length > 0) {
    http.host = host;
  }
  return { ...parsed, http };
}

/**
 * Phase 4c.2 — secrets-block env overrides. `BUNNY2_ENCRYPTION_KEY` wins
 * over a value in `bunny2.config.ts` so operators can rotate the key
 * without editing the file. Validation of the key shape happens lazily
 * in `apps/server/src/storage/secrets.ts` so an absent / malformed key
 * does NOT block boot — only attempts to encrypt fail.
 */
function applySecretsEnvOverrides(parsed: AppConfig): AppConfig {
  const key = process.env['BUNNY2_ENCRYPTION_KEY'];
  if (key === undefined || key.length === 0) return parsed;
  return { ...parsed, secrets: { ...parsed.secrets, encryptionKey: key } };
}

export function loadConfig(opts: { cwd?: string } = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const configFile = resolveConfigFile(cwd);

  let raw: unknown = {};
  if (configFile) {
    const text = fs.readFileSync(configFile, 'utf8');
    raw = JSON.parse(text) as unknown;
  }

  const parsedRaw = AppConfigSchema.parse(raw);
  const parsedHttp = applyHttpEnvOverrides(parsedRaw);
  const parsed = applySecretsEnvOverrides(parsedHttp);
  const dataDir = resolveDataDir(parsed.dataDir, cwd);
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    config: { ...parsed, dataDir },
    configFile,
    dataDir,
  };
}

export { AppConfigSchema };
export type { AppConfig, HttpConfig, LlmConfig, ModelPricing, EmbeddingsConfig } from './schema';
