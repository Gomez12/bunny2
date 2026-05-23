import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { InMemoryMessageBus } from '@bunny2/bus';
import { createApp } from '../src/http/router';
import type { StatusBody } from '../src/http/router';
import { createLlmClient } from '../src/llm/client';
import { openDatabase } from '../src/storage/sqlite';
import { AuthConfigSchema } from '../src/config/schema';
import { createGroupResolver } from '../src/auth/group-resolver';

describe('GET /status', () => {
  it('returns the injected status body shape with the auth section and skips auth (public route)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-http-status-'));
    const db = openDatabase(dir);
    try {
      const bus = new InMemoryMessageBus();
      const llmClient = createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      });
      const body: StatusBody = {
        app: 'bunny2',
        version: '0.0.0',
        phase: '2.2',
        ok: true,
        dataDir: '/tmp/example',
        configFile: null,
        sqlite: { schemaVersion: '0002_users_groups' },
        lancedb: { ready: true, tables: [] },
        bus: { adapter: 'in-memory', events: 0 },
        llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
        auth: {
          sessions: 0,
          users: 0,
          groups: 0,
          adminSeeded: false,
          adminGroupResolved: false,
        },
      };

      const resolver = createGroupResolver({ db, bus });
      const app = createApp({
        bus,
        llmClient,
        status: () => body,
        db,
        auth: AuthConfigSchema.parse({}),
        resolver,
      });
      // No Authorization header, no cookie — status must still respond.
      const res = await app.fetch(new Request('http://localhost/status'));
      expect(res.status).toBe(200);
      const json = (await res.json()) as StatusBody;
      expect(json).toEqual(body);
      expect(json.phase).toBe('2.2');
      expect(json.auth).toEqual({
        sessions: 0,
        users: 0,
        groups: 0,
        adminSeeded: false,
        adminGroupResolved: false,
      });
    } finally {
      db.close();
    }
  });
});
