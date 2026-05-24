import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';
import {
  DurableSqliteMessageBus,
  type BusEvent,
  type EventRowWriter,
  type MessageBus,
  type Middleware,
} from '../src';
import { InMemoryMessageBus } from '../test-utils';

/**
 * Adapter contract harness. Every `MessageBus` implementation must
 * pass this suite. The harness takes a factory that builds a bus
 * (with optional middlewares) and an optional `awaitDelivery`
 * helper used after a `publish()` to wait for handlers to run on
 * adapters whose delivery is asynchronous (the durable adapter).
 *
 * The in-memory adapter dispatches inside `publish()` so its
 * `awaitDelivery` is a no-op.
 */
interface AdapterHarness {
  readonly bus: MessageBus;
  readonly awaitDelivery: () => Promise<void>;
  readonly teardown: () => void;
}

type AdapterFactory = (mws?: readonly Middleware[]) => AdapterHarness;

function runBusContract(name: string, build: AdapterFactory): void {
  describe(`MessageBus contract: ${name}`, () => {
    let harness: AdapterHarness | null = null;

    afterEach(() => {
      harness?.teardown();
      harness = null;
    });

    function make(mws?: readonly Middleware[]): MessageBus {
      harness = build(mws);
      return harness.bus;
    }

    async function drain(): Promise<void> {
      await harness?.awaitDelivery();
    }

    it('delivers a published event to a subscribed handler', async () => {
      const bus = make();
      const seen: BusEvent[] = [];
      bus.subscribe('demo.ping', async (event) => {
        seen.push(event);
      });

      const published = await bus.publish({ type: 'demo.ping', payload: { msg: 'hi' } });
      await drain();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.id).toBe(published.id);
      expect(seen[0]?.type).toBe('demo.ping');
      expect(seen[0]?.payload).toEqual({ msg: 'hi' });
      expect(typeof seen[0]?.occurredAt).toBe('string');
    });

    it('assigns id and occurredAt when the caller does not supply them', async () => {
      const bus = make();
      const received: BusEvent[] = [];
      bus.subscribe('demo.auto', (event) => {
        received.push(event);
      });

      const a = await bus.publish({ type: 'demo.auto', payload: 1 });
      const b = await bus.publish({ type: 'demo.auto', payload: 2 });
      await drain();

      expect(a.id).toBeTruthy();
      expect(b.id).toBeTruthy();
      expect(a.id).not.toBe(b.id);
      expect(received).toHaveLength(2);
    });

    it('delivers to every handler registered for a type', async () => {
      const bus = make();
      const order: string[] = [];
      bus.subscribe('demo.fan', () => {
        order.push('a');
      });
      bus.subscribe('demo.fan', () => {
        order.push('b');
      });
      bus.subscribe('demo.fan', () => {
        order.push('c');
      });

      await bus.publish({ type: 'demo.fan', payload: null });
      await drain();

      expect(order).toEqual(['a', 'b', 'c']);
    });

    it('isolates events by type so unrelated subscribers do not fire', async () => {
      const bus = make();
      let aCount = 0;
      let bCount = 0;
      bus.subscribe('demo.a', () => {
        aCount += 1;
      });
      bus.subscribe('demo.b', () => {
        bCount += 1;
      });

      await bus.publish({ type: 'demo.a', payload: null });
      await bus.publish({ type: 'demo.a', payload: null });
      await bus.publish({ type: 'demo.b', payload: null });
      await drain();

      expect(aCount).toBe(2);
      expect(bCount).toBe(1);
    });

    it('stops delivering after unsubscribe', async () => {
      const bus = make();
      let calls = 0;
      const off = bus.subscribe('demo.off', () => {
        calls += 1;
      });

      await bus.publish({ type: 'demo.off', payload: null });
      await drain();
      off();
      await bus.publish({ type: 'demo.off', payload: null });
      await drain();

      expect(calls).toBe(1);
    });

    it('runs middlewares in declared order, terminating in handler dispatch', async () => {
      const trace: string[] = [];
      const mwA: Middleware = async (event, next) => {
        trace.push('a:before');
        await next(event);
        trace.push('a:after');
      };
      const mwB: Middleware = async (event, next) => {
        trace.push('b:before');
        await next(event);
        trace.push('b:after');
      };
      const bus = make([mwA, mwB]);
      bus.subscribe('demo.chain', () => {
        trace.push('handler');
      });

      await bus.publish({ type: 'demo.chain', payload: null });
      await drain();

      expect(trace).toEqual(['a:before', 'b:before', 'handler', 'b:after', 'a:after']);
    });

    it('keeps the bus alive when a handler throws', async () => {
      const bus = make();
      let goodCalls = 0;
      bus.subscribe('demo.bad', () => {
        throw new Error('boom');
      });
      bus.subscribe('demo.bad', () => {
        goodCalls += 1;
      });

      // Should not reject — per-handler isolation in the adapter.
      await bus.publish({ type: 'demo.bad', payload: null });
      await bus.publish({ type: 'demo.bad', payload: null });
      await drain();

      expect(goodCalls).toBe(2);
    });
  });
}

