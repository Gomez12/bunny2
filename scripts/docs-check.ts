#!/usr/bin/env bun
/**
 * `bun run docs:check` — repo-wide doc invariants.
 *
 * Per `AGENTS.md §Pull Requests`:
 *  - no `done` plans left in `docs/dev/plans/` (must move to `done/` subdir).
 *  - tasklist has at most 50 `done` rows; otherwise archive prompt.
 *  - every `job.kind` registered via the per-domain `register…Handler`
 *    helpers wired in `apps/server/src/index.ts` appears in the
 *    `docs/dev/architecture/job-inventory.md` table. The matching
 *    `apps/server/tests/docs/job-inventory.test.ts` runs the same diff
 *    in `bun test`.
 *
 * The richer plan ↔ tasklist cross-reference rule is documented in
 * AGENTS.md but stays out of this script — it requires a heavier
 * markdown parser than the two-grep guard above. Tracked as a docs
 * follow-up.
 */
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __resetScheduledTaskRegistryForTests,
  listRegisteredScheduledTaskHandlers,
  registerBuiltInScheduledTaskHandlers,
} from '../apps/server/src/scheduled';
import type { LlmCallLog } from '../apps/server/src/llm';
import {
  registerChatScheduledTaskHandlers,
  createMockEmbedder,
  createInMemoryLanceWriter,
} from '../apps/server/src/chat';
import { registerProposalsScheduledTaskHandlers } from '../apps/server/src/proposals';
import { registerWhiteboardsScheduledTaskHandlers } from '../apps/server/src/entities/whiteboards';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const plansDir = join(repoRoot, 'docs/dev/plans');
const tasklistPath = join(repoRoot, 'docs/dev/tasklist.md');
const inventoryPath = join(repoRoot, 'docs/dev/architecture/job-inventory.md');

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

/**
 * Walk every line inside the inventory file's
 * `<!-- job-inventory:start -->` / `:end --> ` markers, skip the
 * header + separator rows, return the `kind` cell from each body row.
 *
 * Exported in spirit (same parser shape) for
 * `apps/server/tests/docs/job-inventory.test.ts` — the two files share
 * the parsing rules, not the parser instance, so neither file imports
 * the other (keeps the dependency graph one-way: tests → src, script
 * → src).
 */
function parseInventoryKinds(markdown: string): string[] {
  const lines = markdown.split('\n');
  const startIdx = lines.findIndex((l) => l.includes('<!-- job-inventory:start -->'));
  const endIdx = lines.findIndex((l) => l.includes('<!-- job-inventory:end -->'));
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new Error(
      'job-inventory: could not find <!-- job-inventory:start --> / :end --> markers',
    );
  }
  const kinds: string[] = [];
  for (let i = startIdx + 1; i < endIdx; i += 1) {
    const raw = lines[i]?.trim() ?? '';
    if (raw.length === 0) continue;
    if (!raw.startsWith('|')) continue;
    const cells = raw
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length === 0) continue;
    if (cells.every((c) => /^[:\- ]+$/.test(c))) continue;
    const first = cells[0] ?? '';
    if (first === 'kind') continue;
    const kind = first.replace(/^`+|`+$/g, '').trim();
    if (kind.length === 0) continue;
    kinds.push(kind);
  }
  return kinds;
}

async function checkJobInventory(): Promise<void> {
  // Register the built-in handlers against a stub call-log so the
  // registry mirrors the production set. Handlers are pure functions;
  // registration runs zero work.
  __resetScheduledTaskRegistryForTests();
  const stubLlmCallLog: LlmCallLog = {
    write(): void {},
    count(): number {
      return 0;
    },
    pruneOlderThan(): number {
      return 0;
    },
  };
  registerBuiltInScheduledTaskHandlers({
    llmCallLog: stubLlmCallLog,
    llmRetentionDays: 180,
    schemaVersion: 'docs-check',
    busAdapter: 'docs-check',
  });
  // Phase 6.2 — register chat-domain handlers against in-memory deps
  // so the documented set lines up with what production wires up.
  registerChatScheduledTaskHandlers({
    embedder: createMockEmbedder(),
    writer: createInMemoryLanceWriter(),
  });
  // Phase 7.6 — proposals-domain handlers also feed the inventory.
  registerProposalsScheduledTaskHandlers();
  // Phase 11.3 — whiteboards-domain handlers feed the inventory too.
  registerWhiteboardsScheduledTaskHandlers();
  const registered = new Set(listRegisteredScheduledTaskHandlers().map((h) => h.kind));
  const body = await readFile(inventoryPath, 'utf8');
  const documented = parseInventoryKinds(body);
  const documentedSet = new Set(documented);

  for (const kind of registered) {
    if (!documentedSet.has(kind)) {
      fail(
        `scheduled-task handler '${kind}' is registered but missing from docs/dev/architecture/job-inventory.md.`,
      );
    }
  }
  for (const kind of documented) {
    if (!registered.has(kind)) {
      fail(
        `docs/dev/architecture/job-inventory.md lists handler '${kind}' but no handler is registered for that kind.`,
      );
    }
  }

  // Be a good citizen: reset the registry so re-imports from a single
  // bun process do not collide. The script is one-shot but the
  // registry is module-global.
  __resetScheduledTaskRegistryForTests();
}

await checkNoDonePlansAtTopLevel();
await checkTasklistDoneRowCount();
await checkJobInventory();

if (failed) process.exit(1);
console.log('docs:check OK');
