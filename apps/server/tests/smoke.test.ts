/**
 * Phase 1.7 — end-to-end smoke test. Extended through phase 2.7.
 *
 * This is the canonical "spine" test: it goes through `loadConfig()`
 * (data-dir + schema defaults), opens the real SQLite + LanceDB, builds
 * the real bus with all middlewares, wires the real telemetry-wrapped
 * LLM client against the deterministic `mock://echo` provider, and
 * drives the real HTTP layer via `createApp(deps).fetch`.
 *
 * It differs from `http-chat.test.ts` (which mocks the status body and
 * skips `loadConfig`) by:
 *
 *  - Using `BUNNY2_DATA_DIR` to point `loadConfig()` at a temp dir, so
 *    every layer — config, migrations, LanceDB scaffolding, retention
 *    knob — is exercised.
 *  - Hitting `GET /status` and asserting the structural fields that the
 *    UI and the manual checklist rely on (phase, sqlite.schemaVersion,
 *    lancedb.ready, bus.adapter, llm.endpoint, llm.calls).
 *  - Sequencing `/status` → `/chat` → `/status` and observing
 *    `llm.calls` tick from 0 to 1, which proves the call log is live
 *    and shared across requests.
 *  - Asserting matching `correlation_id` across the SQLite `events` and
 *    `llm_calls` rows for the same request.
 *
 * Phase-2 invariants asserted in this file (in order):
 *
 *  1. Unauthenticated `POST /chat` → 401 (auth middleware is on).
 *  2. Admin seed runs exactly once and prints the initial password.
 *  3. `POST /auth/login` with the seeded credentials → 200 + Bearer
 *     token in `Set-Cookie`, response carries `mustChangePassword: true`.
 *  4. Authenticated `POST /chat` BEFORE rotation → 409 (the
 *     `requirePasswordCurrent` gate fires).
 *  5. `POST /auth/password` (no `currentPassword`, valid session) → 200.
 *  6. Admin can create a group and add itself as a direct member; the
 *     transitive resolver keeps `/auth/me.isAdmin === true` through it.
 *  7. `GET /status` reports `phase = '3.6'` and `auth.adminSeeded = true`.
 *  8. Authenticated `POST /chat` AFTER rotation → 200 (mock echo).
 *  9. `POST /auth/logout` → 200 and the now-revoked token fails the next
 *     `POST /chat` with 401.
 * 10. The SQLite event log contains the chat + auth-domain events with
 *     matching correlation/flow ids and the LLM telemetry row joins
 *     cleanly on `correlation_id`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import { safeRmSync } from './_helpers/temp-dir';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  InMemoryMessageBus,
  correlationIdMiddleware,
  errorCaptureMiddleware,
  telemetryMiddleware,
} from '@bunny2/bus';
import { loadConfig } from '../src/config';
import { openDatabase } from '../src/storage/sqlite';
import { currentSchemaVersion } from '../src/storage/migrations';
import { openLanceDB } from '../src/storage/lancedb';
import { createSqliteEventLog } from '../src/bus/event-log';
import {
  createLlmClient,
  createSqliteLlmCallLog,
  withTelemetry,
  type LlmCallLog,
} from '../src/llm';
import { createApp } from '../src/http/router';
import type { StatusBody } from '../src/http/router';
import { seedAdminIfNeeded } from '../src/auth/seed';
import { ADMIN_GROUP_ID_KEY, ADMIN_SEED_DONE_KEY } from '../src/auth/seed';
import { getMeta } from '../src/storage/kv-meta';
import { createGroupResolver } from '../src/auth/group-resolver';
import { seedLayersIfNeeded } from '../src/layers/seed';
import { createLayerResolver } from '../src/layers/resolver';

interface ChatSuccessBody {
  content: string;
  model: string;
  tokensIn: number;
  tokensOut: number;
  correlationId: string;
}

interface EventRow {
  type: string;
  correlation_id: string | null;
  flow_id: string | null;
}

interface LlmCallRow {
  id: string;
  started_at: string;
  ended_at: string | null;
  model: string;
  endpoint: string;
  correlation_id: string | null;
  flow_id: string | null;
  error: string | null;
}

// Captured per-suite so the `afterAll` teardown does not depend on
// describe-block-scoped variables when something throws early.
let tmpDir: string;
let prevDataDir: string | undefined;
let db: Database | null = null;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-smoke-'));
  prevDataDir = process.env['BUNNY2_DATA_DIR'];
  process.env['BUNNY2_DATA_DIR'] = tmpDir;
});

afterAll(() => {
  if (db !== null) {
    try {
      db.close();
    } catch {
      /* already closed */
    }
  }
  if (prevDataDir === undefined) {
    delete process.env['BUNNY2_DATA_DIR'];
  } else {
    process.env['BUNNY2_DATA_DIR'] = prevDataDir;
  }
  try {
    safeRmSync(tmpDir);
  } catch {
    /* best-effort */
  }
});

