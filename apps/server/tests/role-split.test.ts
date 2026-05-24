/**
 * Phase 5.2 — role-split integration test.
 *
 * Instead of spawning two `apps/server/src/index.ts` processes
 * (`Bun.spawn` adds CI matrix flake and the task brief explicitly
 * authorizes a simulation), this drives the production seam directly:
 *
 *   - One `DurableSqliteMessageBus` instance plays the "web" role —
 *     it publishes into the shared SQLite outbox but its consumer
 *     loop is never started, mirroring the `role === 'web'` branch
 *     in `apps/server/src/index.ts` that skips every periodic
 *     runner. (The production `index.ts` still calls `bus.start()`
 *     on web; the test omits it so the assertions can prove the
 *     worker — not the web bus — is the one that delivered the row.)
 *   - A second `DurableSqliteMessageBus` instance plays the
 *     "worker" role — same DB, distinct `subscriberKey`, started so
 *     its consumer loop drains the outbox.
 *
 * Assertions:
 *
 *   1. The published row is initially `pending` in `bus_outbox`.
 *   2. After the worker's `drain()`, the row is `delivered`.
 *   3. The worker's `bus_offsets` row advances to the outbox id.
 *   4. The worker's subscribed handler observed the event.
 *   5. The web bus's offset row was never written (proves the web
 *      bus's consumer loop did not run).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import { DurableSqliteMessageBus } from '@bunny2/bus';
import type { BusEvent } from '@bunny2/bus';
import { openDatabase } from '../src/storage/sqlite';
import { writeEventRow } from '../src/bus/event-log';
import { safeRmSync } from './_helpers/temp-dir';

interface OutboxStatusRow {
  status: string;
}

interface OffsetRow {
  last_id: string;
}

describe('phase 5.2 — role split simulation against a shared DB', () => {
  let dir: string;
  let db: Database;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-role-split-'));
    db = openDatabase(dir);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    try {
      safeRmSync(dir);
    } catch {
      /* best effort */
    }
  });

  it('web publishes, worker consumes — outbox flips to delivered and worker offset advances', async () => {
    // "Web" bus: publishes events into the durable outbox. The
    // consumer loop is NOT started so this bus never delivers
    // anything itself — exactly the runtime shape `role === 'web'`
    // gives us in production (modulo `bus.start()` which production
    // does call but which is harmless when there are no handlers).
    const webBus = new DurableSqliteMessageBus(db, {
      writeEvent: (event) => writeEventRow(db, event),
      subscriberKey: 'web-main',
    });

    // "Worker" bus: same DB, distinct subscriberKey, consumer loop
    // ON. Subscribes to the event type before `drain()` so the
    // handler captures the row.
    const workerObserved: BusEvent[] = [];
    const workerBus = new DurableSqliteMessageBus(db, {
      writeEvent: (event) => writeEventRow(db, event),
      subscriberKey: 'worker-main',
    });
    workerBus.subscribe('role.split.smoke', (event) => {
      workerObserved.push(event);
    });
    workerBus.start();

    try {
      // 1. Web publishes. The publish path inserts into `events` +
      //    `bus_outbox` in one transaction, then resolves; the row
      //    is durably `pending` even though no consumer has touched
      //    it yet.
      const published = await webBus.publish({
        type: 'role.split.smoke',
        payload: { from: 'web' },
      });

      const initial = db
        .query<OutboxStatusRow, [string]>('SELECT status FROM bus_outbox WHERE id = ?')
        .get(published.id);
      expect(initial?.status).toBe('pending');

      // 2. Worker drains. `drain()` pumps until the outbox is empty
      //    for the worker's subscriber key, so the test does not
      //    need to sleep on the 250ms poll cadence.
      await workerBus.drain();

      // 3. Outbox row is delivered.
      const final = db
        .query<OutboxStatusRow, [string]>('SELECT status FROM bus_outbox WHERE id = ?')
        .get(published.id);
      expect(final?.status).toBe('delivered');

      // 4. Worker offset row advanced to the outbox id.
      const offset = db
        .query<OffsetRow, [string]>('SELECT last_id FROM bus_offsets WHERE subscriber_key = ?')
        .get('worker-main');
      expect(offset?.last_id).toBe(published.id);

      // 5. Worker handler actually fired.
      expect(workerObserved).toHaveLength(1);
      expect(workerObserved[0]?.id).toBe(published.id);
      expect(workerObserved[0]?.payload).toEqual({ from: 'web' });

      // 6. Web's consumer loop was never started, so no `bus_offsets`
      //    row exists for `web-main`. Proves the role gate worked:
      //    the worker — not the web process — is what delivered
      //    the row.
      const webOffset = db
        .query<OffsetRow, [string]>('SELECT last_id FROM bus_offsets WHERE subscriber_key = ?')
        .get('web-main');
      expect(webOffset).toBeNull();
    } finally {
      workerBus.stop();
      webBus.stop();
    }
  });
});
