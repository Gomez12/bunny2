import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Runs the repo-level `scripts/i18n-check.ts` as a subprocess and asserts
 * it exits successfully. The script enforces:
 *
 *  - No hardcoded JSX text or user-facing attribute literals under
 *    `apps/web/src/`.
 *  - Every static `t('…')` key is present in `en.json`.
 *
 * Using a subprocess keeps the test free of any DOM dependency and
 * matches how the script runs in CI / `bun run i18n:check`.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

describe('i18n discipline', () => {
  it('passes the repo-wide i18n-check script with zero violations', () => {
    const result = spawnSync(process.execPath, ['run', 'scripts/i18n-check.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error('stdout:', result.stdout);
      console.error('stderr:', result.stderr);
    }
    expect(result.status).toBe(0);
  });
});
