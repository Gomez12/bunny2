import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/storage/sqlite';
import { createSqliteLlmCallLog } from '../src/llm/call-log';
import { startLlmRetentionPrune } from '../src/llm/prune';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-llmprune-'));
}

function seedRow(
  db: ReturnType<typeof openDatabase>,
  id: string,
  startedAt: string,
  model = 'm',
): void {
  db.query<unknown, [string, string, string, string, string]>(
    `INSERT INTO llm_calls (id, started_at, model, endpoint, request)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, startedAt, model, 'mock://echo', '{}');
}

describe('LLM retention prune', () => {
  it('deletes only rows older than the cutoff and returns the count', () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const log = createSqliteLlmCallLog(db);
      // "Today" for the test = 2026-05-23T00:00Z. Retention = 30 days.
      const now = new Date('2026-05-23T00:00:00.000Z');
      seedRow(db, 'old-1', '2026-01-01T00:00:00.000Z');
      seedRow(db, 'old-2', '2026-04-01T00:00:00.000Z');
      seedRow(db, 'edge-cutoff', '2026-04-23T00:00:00.001Z'); // just inside the window
      seedRow(db, 'recent', '2026-05-22T12:00:00.000Z');
      expect(log.count()).toBe(4);

      let deletedMsg = '';
      const handle = startLlmRetentionPrune({
        log,
        retentionDays: 30,
        intervalMs: 60_000, // long, we only care about the immediate first pass
        clock: () => now,
        logger: (m) => {
          deletedMsg = m;
        },
      });

      try {
        // The constructor already ran one pass; verify it removed exactly
        // the two old rows.
        expect(log.count()).toBe(2);
        expect(deletedMsg).toMatch(/removed 2 row/);

        const surviving = db
          .query<{ id: string }, []>('SELECT id FROM llm_calls ORDER BY id')
          .all()
          .map((r) => r.id);
        expect(surviving).toEqual(['edge-cutoff', 'recent']);

        // A second manual pass with the same clock removes nothing.
        const deleted = handle.runOnce();
        expect(deleted).toBe(0);
      } finally {
        handle.stop();
      }
    } finally {
      db.close();
    }
  });

  it('is a no-op when no rows are older than the cutoff', () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const log = createSqliteLlmCallLog(db);
      seedRow(db, 'fresh', '2026-05-23T00:00:00.000Z');
      const handle = startLlmRetentionPrune({
        log,
        retentionDays: 1,
        intervalMs: 60_000,
        clock: () => new Date('2026-05-23T01:00:00.000Z'),
        logger: () => {
          /* silent */
        },
      });
      try {
        expect(log.count()).toBe(1);
        expect(handle.runOnce()).toBe(0);
      } finally {
        handle.stop();
      }
    } finally {
      db.close();
    }
  });
});
