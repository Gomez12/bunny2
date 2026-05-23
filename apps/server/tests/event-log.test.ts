import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InMemoryMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
  telemetryMiddleware,
} from '@bunny2/bus';
import { openDatabase } from '../src/storage/sqlite';
import { createSqliteEventLog, replayEvents } from '../src/bus/event-log';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-evlog-'));
}

describe('SqliteEventLog', () => {
  it('persists published events and replays them in (occurred_at, id) order', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const log = createSqliteEventLog(db);
      const bus = new InMemoryMessageBus({
        middlewares: [
          correlationIdMiddleware,
          telemetryMiddleware(log.writer),
          errorCaptureMiddleware(() => {
            /* swallow in test */
          }),
        ],
      });

      // Publish two events with explicit, ordered timestamps so the replay
      // assertion does not depend on wall-clock granularity.
      const first = await bus.publish({
        type: 'demo.first',
        payload: { n: 1 },
        occurredAt: '2026-05-23T10:00:00.000Z',
        flowId: 'flow-x',
      });
      const second = await bus.publish({
        type: 'demo.second',
        payload: { n: 2 },
        occurredAt: '2026-05-23T10:00:01.000Z',
      });

      expect(log.count()).toBe(2);

      const replayed = [...replayEvents(db)];
      expect(replayed).toHaveLength(2);
      expect(replayed[0]?.id).toBe(first.id);
      expect(replayed[1]?.id).toBe(second.id);
      expect(replayed[0]?.payload).toEqual({ n: 1 });
      expect(replayed[1]?.payload).toEqual({ n: 2 });
      expect(replayed[0]?.correlationId).toBeTruthy();
      expect(replayed[0]?.flowId).toBe('flow-x');
    } finally {
      db.close();
    }
  });

  it('filters by type and time range', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const log = createSqliteEventLog(db);
      const bus = new InMemoryMessageBus({
        middlewares: [telemetryMiddleware(log.writer)],
      });

      await bus.publish({
        type: 'a',
        payload: null,
        occurredAt: '2026-05-23T09:00:00.000Z',
      });
      await bus.publish({
        type: 'b',
        payload: null,
        occurredAt: '2026-05-23T10:00:00.000Z',
      });
      await bus.publish({
        type: 'a',
        payload: null,
        occurredAt: '2026-05-23T11:00:00.000Z',
      });

      const onlyA = [...replayEvents(db, { type: 'a' })];
      expect(onlyA.map((e) => e.type)).toEqual(['a', 'a']);

      const window = [
        ...replayEvents(db, {
          since: '2026-05-23T09:30:00.000Z',
          until: '2026-05-23T10:30:00.000Z',
        }),
      ];
      expect(window.map((e) => e.type)).toEqual(['b']);
    } finally {
      db.close();
    }
  });
});
