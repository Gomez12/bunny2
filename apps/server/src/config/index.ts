import * as fs from 'node:fs';
import { AppConfigSchema, type AppConfig } from './schema';
import { resolveConfigFile, resolveDataDir } from './paths';

export interface LoadedConfig {
  config: AppConfig;
  configFile: string | null;
  dataDir: string;
}

export function loadConfig(opts: { cwd?: string } = {}): LoadedConfig {
  const cwd = opts.cwd ?? process.cwd();
  const configFile = resolveConfigFile(cwd);

  let raw: unknown = {};
  if (configFile) {
    const text = fs.readFileSync(configFile, 'utf8');
    raw = JSON.parse(text) as unknown;
  }

  const parsed = AppConfigSchema.parse(raw);
  const dataDir = resolveDataDir(parsed.dataDir, cwd);
  fs.mkdirSync(dataDir, { recursive: true });

  return {
    config: { ...parsed, dataDir },
    configFile,
    dataDir,
  };
}

export { AppConfigSchema };
export type { AppConfig, HttpConfig, LlmConfig, ModelPricing } from './schema';
