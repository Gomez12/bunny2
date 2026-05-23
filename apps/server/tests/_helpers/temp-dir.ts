import * as fs from 'node:fs';

/**
 * Remove a directory best-effort. On Windows, `bun:sqlite` keeps the
 * DB file handle open after `db.close()` long enough that `fs.rmSync`
 * fails with EBUSY. We retry a few times, then swallow the error and
 * log it — temp dirs live under `os.tmpdir()` and CI runners are
 * ephemeral, so leaking one is harmless.
 */
export function safeRmSync(
  dir: string,
  opts: { maxRetries?: number; delayMs?: number } = {},
): void {
  const maxRetries = opts.maxRetries ?? 10;
  const delayMs = opts.delayMs ?? 100;
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastError = err;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBUSY' && code !== 'EPERM' && code !== 'ENOTEMPTY') {
        throw err;
      }
      Bun.sleepSync(delayMs);
    }
  }
  console.warn(
    `[safeRmSync] could not remove ${dir} after ${maxRetries + 1} attempts: ${String(lastError)}`,
  );
}