describe('phase 1.7 smoke — config + storage + bus + LLM + HTTP round-trip', () => {
  it('drives /status, /chat, and asserts the SQLite event + llm_calls rows', async () => {
    // 1. Real config layer picks up BUNNY2_DATA_DIR.
    const loaded = loadConfig();
    expect(loaded.dataDir).toBe(tmpDir);
    expect(loaded.config.llm.endpoint).toBe('mock://echo');

    // 2. Real SQLite, real migrations, real LanceDB scaffolding.
    // Narrow into a local non-nullable handle for the rest of the test;
    // the suite-scoped `db` exists only so `afterAll` can close it.
    const database = openDatabase(loaded.dataDir);
    db = database;
    const lance = await openLanceDB(loaded.dataDir);
    const lanceTables = await lance.tableNames();
    const schemaVersion = currentSchemaVersion(database);
    expect(schemaVersion).not.toBeNull();
    expect(fs.existsSync(path.join(loaded.dataDir, 'bunny2.sqlite'))).toBe(true);
    expect(fs.existsSync(path.join(loaded.dataDir, 'lancedb'))).toBe(true);

    // 3. Real bus + event log + middleware chain (matches index.ts).
    const eventLog = createSqliteEventLog(database);
    const bus = new InMemoryMessageBus({
      middlewares: [
        correlationIdMiddleware,
        telemetryMiddleware(eventLog.writer),
        errorCaptureMiddleware(() => {
          /* swallow during smoke */
        }),
      ],
    });

    // 4. Real LLM client + telemetry wrapper against `mock://echo`.
    const callLog: LlmCallLog = createSqliteLlmCallLog(database);
    const rawClient = createLlmClient({
      endpoint: loaded.config.llm.endpoint,
      apiKey: loaded.config.llm.apiKey,
      defaultModel: loaded.config.llm.defaultModel,
    });
    const llmClient = withTelemetry(rawClient, {
      log: callLog,
      pricing: loaded.config.llm.pricing,
    });

    // 5. Real HTTP app — exactly the wiring `index.ts` uses, minus
    //    `Bun.serve` (we go in-process via `app.fetch` to keep the test
    //    deterministic and port-free).
    function smokeLayerStatus(): NonNullable<StatusBody['layers']> {
      interface Row {
        type: 'personal' | 'project' | 'group' | 'everyone';
        n: number;
      }
      const rows = database
        .query<
          Row,
          []
        >(`SELECT type, COUNT(*) AS n FROM layers WHERE deleted_at IS NULL GROUP BY type`)
        .all();
      const byType = { personal: 0, project: 0, group: 0, everyone: 0 };
      let total = 0;
      for (const r of rows) {
        byType[r.type] = r.n;
        total += r.n;
      }
      const withDeleted =
        database.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM layers').get()?.n ?? 0;
      return { total, byType, withDeleted };
    }

    const status = (): StatusBody => ({
      app: 'bunny2',
      version: '0.0.0',
      phase: '3.6',
      ok: true,
      dataDir: loaded.dataDir,
      configFile: loaded.configFile,
      sqlite: { schemaVersion },
      lancedb: { ready: true, tables: lanceTables },
      bus: { adapter: 'in-memory', events: eventLog.count() },
      llm: {
        endpoint: llmClient.endpoint,
        defaultModel: llmClient.defaultModel,
        calls: callLog.count(),
      },
      auth: {
        sessions: 0,
        users: 0,
        groups: 0,
        adminSeeded: getMeta(database, ADMIN_SEED_DONE_KEY) === 'true',
        adminGroupResolved: getMeta(database, ADMIN_GROUP_ID_KEY) !== null,
      },
      layers: smokeLayerStatus(),
    });
    // Seed admin BEFORE createApp so the `requireAdmin` middleware's
    // factory-time read of `admin_group_id` observes the seeded value.
    // We capture the printed password here so the later
    // `seedAdminAndLogin` helper sees the idempotent no-op and we still
    // get a token via the same code path the user takes.
    const seedCaptured: string[] = [];
    await seedAdminIfNeeded({ db: database, bus, log: (l) => seedCaptured.push(l) });

    const resolver = createGroupResolver({ db: database, bus });
    // Phase 3.2 — seed the layer model after the admin seed and after
    // the transitive group resolver is constructed (so the seed can
    // walk transitive groups for the personal→group edges).
    await seedLayersIfNeeded({ db: database, bus, transitiveGroups: resolver });
    // Phase 3.3 — the layer resolver is the per-request enrichment
    // source for `c.var.effectiveLayers`. Smoke exercises the real
    // chain so any wiring drift between dev/test/production breaks
    // here first.
    const layerResolver = createLayerResolver({ db: database, transitiveGroups: resolver });
    const app = createApp({
      bus,
      llmClient,
      status,
      db: database,
      auth: loaded.config.auth,
      resolver,
      layerResolver,
      locales: loaded.config.locales,
    });

    // 6-pre. Phase 2.2 invariant — every non-public route requires a
    //        session. Hit `/chat` with NO `Authorization` header and
    //        NO `Cookie`; the auth middleware must return 401 long
    //        before the chat handler runs.
    const unauthenticatedChat = await app.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'no-session' }),
      }),
    );
    expect(unauthenticatedChat.status).toBe(401);

    // 6a. The admin seed already ran (see 5b above) so we extract the
    //     printed password and do the login directly. Login succeeds
    //     even with `mustChangePassword=true` — the gate fires on the
    //     NEXT protected request.
    const passwordLine = seedCaptured.find((l) => l.includes('password:'));
    if (passwordLine === undefined) throw new Error('smoke: no password line in seed output');
    const initialPassword = passwordLine.split('password:')[1]?.trim() ?? '';
    const loginRes = await app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: initialPassword }),
      }),
    );
    expect(loginRes.status).toBe(200);
    const loginBody = (await loginRes.json()) as {
      user: { id: string };
      mustChangePassword: boolean;
    };
    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    const adminToken = /bunny2_session=([^;]+)/.exec(setCookie)?.[1] ?? '';
    const admin = {
      token: adminToken,
      userId: loginBody.user.id,
      mustChangePassword: loginBody.mustChangePassword,
    };
    expect(admin.mustChangePassword).toBe(true);

    // 6b. The password gate blocks /chat until we rotate.
    const blocked = await app.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({ message: 'before-rotate' }),
      }),
    );
    expect(blocked.status).toBe(409);

    // 6c. Rotate the admin password through the standard endpoint.
    const rotate = await app.fetch(
      new Request('http://localhost/auth/password', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({ newPassword: 'smoke-test-rotation-2026!' }),
      }),
    );
    expect(rotate.status).toBe(200);

    // 6d. Phase 2.4 — admin group flow. Create `engineering`, then add
    //     the seeded admin as a direct member. /auth/me must keep
    //     reporting isAdmin=true through both operations (the
    //     transitive resolver picks the admin up via the admin group;
    //     the engineering membership is independent).
    const createGroupRes = await app.fetch(
      new Request('http://localhost/admin/groups', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({ slug: 'engineering', name: 'Engineering' }),
      }),
    );
    expect(createGroupRes.status).toBe(201);
    const createGroupBody = (await createGroupRes.json()) as { group: { id: string } };
    const engineeringId = createGroupBody.group.id;

    const addMemberRes = await app.fetch(
      new Request(`http://localhost/admin/groups/${engineeringId}/members`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({ userId: admin.userId }),
      }),
    );
    expect(addMemberRes.status).toBe(201);

    const meRes = await app.fetch(
      new Request('http://localhost/auth/me', {
        headers: { authorization: `Bearer ${admin.token}` },
      }),
    );
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { isAdmin: boolean };
    expect(meBody.isAdmin).toBe(true);

    // 7. GET /status (before any chat) — structural fields the plan calls
    //    out explicitly. After the seed, `adminSeeded` is `true`.
    const statusBefore = await app.fetch(new Request('http://localhost/status'));
    expect(statusBefore.status).toBe(200);
    const statusBeforeBody = (await statusBefore.json()) as StatusBody;
    expect(statusBeforeBody.ok).toBe(true);
    expect(statusBeforeBody.phase).toBe('3.6');
    expect(statusBeforeBody.sqlite.schemaVersion).toBe(schemaVersion);
    expect(statusBeforeBody.lancedb.ready).toBe(true);
    expect(statusBeforeBody.bus.adapter).toBe('in-memory');
    expect(statusBeforeBody.llm.endpoint).toBe('mock://echo');
    expect(statusBeforeBody.llm.calls).toBe(0);
    expect(statusBeforeBody.auth.adminSeeded).toBe(true);
    // Phase 3.2 — `/status.layers` block surfaces after the layer seed.
    // After the admin seed we have one admin user + one admin group, so
    // the seed must produce: 1 everyone + 1 personal-admin + 1 group-admin.
    // TODO(3.4): when the layer bus subscribers are wired into the
    // smoke test boot path, the `engineering` group created above will
    // auto-create a `group-engineering` layer too; bump the expected
    // counts then (group → 2, total → 4). Until then, smoke does not
    // call `registerLayerSubscribers`, so the counts stay at 3.
    expect(statusBeforeBody.layers?.total).toBe(3);
    expect(statusBeforeBody.layers?.byType.everyone).toBe(1);
    expect(statusBeforeBody.layers?.byType.personal).toBe(1);
    expect(statusBeforeBody.layers?.byType.group).toBe(1);
    expect(statusBeforeBody.layers?.byType.project).toBe(0);
    expect(statusBeforeBody.layers?.withDeleted).toBe(3);

    // 7b. Phase 3.6 — full layer-visibility cycle covering the §6 e2e
    //     steps:
    //
    //       1. Login as user2 (NOT admin) and POST /layers — proves the
    //          route is not admin-gated.
    //       2. user2 adds user3 as member.
    //       3. GET /me/layers as user2 and user3 both include the new
    //          layer; user4 does not.
    //       4. GET /layers/:slug as user4 → 404 errors.layer.notVisible.
    //       4b. POST /layers/user-3-mine/visibility { parentSlug:
    //           'user-2-only' } as user2 (who cannot see user-2-only any
    //           more after the rename — but in this fixture we use a
    //           layer user2 owns to prove the byte-identical-404 rule
    //           against an unknown slug AND a slug-the-caller-cannot-see).
    //       5. user2 soft-deletes the project layer (owner); both
    //          members no longer see it.
    //       6. Re-run seed on the same data-dir; no duplicate rows.
    //
    //     We deliberately use NON-admin actors throughout so the smoke
    //     also pins the "any authenticated user can create a project
    //     layer" invariant from §11.3 of the phase-3 plan.

    // Seed three plain users via the admin route. Each lands with
    // `mustChangePassword: true`, so we rotate before any layer call.
    async function seedAndLoginPlainUser(args: {
      username: string;
      displayName: string;
      initialPassword: string;
      rotatedPassword: string;
    }): Promise<{ id: string; token: string }> {
      const createRes = await app.fetch(
        new Request('http://localhost/admin/users', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${admin.token}`,
          },
          body: JSON.stringify({
            username: args.username,
            displayName: args.displayName,
            initialPassword: args.initialPassword,
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as { user: { id: string } };

      const loginRes = await app.fetch(
        new Request('http://localhost/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: args.username, password: args.initialPassword }),
        }),
      );
      expect(loginRes.status).toBe(200);
      const cookie = loginRes.headers.get('set-cookie') ?? '';
      const token = /bunny2_session=([^;]+)/.exec(cookie)?.[1] ?? '';
      const rotateRes = await app.fetch(
        new Request('http://localhost/auth/password', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({ newPassword: args.rotatedPassword }),
        }),
      );
      expect(rotateRes.status).toBe(200);
      return { id: created.user.id, token };
    }

    const user2 = await seedAndLoginPlainUser({
      username: 'smoke-user-2',
      displayName: 'Smoke User 2',
      initialPassword: 'smoke-user-2-pw-2026!',
      rotatedPassword: 'smoke-user-2-rotated-2026!',
    });
    const user3 = await seedAndLoginPlainUser({
      username: 'smoke-user-3',
      displayName: 'Smoke User 3',
      initialPassword: 'smoke-user-3-pw-2026!',
      rotatedPassword: 'smoke-user-3-rotated-2026!',
    });
    const user4 = await seedAndLoginPlainUser({
      username: 'smoke-user-4',
      displayName: 'Smoke User 4',
      initialPassword: 'smoke-user-4-pw-2026!',
      rotatedPassword: 'smoke-user-4-rotated-2026!',
    });

    // 1. user2 creates the project layer. Proves: not admin-gated.
    const createLayerRes = await app.fetch(
      new Request('http://localhost/layers', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${user2.token}`,
        },
        body: JSON.stringify({ type: 'project', slug: 'smoke-project', name: 'Smoke' }),
      }),
    );
    expect(createLayerRes.status).toBe(201);

    // 2. user2 adds user3 as a member.
    const addMemberRes2 = await app.fetch(
      new Request('http://localhost/layers/smoke-project/members', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${user2.token}`,
        },
        body: JSON.stringify({ userId: user3.id }),
      }),
    );
    expect(addMemberRes2.status).toBe(201);

    // 3. GET /me/layers — user2 + user3 see it, user4 does not.
    interface SmokeMe {
      layers: { slug: string }[];
    }
    async function meLayersFor(token: string): Promise<SmokeMe> {
      const res = await app.fetch(
        new Request('http://localhost/me/layers', {
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      expect(res.status).toBe(200);
      return (await res.json()) as SmokeMe;
    }
    const user2Me = await meLayersFor(user2.token);
    expect(user2Me.layers.some((l) => l.slug === 'smoke-project')).toBe(true);
    const user3Me = await meLayersFor(user3.token);
    expect(user3Me.layers.some((l) => l.slug === 'smoke-project')).toBe(true);
    const user4MeBeforeDelete = await meLayersFor(user4.token);
    expect(user4MeBeforeDelete.layers.some((l) => l.slug === 'smoke-project')).toBe(false);

    // 4. GET /layers/:slug as user4 → 404 errors.layer.notVisible.
    const user4GetLayer = await app.fetch(
      new Request('http://localhost/layers/smoke-project', {
        headers: { authorization: `Bearer ${user4.token}` },
      }),
    );
    expect(user4GetLayer.status).toBe(404);
    const user4GetLayerBody = (await user4GetLayer.json()) as { error: string };
    expect(user4GetLayerBody.error).toBe('errors.layer.notVisible');

    // 4b. Visibility-leak proof — `POST /layers/.../visibility` returns the
    //     SAME 404 errors.layer.visibilityParentNotFound whether the
    //     parent is unknown OR exists-but-not-visible. user4 owns its
    //     own project layer, then tries to attach to 'smoke-project'
    //     (exists, hidden) vs 'does-not-exist'. The two responses must
    //     be byte-identical so a caller cannot probe slug existence.
    //     See ADR 0010 and the phase-3 close-out §14.
    const user4OwnLayer = await app.fetch(
      new Request('http://localhost/layers', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${user4.token}`,
        },
        body: JSON.stringify({
          type: 'project',
          slug: 'user-4-only',
          name: 'User4-only',
        }),
      }),
    );
    expect(user4OwnLayer.status).toBe(201);
    async function visibilityProbe(parentSlug: string): Promise<{
      status: number;
      body: { error: string };
    }> {
      const res = await app.fetch(
        new Request('http://localhost/layers/user-4-only/visibility', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${user4.token}`,
          },
          body: JSON.stringify({ parentSlug, direction: 'bottom_up' }),
        }),
      );
      return { status: res.status, body: (await res.json()) as { error: string } };
    }
    const hidden = await visibilityProbe('smoke-project');
    const missing = await visibilityProbe('does-not-exist');
    expect(hidden.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(hidden.body.error).toBe('errors.layer.visibilityParentNotFound');
    expect(missing.body.error).toBe('errors.layer.visibilityParentNotFound');
    expect(hidden).toEqual(missing);

    // 5. user2 soft-deletes the project; both members lose access.
    const deleteRes = await app.fetch(
      new Request('http://localhost/layers/smoke-project', {
        method: 'DELETE',
        headers: { authorization: `Bearer ${user2.token}` },
      }),
    );
    expect(deleteRes.status).toBe(200);
    const user2MeAfter = await meLayersFor(user2.token);
    expect(user2MeAfter.layers.some((l) => l.slug === 'smoke-project')).toBe(false);
    const user3MeAfter = await meLayersFor(user3.token);
    expect(user3MeAfter.layers.some((l) => l.slug === 'smoke-project')).toBe(false);

    // 6. Re-run the layer seed against the same data-dir — must be a
    //    no-op (no duplicate everyone / personal / group rows).
    function countLayers(): {
      total: number;
      everyone: number;
      personal: number;
      groupLayers: number;
    } {
      // NB: `group` is a SQL reserved word, hence the aliasing.
      const row = database
        .query<{ total: number; everyone: number; personal: number; groupLayers: number }, []>(
          `SELECT
              COUNT(*) AS total,
              SUM(CASE WHEN type = 'everyone' THEN 1 ELSE 0 END) AS everyone,
              SUM(CASE WHEN type = 'personal' THEN 1 ELSE 0 END) AS personal,
              SUM(CASE WHEN type = 'group' THEN 1 ELSE 0 END) AS groupLayers
            FROM layers WHERE deleted_at IS NULL`,
        )
        .get();
      return {
        total: row?.total ?? 0,
        everyone: row?.everyone ?? 0,
        personal: row?.personal ?? 0,
        groupLayers: row?.groupLayers ?? 0,
      };
    }
    const before = countLayers();
    await seedLayersIfNeeded({ db: database, bus, transitiveGroups: resolver });
    const after = countLayers();
    expect(after).toEqual(before);

    // 8. POST /chat against the deterministic mock provider. Carries
    //    the admin Bearer token — the 2.2 auth middleware + 2.3 gate
    //    both let it through now that the password has rotated.
    const chatRes = await app.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({ message: 'hello' }),
      }),
    );
    expect(chatRes.status).toBe(200);
    const chatBody = (await chatRes.json()) as ChatSuccessBody;
    expect(chatBody.content.startsWith('echo:')).toBe(true);
    expect(chatBody.content).toBe('echo: hello');
    expect(chatBody.model).toBe(loaded.config.llm.defaultModel);
    expect(chatBody.tokensOut).toBeGreaterThan(0);
    expect(chatBody.correlationId).toBeTruthy();

    // 9. POST /auth/logout, then a second /chat must return 401.
    const logoutRes = await app.fetch(
      new Request('http://localhost/auth/logout', {
        method: 'POST',
        headers: { authorization: `Bearer ${admin.token}` },
      }),
    );
    expect(logoutRes.status).toBe(200);
    const postLogoutChat = await app.fetch(
      new Request('http://localhost/chat', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${admin.token}`,
        },
        body: JSON.stringify({ message: 'after-logout' }),
      }),
    );
    expect(postLogoutChat.status).toBe(401);

    // 10. `llm.calls` ticked from 0 to 1.
    const statusAfter = await app.fetch(new Request('http://localhost/status'));
    const statusAfterBody = (await statusAfter.json()) as StatusBody;
    expect(statusAfterBody.llm.calls).toBe(1);

    // 11. Direct SQLite read — chat events carry the response's
    //     correlationId; the broader event stream also contains login /
    //     password / session events. We assert structurally rather than
    //     with strict equality on the full set.
    const events = database
      .query<EventRow, []>('SELECT type, correlation_id, flow_id FROM events ORDER BY rowid ASC')
      .all();
    const chatEvents = events.filter(
      (e) => e.type === 'chat.requested' || e.type === 'chat.responded',
    );
    expect(chatEvents.map((e) => e.type)).toEqual(['chat.requested', 'chat.responded']);
    expect(chatEvents[0]?.correlation_id).toBe(chatBody.correlationId);
    expect(chatEvents[1]?.correlation_id).toBe(chatBody.correlationId);
    expect(chatEvents[0]?.flow_id).toBeTruthy();
    expect(chatEvents[0]?.flow_id).toBe(chatEvents[1]?.flow_id);

    // Auth-domain events landed too.
    const types = events.map((e) => e.type);
    expect(types).toContain('user.created');
    expect(types).toContain('group.created');
    expect(types).toContain('group.member_added');
    expect(types).toContain('user.login.succeeded');
    expect(types).toContain('session.created');
    expect(types).toContain('user.password_changed');
    expect(types).toContain('session.expired');

    const calls = database
      .query<
        LlmCallRow,
        []
      >('SELECT id, started_at, ended_at, model, endpoint, correlation_id, flow_id, error FROM llm_calls')
      .all();
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.error).toBeNull();
    expect(call?.started_at).toBeTruthy();
    expect(call?.ended_at).toBeTruthy();
    expect(call?.model).toBe(loaded.config.llm.defaultModel);
    expect(call?.endpoint).toBe('mock://echo');
    expect(call?.correlation_id).toBe(chatBody.correlationId);
    expect(call?.flow_id).toBe(chatEvents[0]?.flow_id);
  });
});