// ---------------------------------------------------------------
// In-memory adapter — the test fixture.
// ---------------------------------------------------------------

runBusContract('InMemoryMessageBus', (mws) => {
  const bus = new InMemoryMessageBus({
    middlewares: mws ?? [],
    onHandlerError: () => {
      /* swallow noisy logs in tests */
    },
  });
  return {
    bus,
    awaitDelivery: async () => {
      // No-op — the in-memory bus dispatches inline.
    },
    teardown: () => {
      /* no resources to release */
    },
  };
});

// ---------------------------------------------------------------
// Durable SQLite adapter — the production adapter (phase 5.1).
// ---------------------------------------------------------------

function makeDurableHarness(mws: readonly Middleware[] | undefined): AdapterHarness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-bus-durable-'));
  const dbPath = path.join(dir, 'bus.sqlite');
  const db = new Database(dbPath, { create: true });
  db.exec('PRAGMA journal_mode = MEMORY');
  db.exec('PRAGMA foreign_keys = ON');
  bootstrapDurableSchema(db);
  const writeEvent: EventRowWriter = (event) => {
    db.query<
      unknown,
      [string, string, string, string | null, string | null, string, string | null]
    >(
      `INSERT INTO events (id, type, occurred_at, correlation_id, flow_id, payload, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.type,
      event.occurredAt,
      event.correlationId ?? null,
      event.flowId ?? null,
      JSON.stringify(event.payload ?? null),
      event.metadata === undefined ? null : JSON.stringify(event.metadata),
    );
  };
  const bus = new DurableSqliteMessageBus(db, {
    writeEvent,
    middlewares: mws ?? [],
    onHandlerError: () => {
      /* swallow noisy logs in tests */
    },
    pollIntervalMs: 5,
  });
  bus.start();
  return {
    bus,
    awaitDelivery: async () => {
      await bus.drain();
    },
    teardown: () => {
      bus.stop();
      try {
        db.close();
      } catch {
        /* already closed */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    },
  };
}

runBusContract('DurableSqliteMessageBus', makeDurableHarness);

// ---------------------------------------------------------------
// Durable-only assertions (boot replay, abandoned, DLQ, replay).
// ---------------------------------------------------------------

describe('DurableSqliteMessageBus — durable-only contract', () => {
  let dir = '';
  let db: Database | null = null;
  let bus: DurableSqliteMessageBus | null = null;

  function writer(database: Database): EventRowWriter {
    return (event) => {
      database
        .query<
          unknown,
          [string, string, string, string | null, string | null, string, string | null]
        >(
          `INSERT INTO events (id, type, occurred_at, correlation_id, flow_id, payload, metadata)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.id,
          event.type,
          event.occurredAt,
          event.correlationId ?? null,
          event.flowId ?? null,
          JSON.stringify(event.payload ?? null),
          event.metadata === undefined ? null : JSON.stringify(event.metadata),
        );
    };
  }

  function freshDb(): Database {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-bus-durable-only-'));
    const d = new Database(path.join(dir, 'bus.sqlite'), { create: true });
    d.exec('PRAGMA journal_mode = MEMORY');
    d.exec('PRAGMA foreign_keys = ON');
    bootstrapDurableSchema(d);
    return d;
  }

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    bus?.stop();
    bus = null;
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    db = null;
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('replays a published row on boot when the previous process crashed before consume', async () => {
    // Simulate a publish from a previous process: an outbox row in
    // status `pending` already in the DB.
    const database = db as Database;
    const eventId = crypto.randomUUID();
    const now = new Date().toISOString();
    writer(database)({
      id: eventId,
      type: 'demo.replay',
      occurredAt: now,
      payload: { hello: 'world' },
    });
    database
      .query<unknown, [string, string, string, string]>(
        `INSERT INTO bus_outbox (id, type, payload_json, occurred_at, status)
         VALUES (?, ?, ?, ?, 'pending')`,
      )
      .run(eventId, 'demo.replay', JSON.stringify({ hello: 'world' }), now);

    // Fresh process: build a new bus, subscribe, start. The seeded
    // outbox row must be delivered.
    const seen: BusEvent[] = [];
    bus = new DurableSqliteMessageBus(database, {
      writeEvent: writer(database),
      pollIntervalMs: 5,
      onHandlerError: () => {
        /* swallow */
      },
    });
    bus.subscribe('demo.replay', (event) => {
      seen.push(event);
    });
    bus.start();
    await bus.drain();

    expect(seen).toHaveLength(1);
    expect(seen[0]?.id).toBe(eventId);
    expect((seen[0]?.payload as { hello: string }).hello).toBe('world');

    // Boot replay must be exactly-once: a second drain produces no
    // additional delivery.
    await bus.drain();
    expect(seen).toHaveLength(1);
  });

  it('marks an in_flight row past the lease as abandoned when no subscriber is idempotent', async () => {
    const database = db as Database;
    const eventId = crypto.randomUUID();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writer(database)({
      id: eventId,
      type: 'demo.abandoned',
      occurredAt: longAgo,
      payload: null,
    });
    database
      .query<unknown, [string, string, string, string, string]>(
        `INSERT INTO bus_outbox (id, type, payload_json, occurred_at, status, claimed_at)
         VALUES (?, ?, ?, ?, 'in_flight', ?)`,
      )
      .run(eventId, 'demo.abandoned', 'null', longAgo, longAgo);

    bus = new DurableSqliteMessageBus(database, {
      writeEvent: writer(database),
      pollIntervalMs: 5,
      onHandlerError: () => {
        /* swallow */
      },
      // Lease shorter than the row's age so it counts as past-lease.
      leaseMs: 60_000,
    });
    let seen = 0;
    bus.subscribe(
      'demo.abandoned',
      () => {
        seen += 1;
      },
      { idempotent: false },
    );
    bus.start();
    await bus.drain();

    expect(seen).toBe(0);
    const row = database
      .query<{ status: string }, [string]>(`SELECT status FROM bus_outbox WHERE id=?`)
      .get(eventId);
    expect(row?.status).toBe('abandoned');
  });

  it('replays an in_flight row past the lease when any subscriber is idempotent', async () => {
    const database = db as Database;
    const eventId = crypto.randomUUID();
    const longAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    writer(database)({
      id: eventId,
      type: 'demo.idemp',
      occurredAt: longAgo,
      payload: null,
    });
    database
      .query<unknown, [string, string, string, string, string]>(
        `INSERT INTO bus_outbox (id, type, payload_json, occurred_at, status, claimed_at)
         VALUES (?, ?, ?, ?, 'in_flight', ?)`,
      )
      .run(eventId, 'demo.idemp', 'null', longAgo, longAgo);

    bus = new DurableSqliteMessageBus(database, {
      writeEvent: writer(database),
      pollIntervalMs: 5,
      onHandlerError: () => {
        /* swallow */
      },
      leaseMs: 60_000,
    });
    // Production ordering: `bus.start()` happens BEFORE the runners
    // register their subscribers (`apps/server/src/index.ts`). The
    // adapter must defer boot-recovery until the first pump so the
    // subscriber's idempotent flag is observed.
    bus.start();
    let seen = 0;
    bus.subscribe(
      'demo.idemp',
      () => {
        seen += 1;
      },
      { idempotent: true },
    );
    await bus.drain();

    expect(seen).toBe(1);
    const row = database
      .query<{ status: string }, [string]>(`SELECT status FROM bus_outbox WHERE id=?`)
      .get(eventId);
    expect(row?.status).toBe('delivered');
  });

  it('moves a row to bus_dlq when a middleware throws past maxAttempts', async () => {
    const database = db as Database;
    let attempts = 0;
    const exploder: Middleware = async () => {
      attempts += 1;
      throw new Error(`boom-${attempts}`);
    };
    bus = new DurableSqliteMessageBus(database, {
      writeEvent: writer(database),
      middlewares: [exploder],
      maxAttempts: 2,
      pollIntervalMs: 5,
      onHandlerError: () => {
        /* swallow */
      },
    });
    bus.subscribe('demo.dlq', () => {
      /* unreachable — exploder throws first */
    });
    bus.start();
    const published = await bus.publish({ type: 'demo.dlq', payload: null });
    await bus.drain();

    expect(attempts).toBe(2);
    const outbox = database
      .query<{ status: string }, [string]>(`SELECT status FROM bus_outbox WHERE id=?`)
      .get(published.id);
    expect(outbox?.status).toBe('dead');
    const dlq = database
      .query<
        { outbox_id: string; attempts: number; error: string },
        [string]
      >(`SELECT outbox_id, attempts, error FROM bus_dlq WHERE outbox_id=?`)
      .get(published.id);
    expect(dlq?.outbox_id).toBe(published.id);
    expect(dlq?.attempts).toBe(2);
    expect(dlq?.error).toContain('boom');
  });

  it('replayDlq flips a dead row back to pending and re-delivers exactly once', async () => {
    const database = db as Database;
    let attempts = 0;
    let succeed = false;
    const conditional: Middleware = async (event, next) => {
      attempts += 1;
      if (!succeed) throw new Error('not yet');
      await next(event);
    };
    bus = new DurableSqliteMessageBus(database, {
      writeEvent: writer(database),
      middlewares: [conditional],
      maxAttempts: 1,
      pollIntervalMs: 5,
      onHandlerError: () => {
        /* swallow */
      },
    });
    let delivered = 0;
    bus.subscribe('demo.replay', () => {
      delivered += 1;
    });
    bus.start();
    const published = await bus.publish({ type: 'demo.replay', payload: null });
    await bus.drain();

    expect(delivered).toBe(0);
    const dead = database
      .query<{ status: string }, [string]>(`SELECT status FROM bus_outbox WHERE id=?`)
      .get(published.id);
    expect(dead?.status).toBe('dead');

    // Admin replays.
    succeed = true;
    const flipped = bus.replayDlq(published.id);
    expect(flipped).toBe(true);
    await bus.drain();

    expect(delivered).toBe(1);
    const ok = database
      .query<{ status: string }, [string]>(`SELECT status FROM bus_outbox WHERE id=?`)
      .get(published.id);
    expect(ok?.status).toBe('delivered');
    // Original attempts before replay + the successful retry post-replay.
    expect(attempts).toBe(2);
  });
});

