import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Where the user-editable config file lives. In a portable build it sits
 * next to the executable; in dev it sits next to the repo root (cwd).
 * Honors `BUNNY2_CONFIG` env override.
 *
 * Returns `null` when no config file is present — the loader then falls
 * back to schema defaults.
 */
export function resolveConfigFile(cwd: string = process.cwd()): string | null {
  const override = process.env['BUNNY2_CONFIG'];
  if (override && override.length > 0) {
    return path.resolve(override);
  }
  const candidate = path.join(cwd, 'config.json');
  return fs.existsSync(candidate) ? candidate : null;
}

/**
 * Resolve the data-dir to an absolute path. `BUNNY2_DATA_DIR` env wins
 * over the config value. Relative paths resolve against `cwd`.
 */
export function resolveDataDir(configDataDir: string, cwd: string = process.cwd()): string {
  const override = process.env['BUNNY2_DATA_DIR'];
  const raw = override && override.length > 0 ? override : configDataDir;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}
