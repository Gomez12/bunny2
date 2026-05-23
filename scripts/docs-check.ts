#!/usr/bin/env bun
/**
 * Lightweight docs:check for phase 1.1.
 *
 * Today it only enforces the two cheapest rules from `AGENTS.md` §Pull Requests:
 *  - no `done` plans left in `docs/dev/plans/` (must move to `done/` subdir).
 *  - tasklist has at most 50 `done` rows; otherwise archive prompt.
 *
 * The richer checks (plan ↔ tasklist cross-reference, job inventory, etc.) land
 * with their respective phases.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repoRoot = new URL('..', import.meta.url).pathname;
const plansDir = join(repoRoot, 'docs/dev/plans');
const tasklistPath = join(repoRoot, 'docs/dev/tasklist.md');

let failed = false;
const fail = (msg: string): void => {
  console.error(`docs:check FAIL — ${msg}`);
  failed = true;
};

async function checkNoDonePlansAtTopLevel(): Promise<void> {
  const entries = await readdir(plansDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const body = await readFile(join(plansDir, entry.name), 'utf8');
    const firstStatusLine = body.split('\n').find((l) => /^\s*status\s*:/i.test(l));
    if (firstStatusLine && /done/i.test(firstStatusLine)) {
      fail(
        `plan \`${entry.name}\` is marked done but still lives in docs/dev/plans/. Move it to docs/dev/plans/done/.`,
      );
    }
  }
}

async function checkTasklistDoneRowCount(): Promise<void> {
  const body = await readFile(tasklistPath, 'utf8');
  const doneRows = body.split('\n').filter((l) => /^\|\s*done\s*\|/i.test(l)).length;
  if (doneRows > 50) {
    fail(
      `tasklist has ${doneRows} done rows (>50). Move the oldest to docs/dev/tasklistarchive.md.`,
    );
  }
}

await checkNoDonePlansAtTopLevel();
await checkTasklistDoneRowCount();

if (failed) process.exit(1);
console.log('docs:check OK');
