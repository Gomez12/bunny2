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
import { createUsersRepo } from '../src/repos/users-repo';
import { SESSION_COOKIE_NAME } from '../src/auth/cookie';
import { createGroupResolver } from '../src/auth/group-resolver';
import { seedUserAndSession } from './_helpers/auth';

function mkAppFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-auth-mw-'));
  const db = openDatabase(dir);
  const bus = new InMemoryMessageBus();
  const llmClient = createLlmClient({
    endpoint: 'mock://echo',
    apiKey: '',
    defaultModel: 'mock-default',
  });
  const status = (): StatusBody => ({
    app: 'bunny2',
    version: '0.0.0',
    phase: '2.3',
    ok: true,
    dataDir: '/tmp/test',
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
  });
  const resolver = createGroupResolver({ db, bus });
  const app = createApp({
    bus,
    llmClient,
    status,
    db,
    auth: AuthConfigSchema.parse({}),
    resolver,
  });
  return { db, app };
}

describe('auth middleware', () => {
  it('rejects requests without a token with 401 + i18n key errors.auth.unauthorized', async () => {
    const { db, app } = mkAppFixture();
    try {
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ message: 'hi' }),
        }),
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('errors.auth.unauthorized');
    } finally {
      db.close();
    }
  });

  it('accepts a valid Authorization: Bearer token', async () => {
    const { db, app } = mkAppFixture();
    try {
      const { token } = seedUserAndSession(db);
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ message: 'hi' }),
        }),
      );
      // mock://echo always succeeds → 200.
      expect(res.status).toBe(200);
    } finally {
      db.close();
    }
  });

  it('accepts a valid bunny2_session cookie', async () => {
    const { db, app } = mkAppFixture();
    try {
      const { token } = seedUserAndSession(db);
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: `${SESSION_COOKIE_NAME}=${token}`,
          },
          body: JSON.stringify({ message: 'hi' }),
        }),
      );
      expect(res.status).toBe(200);
    } finally {
      db.close();
    }
  });

  it('prefers Authorization over the cookie when both are present', async () => {
    const { db, app } = mkAppFixture();
    try {
      const goodSeed = seedUserAndSession(db, { username: 'good-user' });
      const garbageCookie = 'this-is-not-a-valid-token';
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${goodSeed.token}`,
            cookie: `${SESSION_COOKIE_NAME}=${garbageCookie}`,
          },
          body: JSON.stringify({ message: 'hi' }),
        }),
      );
      // Bearer wins → request succeeds despite the garbage cookie.
      expect(res.status).toBe(200);
    } finally {
      db.close();
    }
  });

  it('rejects an expired session', async () => {
    const { db, app } = mkAppFixture();
    try {
      // TTL 1 minute, seeded in the past so it's already past expiresAt
      // from the middleware's perspective ("now" is the live clock).
      const { token } = seedUserAndSession(db, {
        ttlMinutes: 1,
        idleMinutes: 60 * 24,
        now: new Date(Date.now() - 60 * 60 * 1000), // 1 hour ago
      });
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ message: 'hi' }),
        }),
      );
      expect(res.status).toBe(401);
    } finally {
      db.close();
    }
  });

  it('rejects a revoked session', async () => {
    const { db, app } = mkAppFixture();
    try {
      const { token, session } = seedUserAndSession(db);
      const sessionsRepo = (await import('../src/repos/sessions-repo')).createSessionsRepo(db);
      sessionsRepo.revokeSession(session.id, new Date().toISOString());
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ message: 'hi' }),
        }),
      );
      expect(res.status).toBe(401);
    } finally {
      db.close();
    }
  });

  it('rejects a session whose owning user has been soft-deleted', async () => {
    const { db, app } = mkAppFixture();
    try {
      const { token, user } = seedUserAndSession(db);
      const usersRepo = createUsersRepo(db);
      usersRepo.softDeleteUser(user.id, new Date().toISOString());
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ message: 'hi' }),
        }),
      );
      expect(res.status).toBe(401);
    } finally {
      db.close();
    }
  });

  it('lets GET /status through without any credentials (public route)', async () => {
    const { db, app } = mkAppFixture();
    try {
      const res = await app.fetch(new Request('http://localhost/status'));
      expect(res.status).toBe(200);
    } finally {
      db.close();
    }
  });

  it('answers an OPTIONS preflight without 401 and with CORS headers', async () => {
    const { db, app } = mkAppFixture();
    try {
      const res = await app.fetch(
        new Request('http://localhost/chat', {
          method: 'OPTIONS',
          headers: {
            origin: 'http://localhost:5173',
            'access-control-request-method': 'POST',
          },
        }),
      );
      // CORS middleware answers with 204.
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    } finally {
      db.close();
    }
  });
});
