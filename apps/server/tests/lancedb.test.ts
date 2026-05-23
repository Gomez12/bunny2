import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openLanceDB } from '../src/storage/lancedb';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-lance-'));
}

describe('lancedb', () => {
  it('opens an empty lancedb directory inside data-dir', async () => {
    const dir = mkTmp();
    const conn = await openLanceDB(dir);
    const names = await conn.tableNames();
    expect(Array.isArray(names)).toBe(true);
    expect(names).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, 'lancedb'))).toBe(true);
  });
});