/**
 * Tiny bootstrap that mirrors the production migrations
 * `0001_init.sql` (just the `events` table) and `0013_durable_bus.sql`
 * (`bus_outbox` + `bus_offsets` + `bus_dlq`). The bus package can't
 * import the server migrations because that would cycle, so we ship
 * the minimum here. Any drift between the production migration and
 * this fixture is caught by the server-side migration tests.
 */
function bootstrapDurableSchema(db: Database): void {
  db.exec(`
    CREATE TABLE events (
      id             TEXT PRIMARY KEY,
      type           TEXT NOT NULL,
      occurred_at    TEXT NOT NULL,
      correlation_id TEXT,
      flow_id        TEXT,
      payload        TEXT NOT NULL,
      metadata       TEXT
    );

    CREATE TABLE bus_outbox (
      id              TEXT PRIMARY KEY,
      type            TEXT NOT NULL,
      payload_json    TEXT NOT NULL,
      metadata_json   TEXT,
      correlation_id  TEXT,
      flow_id         TEXT,
      occurred_at     TEXT NOT NULL,
      status          TEXT NOT NULL CHECK (status IN
                         ('pending','in_flight','delivered','dead','abandoned')),
      attempt         INTEGER NOT NULL DEFAULT 0,
      claimed_at      TEXT,
      claimed_by_pid  INTEGER,
      delivered_at    TEXT,
      error           TEXT
    );

    CREATE TABLE bus_offsets (
      subscriber_key  TEXT PRIMARY KEY,
      last_id         TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );

    CREATE TABLE bus_dlq (
      id              TEXT PRIMARY KEY,
      outbox_id       TEXT NOT NULL REFERENCES bus_outbox(id),
      subscriber_key  TEXT NOT NULL,
      error           TEXT NOT NULL,
      attempts        INTEGER NOT NULL,
      failed_at       TEXT NOT NULL
    );
  `);
}
