import * as fs from 'node:fs';

/**
 * Remove a directory, retrying on EBUSY.
 *
 * Windows holds a brief lock on SQLite WAL/SHM files even after
 * `db.close()`. Node's `fs.rmSync({ maxRetries, retryDelay })` covers
 * this, but Bun ignores those options today, so we run the loop
 * ourselves.
 */
export function safeRmSync(
  dir: string,
  opts: { maxRetries?: number; delayMs?: number } = {},
): void {
  const maxRetries = opts.maxRetries ?? 20;
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
  throw lastError;
}
