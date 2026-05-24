/**
 * Phase 5.7 — job-inventory cross-check.
 *
 * Fails when:
 *  1. A handler is registered via `registerScheduledTaskHandler` but
 *     is missing from `docs/dev/architecture/job-inventory.md`.
 *  2. A row in the inventory table references a `kind` no handler
 *     claims.
 *
 * The parser is intentionally strict: it walks every line between
 * the `<!-- job-inventory:start -->` and `<!-- job-inventory:end -->`
 * markers, requires the row to start with `|`, and uses the first
 * pipe-separated column as the `kind`. Backticks around the kind
 * are stripped; everything else is treated as-is.
 *
 * The same parsing rules drive `scripts/docs-check.ts` so the two
 * surfaces fail together — see `AGENTS.md §Pull Requests`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  __resetScheduledTaskRegistryForTests,
  listRegisteredScheduledTaskHandlers,
  registerBuiltInScheduledTaskHandlers,
} from '../../src/scheduled';
import type { LlmCallLog } from '../../src/llm';
import {
  registerChatScheduledTaskHandlers,
  createMockEmbedder,
  createInMemoryLanceWriter,
} from '../../src/chat';

function repoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
}

function inventoryPath(): string {
  return resolve(repoRoot(), 'docs/dev/architecture/job-inventory.md');
}

/**
 * Parse the inventory table out of `job-inventory.md`. Returns the
 * kind for every body row inside the markers. Header + separator
 * rows are skipped.
 */
export function parseInventoryKinds(markdown: string): string[] {
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
    // The table header + the separator (---) both start with `|`.
    // Skip the separator (a row whose every cell is dashes / colons).
    const cells = raw
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length === 0) continue;
    if (cells.every((c) => /^[:\- ]+$/.test(c))) continue;
    const first = cells[0] ?? '';
    // Skip the header row (its first cell is exactly the word `kind`,
    // not surrounded by backticks).
    if (first === 'kind') continue;
    // Strip leading/trailing backticks from the kind cell.
    const kind = first.replace(/^`+|`+$/g, '').trim();
    if (kind.length === 0) continue;
    kinds.push(kind);
  }
  return kinds;
}

describe('phase 5.7 — job-inventory cross-check', () => {
  beforeAll(() => {
    __resetScheduledTaskRegistryForTests();
    const stubLlmCallLog: LlmCallLog = {
      write(): void {
        /* no-op stub */
      },
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
      schemaVersion: 'test-schema',
      busAdapter: 'in-memory',
    });
    // Phase 6.2 — chat-domain handlers also feed the inventory.
    registerChatScheduledTaskHandlers({
      embedder: createMockEmbedder(),
      writer: createInMemoryLanceWriter(),
    });
  });

  afterAll(() => {
    __resetScheduledTaskRegistryForTests();
  });

  it('every registered handler kind appears in docs/dev/architecture/job-inventory.md', () => {
    const inventory = readFileSync(inventoryPath(), 'utf8');
    const documentedKinds = new Set(parseInventoryKinds(inventory));
    const registeredKinds = listRegisteredScheduledTaskHandlers().map((h) => h.kind);

    const missingFromDocs = registeredKinds.filter((k) => !documentedKinds.has(k));
    expect(missingFromDocs).toEqual([]);
  });

  it('every inventory row references a registered handler kind (no stale rows)', () => {
    const inventory = readFileSync(inventoryPath(), 'utf8');
    const documentedKinds = parseInventoryKinds(inventory);
    const registeredKinds = new Set(listRegisteredScheduledTaskHandlers().map((h) => h.kind));

    const staleRows = documentedKinds.filter((k) => !registeredKinds.has(k));
    expect(staleRows).toEqual([]);
  });

  it('the inventory parser yields at least one row (sanity)', () => {
    const inventory = readFileSync(inventoryPath(), 'utf8');
    const documentedKinds = parseInventoryKinds(inventory);
    expect(documentedKinds.length).toBeGreaterThan(0);
  });
});
