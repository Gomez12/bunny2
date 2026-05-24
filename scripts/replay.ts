#!/usr/bin/env bun
/**
 * Replay the event log to a fresh in-memory subscriber.
 *
 * Usage:
 *   bun run replay [--type=foo.bar] [--since=ISO] [--until=ISO] [--limit=N]
 *
 * Reads from the same SQLite database as the server (resolved via the same
 * config loader) and re-publishes each event into a brand-new
 * `InMemoryMessageBus`. A wildcard subscriber counts total + per-type.
 *
 * This proves event sourcing is real: state is rebuildable from the log
 * alone, with no live producers.
 */
import type { BusEvent } from '../packages/bus/src';
import { InMemoryMessageBus } from '../packages/bus/test-utils';
import { loadConfig } from '../apps/server/src/config';
import { openDatabase } from '../apps/server/src/storage/sqlite';
import { replayEvents, type ReplayOptions } from '../apps/server/src/bus/event-log';

interface ParsedFlags {
  readonly opts: ReplayOptions;
  readonly help: boolean;
}

function parseArgs(argv: readonly string[]): ParsedFlags {
  let help = false;
  let type: string | undefined;
  let since: string | undefined;
  let until: string | undefined;
  let limit: number | undefined;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) continue;
    const key = arg.slice(0, eq);
    const value = arg.slice(eq + 1);
    switch (key) {
      case '--type':
        type = value;
        break;
      case '--since':
        since = value;
        break;
      case '--until':
        until = value;
        break;
      case '--limit': {
        const n = Number.parseInt(value, 10);
        if (Number.isFinite(n) && n > 0) limit = n;
        break;
      }
      default:
        // ignore unknown flags
        break;
    }
  }
  const opts: ReplayOptions = {
    ...(type !== undefined ? { type } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
  return { opts, help };
}

function printHelp(): void {
  console.log(
    [
      'Usage: bun run replay [--type=foo.bar] [--since=ISO] [--until=ISO] [--limit=N]',
      '',
      'Reads events from the configured SQLite data-dir and re-publishes them',
      'through a fresh InMemoryMessageBus, printing total + per-type counts.',
    ].join('\n'),
  );
}

const { help, opts } = parseArgs(Bun.argv.slice(2));
if (help) {
  printHelp();
  process.exit(0);
}

const { dataDir } = loadConfig();
const db = openDatabase(dataDir);

const byType = new Map<string, number>();
let total = 0;

const bus = new InMemoryMessageBus();
const seen = new Set<string>();

function ensureSubscribed(type: string): void {
  if (seen.has(type)) return;
  seen.add(type);
  bus.subscribe(type, (event: BusEvent) => {
    total += 1;
    byType.set(event.type, (byType.get(event.type) ?? 0) + 1);
  });
}

for (const event of replayEvents(db, opts)) {
  ensureSubscribed(event.type);
  // Preserve identity so subscribers see exactly what was logged.
  await bus.publish({
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    payload: event.payload,
    ...(event.correlationId !== undefined ? { correlationId: event.correlationId } : {}),
    ...(event.flowId !== undefined ? { flowId: event.flowId } : {}),
    ...(event.metadata !== undefined ? { metadata: event.metadata } : {}),
  });
}

db.close();

console.log(`replayed ${total} event(s) from ${dataDir}`);
if (total > 0) {
  const lines = [...byType.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([type, n]) => `  ${type}: ${n}`);
  console.log(lines.join('\n'));
}
