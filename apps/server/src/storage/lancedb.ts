import * as fs from 'node:fs';
import * as path from 'node:path';
import { connect } from '@lancedb/lancedb';

export type LanceConnection = Awaited<ReturnType<typeof connect>>;

export async function openLanceDB(dataDir: string): Promise<LanceConnection> {
  const lanceDir = path.join(dataDir, 'lancedb');
  fs.mkdirSync(lanceDir, { recursive: true });
  return await connect(lanceDir);
}
