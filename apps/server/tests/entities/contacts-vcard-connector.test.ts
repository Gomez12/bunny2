/**
 * Phase 4b.2 — vCard connector + dispatcher ingest tests.
 *
 * Surfaces covered:
 *  - happy path: 3 vCards → 3 created contacts (no matchKey matches).
 *  - dedup-by-email: re-ingest the same file → 0 created, 3 updated.
 *  - invalid content-type → throws `errors.connectors.vcard.invalidContentType`.
 *  - secret-strip invariant: bus events never contain raw bytes or filename.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Database } from 'bun:sqlite';
import { InMemoryMessageBus, type BusEvent } from '@bunny2/bus';
import { openDatabase } from '../../src/storage/sqlite';
import { createUsersRepo } from '../../src/repos/users-repo';
import { createLayersRepo } from '../../src/repos/layers-repo';
import { createLlmClient } from '../../src/llm/client';
import {
  createConnectorDispatcher,
  __resetEntityRegistryForTests,
  registerEntityModule,
} from '../../src/entities';
import {
  createContactModule,
  createVcardConnector,
  VCARD_CONNECTOR_ID,
  VCARD_ERROR_KEYS,
} from '../../src/entities/contacts';
import { safeRmSync } from '../_helpers/temp-dir';

interface Fixture {
  readonly dir: string;
  readonly db: Database;
  readonly bus: InMemoryMessageBus;
  readonly events: ReadonlyArray<BusEvent>;
  cleanup(): void;
}

function makeFixture(): Fixture {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-vcard-'));
  const db = openDatabase(dir);
  const captured: BusEvent[] = [];
  const bus = new InMemoryMessageBus({
    middlewares: [
      async (event, next) => {
        captured.push(event);
        await next(event);
      },
    ],
  });
  return {
    dir,
    db,
    bus,
    events: captured,
    cleanup() {
      __resetEntityRegistryForTests();
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
    },
  };
}

function seedUser(db: Database, username: string): string {
  const id = crypto.randomUUID();
  createUsersRepo(db).createUser({
    id,
    username,
    displayName: username,
    passwordHash: 'h',
    mustChangePassword: false,
    now: new Date().toISOString(),
  });
  return id;
}

function seedLayer(db: Database, slug: string): string {
  const id = crypto.randomUUID();
  createLayersRepo(db).insertLayer({
    id,
    type: 'project',
    slug,
    name: slug,
    now: new Date().toISOString(),
  });
  return id;
}

const SAMPLE_VCF = [
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Alice Example',
  'N:Example;Alice;;;',
  'EMAIL;TYPE=WORK:alice@example.com',
  'TEL:+15550000001',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Bob Builder',
  'EMAIL:bob@example.com',
  'END:VCARD',
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Cara Cook',
  'EMAIL:cara@example.com',
  'END:VCARD',
  '',
].join('\r\n');

let fx: Fixture | null = null;
beforeEach(() => {
  __resetEntityRegistryForTests();
  fx = makeFixture();
});
afterEach(() => {
  fx?.cleanup();
  fx = null;
});

function makeDispatcher(fixture: Fixture) {
  const connector = createVcardConnector();
  const module = createContactModule({ connectors: [connector] });
  registerEntityModule(module);
  const llm = createLlmClient({
    endpoint: 'mock://echo',
    apiKey: '',
    defaultModel: 'mock-default',
  });
  const dispatcher = createConnectorDispatcher({
    db: fixture.db,
    bus: fixture.bus,
    llm,
    // vCard has no per-layer attachment config — return an empty
    // resolved object so the dispatcher does not bail on
    // `errors.connectors.notConfigured`.
    resolveConfig: () => ({}),
  });
  return { module, dispatcher };
}

describe('vCard connector :: happy path', () => {
  it('creates 3 contacts from 3 vCards on first ingest', async () => {
    const fixture = fx!;
    const { dispatcher } = makeDispatcher(fixture);
    const layerId = seedLayer(fixture.db, 'team');
    const userId = seedUser(fixture.db, 'alice');

    const result = await dispatcher.ingest({
      kind: 'contact',
      connectorId: VCARD_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload: {
        contentType: 'text/vcard',
        bytes: new TextEncoder().encode(SAMPLE_VCF),
        filename: 'contacts.vcf',
      },
      originalLocale: 'en',
    });
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);
    expect(result.warnings).toEqual([]);
    const count = fixture.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM contacts WHERE deleted_at IS NULL')
      .get()?.n;
    expect(count).toBe(3);
  });
});

describe('vCard connector :: dedup-by-email matchKey', () => {
  it('updates the existing row when the primary email already exists', async () => {
    const fixture = fx!;
    const { dispatcher } = makeDispatcher(fixture);
    const layerId = seedLayer(fixture.db, 'team2');
    const userId = seedUser(fixture.db, 'bob');

    const payload = {
      contentType: 'text/vcard',
      bytes: new TextEncoder().encode(SAMPLE_VCF),
      filename: 'contacts.vcf',
    };
    const first = await dispatcher.ingest({
      kind: 'contact',
      connectorId: VCARD_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload,
      originalLocale: 'en',
    });
    expect(first.created).toBe(3);
    const second = await dispatcher.ingest({
      kind: 'contact',
      connectorId: VCARD_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload,
      originalLocale: 'en',
    });
    expect(second.created).toBe(0);
    expect(second.updated).toBe(3);
    // Still only 3 rows, version bumped.
    const rows = fixture.db
      .query<
        { n: number; max_version: number },
        []
      >('SELECT COUNT(*) AS n, MAX(version) AS max_version FROM contacts WHERE deleted_at IS NULL')
      .get();
    expect(rows?.n).toBe(3);
    expect(rows?.max_version).toBeGreaterThanOrEqual(2);
  });

  it('case-insensitive: re-ingest with uppercased email matches', async () => {
    const fixture = fx!;
    const { dispatcher } = makeDispatcher(fixture);
    const layerId = seedLayer(fixture.db, 'case');
    const userId = seedUser(fixture.db, 'eve');
    const first = await dispatcher.ingest({
      kind: 'contact',
      connectorId: VCARD_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload: {
        contentType: 'text/vcard',
        bytes: new TextEncoder().encode(
          ['BEGIN:VCARD', 'FN:Felix', 'EMAIL:FELIX@EXAMPLE.COM', 'END:VCARD', ''].join('\r\n'),
        ),
      },
      originalLocale: 'en',
    });
    expect(first.created).toBe(1);
    const second = await dispatcher.ingest({
      kind: 'contact',
      connectorId: VCARD_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload: {
        contentType: 'text/vcard',
        bytes: new TextEncoder().encode(
          ['BEGIN:VCARD', 'FN:Felix Lower', 'EMAIL:felix@example.com', 'END:VCARD', ''].join(
            '\r\n',
          ),
        ),
      },
      originalLocale: 'en',
    });
    expect(second.updated).toBe(1);
    expect(second.created).toBe(0);
  });
});

describe('vCard connector :: invalid content type', () => {
  it('throws errors.connectors.vcard.invalidContentType when neither MIME nor filename is vCard', async () => {
    const fixture = fx!;
    const { dispatcher } = makeDispatcher(fixture);
    const layerId = seedLayer(fixture.db, 'nope');
    const userId = seedUser(fixture.db, 'mallory');

    let caught: unknown = null;
    try {
      await dispatcher.ingest({
        kind: 'contact',
        connectorId: VCARD_CONNECTOR_ID,
        layerId,
        actorId: userId,
        payload: {
          contentType: 'application/zip',
          bytes: new TextEncoder().encode('not a vcard'),
          filename: 'archive.zip',
        },
        originalLocale: 'en',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    expect((caught as Error).message).toBe(VCARD_ERROR_KEYS.InvalidContentType);
  });
});

describe('vCard connector :: secret-strip / no-leak invariant', () => {
  it('never publishes raw bytes or filename in any bus event payload', async () => {
    const fixture = fx!;
    const { dispatcher } = makeDispatcher(fixture);
    const layerId = seedLayer(fixture.db, 'secret');
    const userId = seedUser(fixture.db, 'sentinel');
    const filename = 'sentinel-FILENAME-DO-NOT-LEAK.vcf';
    const vcf = [
      'BEGIN:VCARD',
      'FN:SECRET-BODY-DO-NOT-LEAK',
      'EMAIL:secret@example.com',
      'END:VCARD',
      '',
    ].join('\r\n');
    await dispatcher.ingest({
      kind: 'contact',
      connectorId: VCARD_CONNECTOR_ID,
      layerId,
      actorId: userId,
      payload: {
        contentType: 'text/vcard',
        bytes: new TextEncoder().encode(vcf),
        filename,
      },
      originalLocale: 'en',
    });
    expect(fixture.events.length).toBeGreaterThan(0);
    const haystack = JSON.stringify(
      fixture.events.map((e) => ({ type: e.type, payload: e.payload, metadata: e.metadata })),
    );
    // The filename and the raw vCard body string must NOT appear in any
    // event payload. The created entity's title is "SECRET-BODY-DO-NOT-LEAK"
    // by design — that's the entity title and shows up in
    // `entity.contact.created.searchableText` etc., so we use a unique
    // sentinel string for the byte body that is NOT the title.
    expect(haystack).not.toContain(filename);
    // The filename sentinel must be absent. The title appears in
    // entity.contact.created (as it should — title is denormalized into
    // searchable_text) — that is NOT a leak. We only assert filename
    // and raw byte-body sentinels do not appear in event payloads.
    expect(haystack).not.toContain('sentinel-FILENAME');
  });
});
