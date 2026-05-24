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
import { correlationIdMiddleware, errorCaptureMiddleware, telemetryMiddleware } from '@bunny2/bus';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
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
import {
  __resetEntityRegistryForTests,
  createConnectorDispatcher,
  createEnrichmentRunner,
  createEntityStore,
  registerEntityModule,
  type EntityStore,
} from '../src/entities';
import { createCompanyModule, createKvkConnector } from '../src/entities/companies';
import { createContactModule } from '../src/entities/contacts';
import {
  calendarAttendeeContactsJob,
  calendarSummaryJob,
  createCalendarEventModule,
  createGoogleCalendarConnector,
  createGoogleCalendarConfigResolver,
  GOOGLE_CALENDAR_CONNECTOR_ID,
  GOOGLE_CALENDAR_INGEST_CONTENT_TYPE,
} from '../src/entities/calendar';
import {
  createTodoCalendarProjection,
  createTodoModule,
  todoEnrichmentJobs,
} from '../src/entities/todos';
import { createSecretsService, generateEncryptionKey } from '../src/storage/secrets';
import { createLayerAttachmentsRepo } from '../src/repos/layer-attachments-repo';
import type { ChatRequest, ChatResponse, LlmClient } from '../src/llm';
import type { EntityExternalLink } from '@bunny2/shared';
import type {
  CompanyPayload,
  ContactPayload,
  CalendarEventPayload,
  TodoPayload,
} from '@bunny2/shared';
import type { BusEvent } from '@bunny2/bus';

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
      role: 'all',
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
    // Phase 4b.2 — wire the ingest dispatcher so the contacts router
    // mounts `POST /l/:slug/contact/_ingest/:connectorId` (used by the
    // phase 4b.6 vCard step). The dispatcher is NOT started — the smoke
    // drives `ingest(...)` synchronously and never publishes
    // `sync.requested` for vCard (it has no `pull`).
    const ingestDispatcher = createConnectorDispatcher({
      db: database,
      bus,
      llm: llmClient,
    });
    const app = createApp({
      bus,
      llmClient,
      status,
      db: database,
      auth: loaded.config.auth,
      resolver,
      layerResolver,
      locales: loaded.config.locales,
      ingestDispatcher,
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

    // -----------------------------------------------------------------
    // 12. Phase 4a.6 — canonical Companies entity flow (template for
    //     every later entity smoke: 4b.6 / 4c.6 / 4d.7). Drives the
    //     full vertical: create → patch → external-link → connector
    //     dispatch (stubbed KvK) → enrichment runner (fake LLM) →
    //     list → stats → soft-delete.
    //
    //     The KvK connector's `fetch` is captured at module import
    //     (see `apps/server/src/entities/companies/kvk-connector.ts`),
    //     so we cannot patch `globalThis.fetch` to swap it in. Instead
    //     we pre-register a stub-fetched `companyModule` variant in
    //     the entity registry. The dispatcher resolves connectors via
    //     `getConnector(kind, id)` which reads from the registry, so
    //     `dispatcher.handle(...)` invokes the stub. The HTTP routes'
    //     `EntityStore` keeps its own copy of the production module
    //     (captured by `createApp` above); CRUD goes through that
    //     store, which is identical to the stub for `indexedColumns`
    //     / `searchableText` / `toSummary` — only the connector
    //     differs.
    //
    //     The enrichment runner gets a deterministic fake LLM (no
    //     `mock://echo`) so the summary it writes is reproducible and
    //     `llm.calls` stays at 1 (the fake LLM is not the
    //     telemetry-wrapped client the smoke's `/chat` step used).
    //
    //     The smoke does NOT exercise the connector poll runner — the
    //     dispatcher is driven synchronously via `dispatcher.handle`.
    // -----------------------------------------------------------------

    // 12a. Fresh admin login (the earlier session was revoked in step
    //      9). The seed printed the initial password; the rotation
    //      step set it to `smoke-test-rotation-2026!`.
    const adminLogin2 = await app.fetch(
      new Request('http://localhost/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: 'smoke-test-rotation-2026!' }),
      }),
    );
    expect(adminLogin2.status).toBe(200);
    const adminCookie2 = adminLogin2.headers.get('set-cookie') ?? '';
    const adminToken2 = /bunny2_session=([^;]+)/.exec(adminCookie2)?.[1] ?? '';
    expect(adminToken2).not.toBe('');

    // 12b. Resolve admin's personal layer via `GET /me/layers`. The
    //      seed creates `personal-admin`; we pick it explicitly so a
    //      future change to seed ordering does not silently shift the
    //      test onto a different layer.
    interface MeLayersBody {
      readonly layers: ReadonlyArray<{ slug: string; type: string }>;
    }
    const meLayers = await app.fetch(
      new Request('http://localhost/me/layers', {
        headers: { authorization: `Bearer ${adminToken2}` },
      }),
    );
    expect(meLayers.status).toBe(200);
    const meLayersBody = (await meLayers.json()) as MeLayersBody;
    const personal = meLayersBody.layers.find(
      (l) => l.type === 'personal' && l.slug === 'personal-admin',
    );
    expect(personal).toBeDefined();
    const personalSlug = personal!.slug;
    const personalLayerRow = database
      .query<{ id: string }, [string]>('SELECT id FROM layers WHERE slug = ?')
      .get(personalSlug);
    if (personalLayerRow === null) throw new Error(`smoke: layer ${personalSlug} not found`);
    const personalLayerId = personalLayerRow.id;

    // 12c. Swap in a stub-fetched company module so the dispatcher
    //      uses a deterministic KvK response. We reset the registry
    //      first so the default `companyModule` (registered by
    //      `createApp` above) does not collide.
    const STUB_KVK_API_KEY = 'smoke-kvk-key-do-not-leak';
    const SAMPLE_BASISPROFIEL = {
      kvkNummer: '12345678',
      handelsnaam: 'AMI Trade',
      statutaireNaam: 'AMI BV',
      _embedded: {
        hoofdvestiging: {
          websites: ['ami.example'],
          sbiActiviteiten: [{ sbiOmschrijving: 'Software development' }],
          adressen: [
            {
              type: 'bezoekadres',
              straatnaam: 'Hoofdweg',
              huisnummer: 12,
              postcode: '1011AA',
              plaats: 'Amsterdam',
              land: 'NL',
            },
          ],
        },
      },
    };
    const kvkFetchCalls: string[] = [];
    const stubKvkFetch = ((req: string | URL | Request) => {
      const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
      kvkFetchCalls.push(url);
      return Promise.resolve(
        new Response(JSON.stringify(SAMPLE_BASISPROFIEL), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;
    __resetEntityRegistryForTests();
    const stubKvkConnector = createKvkConnector({ fetch: stubKvkFetch });
    const stubCompanyModule = createCompanyModule({ connectors: [stubKvkConnector] });
    registerEntityModule(stubCompanyModule);

    // 12d. Build a fake LLM client for the enrichment runner. Two flow
    //      ids drive the summary / fillFields jobs — match them by
    //      `metadata.flowId` (the same shape
    //      `companies-enrichment.test.ts` uses).
    const llmCalls: { messages: string; flowId: string | undefined }[] = [];
    const fakeLlm: LlmClient = {
      endpoint: 'mock://smoke-enrichment',
      defaultModel: 'mock-default',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        const flowId = typeof req.metadata?.flowId === 'string' ? req.metadata.flowId : undefined;
        llmCalls.push({
          messages: req.messages.map((m) => m.content).join('\n'),
          flowId,
        });
        const content =
          flowId === 'enrichment:companies.fillFields'
            ? JSON.stringify({
                legalName: 'AMI BV',
                tradeName: 'AMI Trade',
                industry: 'Software development',
                description: null,
              })
            : 'AMI BV is a software-development company in Amsterdam.';
        return {
          id: crypto.randomUUID(),
          model: 'mock-default',
          content,
          tokensIn: 16,
          tokensOut: 9,
          raw: null,
        };
      },
    };

    // 12e. Subscribe to the connector + enrichment events directly on
    //      the shared bus so we can assert publication without racing
    //      through the SQLite event log read at the end of the test.
    const companyBusEvents: BusEvent[] = [];
    const unsubRequested = bus.subscribe('entity.connector.sync.requested', (ev) => {
      companyBusEvents.push(ev);
    });
    const unsubSucceeded = bus.subscribe('entity.connector.sync.succeeded', (ev) => {
      companyBusEvents.push(ev);
    });

    // 12f. Wire the dispatcher + enrichment runner against the same
    //      `db` and `bus` the app uses. Both are start()/stop() guarded
    //      so a mid-step failure does not leave subscribers attached.
    const dispatcher = createConnectorDispatcher({ db: database, bus });
    const stubStore = createEntityStore<CompanyPayload>({
      module: stubCompanyModule,
      db: database,
      bus,
      llm: fakeLlm,
    });
    const enrichmentRunner = createEnrichmentRunner({
      db: database,
      bus,
      llm: fakeLlm,
      pricing: loaded.config.llm.pricing,
      resolveStore: () => stubStore as EntityStore<unknown>,
    });
    // Note: we do NOT `dispatcher.start()` — the POST
    // `/external-links` route publishes `sync.requested` and the
    // started subscriber would re-run the connector once more, racing
    // our synchronous `dispatcher.handle(...)` below. The smoke
    // drives the dispatcher manually instead.
    enrichmentRunner.start();
    try {
      // 12g. Attach the KvK connector config to the personal layer via
      //      the production attachments endpoint.
      const attachRes = await app.fetch(
        new Request(`http://localhost/layers/${personalSlug}/attachments`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            kind: 'connector',
            refId: 'kvk',
            config: { apiKey: STUB_KVK_API_KEY, pollIntervalMinutes: 1440 },
          }),
        }),
      );
      expect(attachRes.status).toBe(201);

      // 12.1 POST /l/:slug/company — create "AMI BV". Include
      //      `kvkNumber` in the payload so `withKvk` is 1 immediately;
      //      the connector-driven enrichment will reaffirm it later.
      const createRes = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'AMI BV',
            slug: 'ami-bv',
            originalLocale: 'en',
            payload: { kvkNumber: '12345678' },
          }),
        }),
      );
      expect(createRes.status).toBe(201);
      const createdBody = (await createRes.json()) as {
        entity: { id: string; slug: string; meta: { version: number; originalLocale: string } };
      };
      expect(createdBody.entity.slug).toBe('ami-bv');
      const companyId = createdBody.entity.id;

      // 12.2 GET detail — assert version=1, originalLocale set,
      //      deleted_at null (entity returns meta.deletedAt = null).
      const getRes = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company/ami-bv`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as {
        entity: { meta: { version: number; originalLocale: string; deletedAt: string | null } };
      };
      expect(getBody.entity.meta.version).toBe(1);
      expect(getBody.entity.meta.originalLocale).toBe('en');
      expect(getBody.entity.meta.deletedAt).toBeNull();

      // 12.3 PATCH — update the description. Version must advance.
      const updatedAtBefore = (getBody as unknown as { entity: { meta: { updatedAt: string } } })
        .entity.meta.updatedAt;
      // Pause one millisecond so the new updatedAt strictly differs.
      await new Promise((resolve) => setTimeout(resolve, 2));
      const patchRes = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company/ami-bv`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            payload: {
              kvkNumber: '12345678',
              description: 'A hand-edited description.',
            },
          }),
        }),
      );
      expect(patchRes.status).toBe(200);
      const patchBody = (await patchRes.json()) as {
        entity: { meta: { version: number; updatedAt: string } };
      };
      expect(patchBody.entity.meta.version).toBe(2);
      expect(patchBody.entity.meta.updatedAt > updatedAtBefore).toBe(true);

      // 12.4 POST external-link → link persists at `sync_state='idle'`
      //      and `entity.connector.sync.requested` published.
      const linkRes = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company/ami-bv/external-links`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({ connector: 'kvk', externalId: '12345678' }),
        }),
      );
      expect(linkRes.status).toBe(201);
      const linkBody = (await linkRes.json()) as { externalLink: EntityExternalLink };
      expect(linkBody.externalLink.syncState).toBe('idle');
      expect(linkBody.externalLink.connector).toBe('kvk');
      expect(linkBody.externalLink.externalId).toBe('12345678');
      const requestedEvents = companyBusEvents.filter(
        (e) => e.type === 'entity.connector.sync.requested',
      );
      expect(requestedEvents.length).toBeGreaterThanOrEqual(1);

      // 12.5 Drive the dispatcher synchronously. The link transitions
      //      to `idle` with `synced_at` set; `succeeded` is published.
      await dispatcher.handle({
        ref: {
          id: companyId,
          kind: 'company',
          layerId: personalLayerId,
          slug: 'ami-bv',
        },
        connector: 'kvk',
        externalId: '12345678',
      });
      expect(kvkFetchCalls.length).toBe(1);
      // Re-fetch the entity from the HTTP layer; the link's
      // `syncState` must be `idle` with `synced_at` non-null.
      const afterDispatch = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company/ami-bv`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const afterDispatchBody = (await afterDispatch.json()) as {
        entity: { externalLinks: ReadonlyArray<EntityExternalLink> };
      };
      const refreshedLink = afterDispatchBody.entity.externalLinks.find(
        (l) => l.id === linkBody.externalLink.id,
      );
      expect(refreshedLink?.syncState).toBe('idle');
      expect(refreshedLink?.syncedAt).not.toBeNull();
      const succeededEvents = companyBusEvents.filter(
        (e) => e.type === 'entity.connector.sync.succeeded',
      );
      expect(succeededEvents.length).toBe(1);

      // 12.6 Drive the enrichment runner via `tickOnce()`. The summary
      //      job fires on `created` (event was emitted at step 12.1)
      //      and the fillFields job fires on `sync.succeeded` (from
      //      step 12.5); both apply patches. `payload.description`
      //      must come from the fake LLM (not from the user's PATCH
      //      step, which the runner's "do not overwrite non-empty"
      //      policy preserves UNLESS the trigger is `updated` /
      //      `sync.succeeded` and the field is `description` — see
      //      the 4a.3 close-out's overwrite exception). After two
      //      ticks (one for create + update debounce, one for
      //      sync.succeeded), the version is strictly higher than 2.
      const versionBeforeEnrichment = patchBody.entity.meta.version;
      await enrichmentRunner.tickOnce();
      const afterEnrichment = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company/ami-bv`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const afterEnrichmentBody = (await afterEnrichment.json()) as {
        entity: {
          payload: CompanyPayload;
          meta: { version: number };
        };
      };
      expect(typeof afterEnrichmentBody.entity.payload.description).toBe('string');
      expect((afterEnrichmentBody.entity.payload.description ?? '').length).toBeGreaterThan(0);
      expect(afterEnrichmentBody.entity.meta.version).toBeGreaterThan(versionBeforeEnrichment);
      // The fake LLM was invoked for at least the summary job; the
      // call ledger (`llm.calls` from the telemetry-wrapped chat
      // client) remains 1 because the fake LLM bypasses telemetry.
      expect(llmCalls.length).toBeGreaterThan(0);

      // 12.7 GET list — assert "AMI BV" appears.
      const listRes = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(listRes.status).toBe(200);
      const listBody = (await listRes.json()) as {
        entities: ReadonlyArray<{ slug: string; title: string }>;
      };
      expect(listBody.entities.some((e) => e.slug === 'ami-bv' && e.title === 'AMI BV')).toBe(true);

      // 12.8 GET stats — assert the four counts. `total` 1, `withKvk`
      //      1 (kvkNumber set), `recentlyEnriched` 1 (enrichment
      //      stamped entity_souls), `missingDescription` 0 (fake LLM
      //      wrote the description).
      const statsRes = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company/_stats`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(statsRes.status).toBe(200);
      const statsBody = (await statsRes.json()) as {
        stats: {
          total: number;
          withKvk: number;
          recentlyEnriched: number;
          missingDescription: number;
        };
      };
      expect(statsBody.stats).toEqual({
        total: 1,
        withKvk: 1,
        recentlyEnriched: 1,
        missingDescription: 0,
      });

      // 12.9 DELETE — soft-delete. Subsequent list omits the row;
      //      detail returns 404.
      const deleteRes = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company/ami-bv`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(deleteRes.status).toBe(200);

      const listAfterDelete = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const listAfterDeleteBody = (await listAfterDelete.json()) as {
        entities: ReadonlyArray<{ slug: string }>;
      };
      expect(listAfterDeleteBody.entities.some((e) => e.slug === 'ami-bv')).toBe(false);

      // Soft-deleted entities stay reachable by slug (so a restore
      // flow can read the prior payload) but carry `meta.deletedAt`
      // set. The list endpoint omits them — that's what step 12.9b
      // above just asserted.
      const detailAfterDelete = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company/ami-bv`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(detailAfterDelete.status).toBe(200);
      const detailAfterDeleteBody = (await detailAfterDelete.json()) as {
        entity: { meta: { deletedAt: string | null } };
      };
      expect(detailAfterDeleteBody.entity.meta.deletedAt).not.toBeNull();

      // Secret-strip invariant: the configured KvK apiKey never
      // surfaces on any bus event payload or any LLM prompt during
      // the smoke flow.
      const eventHaystack = JSON.stringify(
        companyBusEvents.map((e) => ({ type: e.type, payload: e.payload, metadata: e.metadata })),
      );
      expect(eventHaystack).not.toContain(STUB_KVK_API_KEY);
      for (const c of llmCalls) {
        expect(c.messages).not.toContain(STUB_KVK_API_KEY);
      }
    } finally {
      enrichmentRunner.stop();
      unsubRequested();
      unsubSucceeded();
      // Restore the default-registered company module so later test
      // files in the same `bun test` run that expect the production
      // module are unaffected.
      __resetEntityRegistryForTests();
    }

    // -----------------------------------------------------------------
    // 13. Phase 4b.6 — canonical Contacts entity flow. Mirrors step 12
    //     for the second entity kind. Covers:
    //       - create / patch / list (CRUD via the generic router)
    //       - vCard ingest (`POST /l/:slug/contact/_ingest/vcard`)
    //       - dedup-by-email re-ingest (idempotent matchKey path)
    //       - enrichment runner: deterministic-first (domain match +
    //         ORG-hint match) populates `companyEntityId` without any
    //         contacts-suggestCompany LLM call
    //       - stats endpoint independently observable
    //       - soft-delete via DELETE
    //       - cross-layer isolation: same slug in a second layer 201s
    //
    //     The step uses an isolated stub LLM whose calls go onto its
    //     OWN ledger (separate from the step-12 `llmCalls`). The fake
    //     LLM returns a non-empty summary for the companies enrichment
    //     job (AMI BV is created here too), but the contacts
    //     `suggestCompany` job runs the deterministic path only — we
    //     assert no LLM call carried the `enrichment:contacts.*`
    //     flowId.
    // -----------------------------------------------------------------

    // 13a. Build a contacts-and-companies module pair that share the
    //      same fake LLM. We construct an enrichment runner that knows
    //      both kinds (the contacts job calls `getEntityModule('company')`
    //      under the hood, so the company module must also be in the
    //      registry).
    const contactsLlmCalls: { messages: string; flowId: string | undefined }[] = [];
    const contactsFakeLlm: LlmClient = {
      endpoint: 'mock://smoke-contacts',
      defaultModel: 'mock-default',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        const flowId = typeof req.metadata?.flowId === 'string' ? req.metadata.flowId : undefined;
        contactsLlmCalls.push({
          messages: req.messages.map((m) => m.content).join('\n'),
          flowId,
        });
        // The companies summary / fillFields jobs may run when AMI BV
        // lands; return something cheap so applyPatch is a no-op (the
        // `description` field is allowed to be overwritten, but the
        // smoke does not assert on it for this step).
        const content =
          flowId === 'enrichment:companies.fillFields'
            ? JSON.stringify({ legalName: 'AMI BV' })
            : 'AMI BV.';
        return {
          id: crypto.randomUUID(),
          model: 'mock-default',
          content,
          tokensIn: 4,
          tokensOut: 2,
          raw: null,
        };
      },
    };
    // Fresh registry: both kinds with empty connector / enrichment-job
    // lists where appropriate. Contacts ships the production
    // suggestCompany job; companies ship empty lists because the
    // smoke only needs companies for the layer-scoped candidate
    // lookup, not for KvK / enrichment.
    const stepCompanyModule = createCompanyModule({ connectors: [], enrichmentJobs: [] });
    // The contacts module ships the production vCard connector — step
    // 13.3/13.4 drive `_ingest/vcard` end-to-end through the dispatcher
    // which resolves the connector by id off the registered module.
    const stepContactModule = createContactModule();
    registerEntityModule(stepCompanyModule);
    registerEntityModule(stepContactModule);
    const contactStore = createEntityStore<ContactPayload>({
      module: stepContactModule,
      db: database,
      bus,
      llm: contactsFakeLlm,
    });
    const companyStoreForContacts = createEntityStore<CompanyPayload>({
      module: stepCompanyModule,
      db: database,
      bus,
      llm: contactsFakeLlm,
    });
    const contactsRunner = createEnrichmentRunner({
      db: database,
      bus,
      llm: contactsFakeLlm,
      pricing: loaded.config.llm.pricing,
      resolveStore: (mod) => {
        if (mod.kind === 'contact') return contactStore as EntityStore<unknown>;
        if (mod.kind === 'company') return companyStoreForContacts as EntityStore<unknown>;
        return null;
      },
    });

    // Subscribe to ingest events so we can prove the ingest path
    // published the right markers without bytes / filenames leaking.
    const contactsBusEvents: BusEvent[] = [];
    const unsubIngestRequested = bus.subscribe('entity.connector.ingest.requested', (ev) => {
      contactsBusEvents.push(ev);
    });
    const unsubIngestCompleted = bus.subscribe('entity.connector.ingest.completed', (ev) => {
      contactsBusEvents.push(ev);
    });

    contactsRunner.start();
    try {
      // 13b. Create AMI BV directly via the store so the deterministic
      //      enrichment paths (domain match on `cs@ami.nl`; ORG-hint
      //      match on `ORG: AMI BV`) have a target. Using
      //      `payload.email = 'cs@ami.nl'` gives the domain matcher a
      //      hit on the company's email field.
      const amiLayerCreate = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'AMI BV',
            slug: 'ami-bv-2',
            originalLocale: 'en',
            payload: { email: 'cs@ami.nl' },
          }),
        }),
      );
      expect(amiLayerCreate.status).toBe(201);
      const amiCreated = (await amiLayerCreate.json()) as {
        entity: { id: string; slug: string };
      };
      const amiId = amiCreated.entity.id;

      // 13.1 POST /l/:slug/contact — create Alice.
      const aliceCreate = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'Alice',
            slug: 'alice',
            originalLocale: 'en',
            payload: {
              givenName: 'Alice',
              emails: [{ value: 'alice@ami.nl', isPrimary: true }],
            },
          }),
        }),
      );
      expect(aliceCreate.status).toBe(201);
      const aliceBody = (await aliceCreate.json()) as {
        entity: { id: string; slug: string; meta: { version: number; updatedAt: string } };
      };
      expect(aliceBody.entity.slug).toBe('alice');
      expect(aliceBody.entity.meta.version).toBe(1);
      const aliceUpdatedAtV1 = aliceBody.entity.meta.updatedAt;

      // Sanity: Alice appears in the list.
      const listAfterCreate = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const listAfterCreateBody = (await listAfterCreate.json()) as {
        entities: ReadonlyArray<{ slug: string }>;
      };
      expect(listAfterCreateBody.entities.some((e) => e.slug === 'alice')).toBe(true);

      // 13.2 PATCH — set the job title. Version must advance, updatedAt
      //      must strictly exceed the v1 timestamp.
      await new Promise((resolve) => setTimeout(resolve, 2));
      const alicePatch = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact/alice`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            payload: {
              givenName: 'Alice',
              emails: [{ value: 'alice@ami.nl', isPrimary: true }],
              jobTitle: 'Engineer',
            },
          }),
        }),
      );
      expect(alicePatch.status).toBe(200);
      const alicePatchBody = (await alicePatch.json()) as {
        entity: { meta: { version: number; updatedAt: string } };
      };
      expect(alicePatchBody.entity.meta.version).toBe(2);
      expect(alicePatchBody.entity.meta.updatedAt > aliceUpdatedAtV1).toBe(true);

      // 13.3 vCard import — POST a small multipart vCard 3.0 entry for
      //      Bob. Body intentionally contains an ORG hint so the
      //      deterministic ORG matcher can pick AMI BV for Bob too.
      const bobVcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Bob',
        'EMAIL:bob@ami.nl',
        'ORG:AMI BV',
        'END:VCARD',
        '',
      ].join('\r\n');

      function vcardMultipartRequest(body: string): Request {
        const form = new FormData();
        form.append('file', new File([body], 'bob.vcf', { type: 'text/vcard' }));
        return new Request(`http://localhost/l/${personalSlug}/contact/_ingest/vcard`, {
          method: 'POST',
          headers: { authorization: `Bearer ${adminToken2}` },
          body: form,
        });
      }

      const ingestRes = await app.fetch(vcardMultipartRequest(bobVcard));
      expect(ingestRes.status).toBe(200);
      const ingestBody = (await ingestRes.json()) as {
        created: number;
        updated: number;
        warnings: readonly string[];
      };
      expect(ingestBody).toEqual({ created: 1, updated: 0, warnings: [] });
      // The dispatcher published exactly one ingest.completed event for
      // this run, and the payload carries the summary (no bytes / no
      // filename) — see ADR 0014.
      const completedEvents = contactsBusEvents.filter(
        (e) => e.type === 'entity.connector.ingest.completed',
      );
      expect(completedEvents.length).toBeGreaterThanOrEqual(1);
      const lastCompleted = completedEvents[completedEvents.length - 1];
      const lastCompletedPayload = (lastCompleted?.payload ?? {}) as Record<string, unknown>;
      expect(lastCompletedPayload.created).toBe(1);
      expect(lastCompletedPayload.updated).toBe(0);
      // Bob now appears in the list.
      const listAfterIngest = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const listAfterIngestBody = (await listAfterIngest.json()) as {
        entities: ReadonlyArray<{ slug: string; title: string }>;
      };
      expect(listAfterIngestBody.entities.some((e) => e.title === 'Bob')).toBe(true);

      // 13.4 Dedup-by-email — re-POST the same vCard. The dispatcher's
      //      `matchKey = { kind: 'email', value: 'bob@ami.nl' }` resolves
      //      to the existing row and the path becomes update, not
      //      create. Bob's version bumps from 1 → 2.
      const ingestAgain = await app.fetch(vcardMultipartRequest(bobVcard));
      expect(ingestAgain.status).toBe(200);
      const ingestAgainBody = (await ingestAgain.json()) as {
        created: number;
        updated: number;
        warnings: readonly string[];
      };
      expect(ingestAgainBody).toEqual({ created: 0, updated: 1, warnings: [] });
      // Confirm Bob's version is now 2 by fetching the entity. We
      // resolve the slug from the list (the vCard parser slugifies
      // `Bob` → `bob`).
      const bobRow = listAfterIngestBody.entities.find((e) => e.title === 'Bob');
      expect(bobRow).toBeDefined();
      const bobSlug = bobRow!.slug;
      const bobGetAfterDedup = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact/${bobSlug}`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(bobGetAfterDedup.status).toBe(200);
      const bobBody = (await bobGetAfterDedup.json()) as {
        entity: { id: string; meta: { version: number }; payload: ContactPayload };
      };
      expect(bobBody.entity.meta.version).toBe(2);

      // 13.5 Enrichment — drive the runner once. Alice's domain match
      //      and Bob's ORG-hint match are both deterministic; neither
      //      should invoke the contacts.suggestCompany LLM job.
      await contactsRunner.tickOnce();

      const aliceAfterEnrich = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact/alice`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const aliceAfterEnrichBody = (await aliceAfterEnrich.json()) as {
        entity: { payload: ContactPayload };
      };
      expect(aliceAfterEnrichBody.entity.payload.companyEntityId).toBe(amiId);

      const bobAfterEnrich = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact/${bobSlug}`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const bobAfterEnrichBody = (await bobAfterEnrich.json()) as {
        entity: { payload: ContactPayload };
      };
      expect(bobAfterEnrichBody.entity.payload.companyEntityId).toBe(amiId);

      // No `enrichment:contacts.suggestCompany` LLM call: the
      // deterministic-first paths covered both contacts. The companies
      // enrichment jobs may have called the fake LLM, but that's a
      // different flowId.
      const contactsLlmFlowIds = contactsLlmCalls.map((c) => c.flowId);
      expect(contactsLlmFlowIds).not.toContain('enrichment:contacts.suggestCompany');

      // 13.6 Stats — `_stats` returns the four counters independently.
      //      total=2 (Alice + Bob), withCompanyLink=2 (enrichment
      //      linked both), missingEmail=0 (both have a primary email),
      //      recentlyEnriched=2 (enrichment runner stamped both
      //      entity_souls rows within the 24h window).
      const statsRes2 = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact/_stats`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(statsRes2.status).toBe(200);
      const statsRes2Body = (await statsRes2.json()) as {
        stats: {
          total: number;
          withCompanyLink: number;
          missingEmail: number;
          recentlyEnriched: number;
        };
      };
      expect(statsRes2Body.stats).toEqual({
        total: 2,
        withCompanyLink: 2,
        missingEmail: 0,
        recentlyEnriched: 2,
      });

      // 13.7 DELETE Alice — soft-delete. List omits her; Bob stays.
      //      The §4.0 contract keeps the detail-GET reachable by slug
      //      with `meta.deletedAt` set (same as the Companies flow at
      //      step 12.9), so we assert the soft-delete shape here too.
      const deleteAlice = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact/alice`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(deleteAlice.status).toBe(200);
      const listAfterDelete2 = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const listAfterDelete2Body = (await listAfterDelete2.json()) as {
        entities: ReadonlyArray<{ slug: string }>;
      };
      expect(listAfterDelete2Body.entities.some((e) => e.slug === 'alice')).toBe(false);
      expect(listAfterDelete2Body.entities.some((e) => e.slug === bobSlug)).toBe(true);
      const aliceAfterDelete = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact/alice`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(aliceAfterDelete.status).toBe(200);
      const aliceAfterDeleteBody = (await aliceAfterDelete.json()) as {
        entity: { meta: { deletedAt: string | null } };
      };
      expect(aliceAfterDeleteBody.entity.meta.deletedAt).not.toBeNull();

      // 13.8 Cross-layer isolation — create a fresh project layer and
      //      create a contact with the SAME `alice` slug in it. The
      //      §4.0 slug uniqueness rule is per-layer, so this must
      //      succeed (201) without colliding with the personal-layer
      //      Alice we just soft-deleted.
      const otherLayerRes = await app.fetch(
        new Request('http://localhost/layers', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            type: 'project',
            slug: 'contact-isolation',
            name: 'Contact isolation',
          }),
        }),
      );
      expect(otherLayerRes.status).toBe(201);
      const aliceInOther = await app.fetch(
        new Request('http://localhost/l/contact-isolation/contact', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'Alice',
            slug: 'alice',
            originalLocale: 'en',
            payload: { givenName: 'Alice' },
          }),
        }),
      );
      expect(aliceInOther.status).toBe(201);

      // 13.9 Secret-strip invariant — no ingest event carries bytes or
      //      the original filename. The router and dispatcher strip
      //      both before publishing (ADR 0014 §7).
      const ingestEventHaystack = JSON.stringify(
        contactsBusEvents.map((e) => ({ type: e.type, payload: e.payload })),
      );
      expect(ingestEventHaystack).not.toContain('BEGIN:VCARD');
      expect(ingestEventHaystack).not.toContain('bob.vcf');
    } finally {
      contactsRunner.stop();
      unsubIngestRequested();
      unsubIngestCompleted();
      __resetEntityRegistryForTests();
    }

    // -----------------------------------------------------------------
    // 14. Phase 4c.6 — canonical Calendar entity flow. Mirrors steps 12
    //     and 13 for the third entity kind. Covers:
    //       - create / patch (CRUD via the generic router)
    //       - Google Calendar ingest (`POST .../_ingest/google.calendar`)
    //         with the stubbed token endpoint + events.list response
    //         driven via `dispatcher.ingest(...)` so we can wire the
    //         Google-aware config resolver (the createApp-default
    //         resolver does not surface `attachmentId`, which only
    //         matters when the stub returns a `nextSyncToken`; we
    //         deliberately omit it to keep the seam narrow)
    //       - dedup-by-externalId re-ingest: per
    //         `docs/dev/follow-ups/ingest-externalid-dedup.md` the
    //         dispatcher does NOT yet write `entity_external_links` on
    //         `create` from ingest, so re-ingest would naively create
    //         duplicates. The smoke documents the gap by inserting the
    //         links between calls — that matches the intended contract.
    //       - enrichment runner: `calendar.attendeeContacts` resolves
    //         the seeded "Alice" attendee by exact email match (no LLM
    //         call); `calendar.summary` fires once for the same event.
    //       - the per-job soul stamp (`lastEnrichedAtVersionByJob`) is
    //         set for both jobs.
    //       - re-tick is a no-op for the LLM ledger (idempotence sanity).
    //       - stats endpoint independently observable.
    //       - `meetingSummaryNote` preservation regression: PATCH
    //         without the field. The router PATCH merges the incoming
    //         payload against the stored payload at the top-level-key
    //         layer (see
    //         `docs/dev/follow-ups/done/calendar-patch-payload-merge.md`)
    //         so the runner-owned field survives a partial PATCH.
    //       - soft-delete: list omits, detail returns soft-deleted row.
    //       - cross-layer isolation.
    //       - leak canary: clientSecret / refreshToken plaintext never
    //         on the bus during pull or ingest.
    // -----------------------------------------------------------------

    // 14a. Encrypt the OAuth secrets via a test secrets service. The
    //      production `BUNNY2_ENCRYPTION_KEY` env var stays unset for
    //      the smoke — the same service is passed into the stub Google
    //      connector so decrypt round-trips inside the test.
    const STUB_CLIENT_SECRET = 'smoke-google-client-secret-do-not-leak';
    const STUB_REFRESH_TOKEN = 'smoke-google-refresh-token-do-not-leak';
    const STUB_CLIENT_ID = 'smoke-gcal-client-id.apps.googleusercontent.com';
    const STUB_ACCESS_TOKEN = 'smoke-gcal-access-token';
    const calendarSecrets = createSecretsService({ key: generateEncryptionKey() });

    // 14b. Stub the Google API: token endpoint + events.list. The
    //      events.get path is not exercised in this step (we drive
    //      ingest, not pull). Three confirmed events: one normal, one
    //      all-day, one with multiple attendees including Alice's
    //      email so the deterministic attendeeContacts path resolves
    //      her contact entity id without any LLM call. `nextSyncToken`
    //      is intentionally absent — the connector's syncToken
    //      write-back gates on `cfg.attachmentId`, which the resolver
    //      we wire below DOES set; we just want to avoid coupling the
    //      assertion to a side effect that lives in a different write
    //      path.
    const FAKE_GOOGLE_EVENTS = [
      {
        id: 'smoke-evt-001',
        status: 'confirmed',
        summary: 'Standup',
        description: 'Daily team sync',
        start: { dateTime: '2026-06-01T09:00:00Z' },
        end: { dateTime: '2026-06-01T09:30:00Z' },
        location: 'Rotterdam HQ',
      },
      {
        id: 'smoke-evt-002',
        status: 'confirmed',
        summary: 'Holiday',
        start: { date: '2026-06-05' },
        end: { date: '2026-06-06' },
      },
      {
        id: 'smoke-evt-003',
        status: 'confirmed',
        summary: 'Quarterly review',
        description: 'Review the quarter with Alice and team.',
        start: { dateTime: '2026-06-03T15:00:00Z' },
        end: { dateTime: '2026-06-03T16:00:00Z' },
        location: 'HQ · room 4',
        attendees: [
          { email: 'alice@ami.nl', displayName: 'Alice', responseStatus: 'accepted' },
          { email: 'admin@example.com', responseStatus: 'accepted' },
        ],
      },
    ];
    const gcalUrls: string[] = [];
    const stubGoogleFetch = ((req: string | URL | Request) => {
      const url = typeof req === 'string' ? req : req instanceof URL ? req.href : req.url;
      gcalUrls.push(url);
      if (url.includes('oauth2.googleapis.com/token')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              access_token: STUB_ACCESS_TOKEN,
              expires_in: 3600,
              token_type: 'Bearer',
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      }
      if (url.includes('/events/')) {
        // events.get — for a hypothetical pull; we drive ingest so this
        // path stays unused in this step. Return the matching item by id
        // anyway for completeness.
        const lastSegment = decodeURIComponent(url.split('/events/')[1] ?? '');
        const item = FAKE_GOOGLE_EVENTS.find((e) => e.id === lastSegment) ?? {};
        return Promise.resolve(
          new Response(JSON.stringify(item), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      }
      // events.list
      return Promise.resolve(
        new Response(JSON.stringify({ items: FAKE_GOOGLE_EVENTS }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as typeof fetch;

    // 14c. Pre-register the stub-fetched calendar module + the contact
    //      module (the attendeeContacts job needs the contact registry
    //      entry for its candidate enumeration). The personal layer
    //      from step 12/13 is reused; it still holds the AMI BV
    //      company + Alice contact rows from step 13.
    __resetEntityRegistryForTests();
    const stubGoogleConnector = createGoogleCalendarConnector({
      fetch: stubGoogleFetch,
      secrets: calendarSecrets,
    });
    // The runner now refreshes the in-memory entity between jobs in
    // the same tick (see
    // `docs/dev/follow-ups/done/enrichment-runner-stale-payload.md`),
    // so the production job order
    // `[attendeeContactsJob, summaryJob]` works as declared in
    // `apps/server/src/entities/calendar/enrichment.ts`.
    const stubCalendarModule = createCalendarEventModule({
      connectors: [stubGoogleConnector],
      enrichmentJobs: [calendarAttendeeContactsJob, calendarSummaryJob],
    });
    const stepContactModuleForCal = createContactModule();
    registerEntityModule(stubCalendarModule);
    registerEntityModule(stepContactModuleForCal);

    // Seed a fresh "Alice" contact in the personal layer — step 13's
    // Alice was soft-deleted, and the attendeeContacts job's email
    // match excludes soft-deleted contacts. Use a different slug so
    // the per-layer slug uniqueness rule lets both rows coexist.
    const aliceForCalCreate = await app.fetch(
      new Request(`http://localhost/l/${personalSlug}/contact`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${adminToken2}`,
        },
        body: JSON.stringify({
          title: 'Alice',
          slug: 'alice-cal',
          originalLocale: 'en',
          payload: {
            givenName: 'Alice',
            emails: [{ value: 'alice@ami.nl', isPrimary: true }],
          },
        }),
      }),
    );
    expect(aliceForCalCreate.status).toBe(201);
    const aliceForCalBody = (await aliceForCalCreate.json()) as { entity: { id: string } };
    const aliceCalId = aliceForCalBody.entity.id;

    // 14d. Attach the Google Calendar connector config to the personal
    //      layer via the repo (no HTTP attachment endpoint validates
    //      enc:v1: shape — the connector's `verify` is invoked at
    //      pull/ingest time, and the route is permissive). The
    //      attachment id is captured so the resolver can hand it to
    //      the connector.
    const attachmentsRepo = createLayerAttachmentsRepo(database);
    const gcalAttachmentId = crypto.randomUUID();
    attachmentsRepo.insertAttachment({
      id: gcalAttachmentId,
      layerId: personalLayerId,
      kind: 'connector',
      refId: GOOGLE_CALENDAR_CONNECTOR_ID,
      config: {
        clientId: STUB_CLIENT_ID,
        clientSecret: calendarSecrets.encryptSecret(STUB_CLIENT_SECRET),
        refreshToken: calendarSecrets.encryptSecret(STUB_REFRESH_TOKEN),
        calendarId: 'primary',
        pollIntervalMinutes: 60,
      },
      now: new Date().toISOString(),
    });

    // 14e. Build a fake LLM and a dedicated dispatcher with the Google
    //      config resolver so `ingest` sees `attachmentId`. The
    //      smoke's createApp-wired `ingestDispatcher` uses the default
    //      resolver — we deliberately bypass it here.
    const calendarLlmCalls: { messages: string; flowId: string | undefined }[] = [];
    const calendarFakeLlm: LlmClient = {
      endpoint: 'mock://smoke-calendar',
      defaultModel: 'mock-default',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        const flowId = typeof req.metadata?.flowId === 'string' ? req.metadata.flowId : undefined;
        calendarLlmCalls.push({
          messages: req.messages.map((m) => m.content).join('\n'),
          flowId,
        });
        return {
          id: crypto.randomUUID(),
          model: 'mock-default',
          content: 'Brief meeting summary covering the agenda and attendees.',
          tokensIn: 12,
          tokensOut: 9,
          raw: null,
        };
      },
    };
    const calendarDispatcher = createConnectorDispatcher({
      db: database,
      bus,
      llm: calendarFakeLlm,
      resolveConfig: createGoogleCalendarConfigResolver(database),
    });

    // 14f. Calendar event store + enrichment runner. The runner has to
    //      resolve calendar AND contact stores (the attendeeContacts
    //      job looks up contacts under the same layer).
    const calendarStore = createEntityStore<CalendarEventPayload>({
      module: stubCalendarModule,
      db: database,
      bus,
      llm: calendarFakeLlm,
    });
    const contactStoreForCal = createEntityStore<ContactPayload>({
      module: stepContactModuleForCal,
      db: database,
      bus,
      llm: calendarFakeLlm,
    });
    const calendarEnrichmentRunner = createEnrichmentRunner({
      db: database,
      bus,
      llm: calendarFakeLlm,
      pricing: loaded.config.llm.pricing,
      resolveStore: (mod) => {
        if (mod.kind === 'calendar_event') return calendarStore as EntityStore<unknown>;
        if (mod.kind === 'contact') return contactStoreForCal as EntityStore<unknown>;
        return null;
      },
    });
    calendarEnrichmentRunner.start();

    // Subscribe to ingest events so the leak canary + completed event
    // assertions can read the captured payloads.
    const calendarBusEvents: BusEvent[] = [];
    const unsubCalIngestRequested = bus.subscribe('entity.connector.ingest.requested', (ev) => {
      calendarBusEvents.push(ev);
    });
    const unsubCalIngestCompleted = bus.subscribe('entity.connector.ingest.completed', (ev) => {
      calendarBusEvents.push(ev);
    });

    try {
      // 14.1 POST /l/:slug/calendar_event — create "Project kickoff".
      //      Pre-seed Alice via `attendees[0]` so the deterministic
      //      attendee-resolution path has a clear match candidate.
      const startsAt = '2026-06-08T10:00:00Z';
      const kickoffCreate = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar_event`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'Project kickoff',
            slug: 'project-kickoff',
            originalLocale: 'en',
            payload: {
              startsAt,
              endsAt: '2026-06-08T11:00:00Z',
              allDay: false,
              location: 'Boardroom',
              attendees: [{ value: 'alice@ami.nl', displayName: 'Alice' }],
            },
          }),
        }),
      );
      expect(kickoffCreate.status).toBe(201);
      const kickoffBody = (await kickoffCreate.json()) as {
        entity: { id: string; slug: string; meta: { version: number } };
      };
      expect(kickoffBody.entity.slug).toBe('project-kickoff');
      expect(kickoffBody.entity.meta.version).toBe(1);
      const kickoffId = kickoffBody.entity.id;

      // 14.2 PATCH — change the location. Version advances to 2. The
      //      PATCH carries the full payload because the router does NOT
      //      merge against the stored payload (see the
      //      `calendar-patch-payload-merge` follow-up).
      const kickoffPatch = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar_event/project-kickoff`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            payload: {
              startsAt,
              endsAt: '2026-06-08T11:00:00Z',
              allDay: false,
              location: 'Boardroom A',
              attendees: [{ value: 'alice@ami.nl', displayName: 'Alice' }],
            },
          }),
        }),
      );
      expect(kickoffPatch.status).toBe(200);
      const kickoffPatchBody = (await kickoffPatch.json()) as {
        entity: { meta: { version: number } };
      };
      expect(kickoffPatchBody.entity.meta.version).toBe(2);

      // 14.3 Google Calendar ingest — drive `dispatcher.ingest(...)`
      //      synchronously with the synthetic content-type. The stub
      //      `fetch` returns 3 confirmed events; none cancelled, so
      //      every item maps to a `ConnectorIngestEntity` with
      //      `matchKey: { kind: 'externalId', value: item.id }`. The
      //      dispatcher's externalId match relies on
      //      `entity_external_links` — empty for fresh imports, so all
      //      three create. We capture the new entities' ids by reading
      //      back the calendar_events rows whose slug matches the
      //      auto-assigned uuid slug (`store.create` falls back to the
      //      entity id when no slug is provided).
      const ingestResult = await calendarDispatcher.ingest({
        kind: 'calendar_event',
        connectorId: GOOGLE_CALENDAR_CONNECTOR_ID,
        layerId: personalLayerId,
        actorId: admin.userId,
        payload: {
          contentType: GOOGLE_CALENDAR_INGEST_CONTENT_TYPE,
          bytes: new Uint8Array(),
        },
        originalLocale: 'en',
      });
      expect(ingestResult).toEqual({ created: 3, updated: 0, warnings: [] });
      const completedCalEvents = calendarBusEvents.filter(
        (e) => e.type === 'entity.connector.ingest.completed',
      );
      expect(completedCalEvents.length).toBeGreaterThanOrEqual(1);

      // Document the externalId dedup gap (see
      // `docs/dev/follow-ups/ingest-externalid-dedup.md`): the
      // dispatcher does not write `entity_external_links` on
      // create-from-ingest. We manually back-fill them so the second
      // ingest finds matches via the documented matchKey contract.
      const ingestedRows = database
        .query<{ id: string; payload_json: string }, [string]>(
          `SELECT id, payload_json FROM calendar_events
            WHERE layer_id = ? AND deleted_at IS NULL`,
        )
        .all(personalLayerId);
      for (const row of ingestedRows) {
        const payload = JSON.parse(row.payload_json) as { externalCalendarId?: string };
        if (payload.externalCalendarId === undefined) continue;
        // Reverse-map: the stub events all have `externalCalendarId =
        // 'primary'` and the per-event id is what the dispatcher used as
        // its matchKey value. Use the title to locate the matching stub
        // event id.
        const titleRow = database
          .query<{ title: string }, [string]>(`SELECT title FROM calendar_events WHERE id = ?`)
          .get(row.id);
        const stub = FAKE_GOOGLE_EVENTS.find((e) => e.summary === titleRow?.title);
        if (stub === undefined) continue;
        calendarStore.addExternalLink({
          ref: {
            id: row.id,
            kind: 'calendar_event',
            layerId: personalLayerId,
            slug: row.id,
          },
          connector: GOOGLE_CALENDAR_CONNECTOR_ID,
          externalId: stub.id,
        });
      }

      // 14.4 Re-ingest: the dispatcher's externalId matchKey resolves
      //      against the back-filled `entity_external_links` rows, so
      //      every item is an update. Three updates, no creates.
      const ingestResult2 = await calendarDispatcher.ingest({
        kind: 'calendar_event',
        connectorId: GOOGLE_CALENDAR_CONNECTOR_ID,
        layerId: personalLayerId,
        actorId: admin.userId,
        payload: {
          contentType: GOOGLE_CALENDAR_INGEST_CONTENT_TYPE,
          bytes: new Uint8Array(),
        },
        originalLocale: 'en',
      });
      expect(ingestResult2).toEqual({ created: 0, updated: 3, warnings: [] });

      // Secret-strip canary: neither the clientSecret nor the
      // refreshToken plaintext appears in any captured ingest event.
      const calEventHaystack = JSON.stringify(
        calendarBusEvents.map((e) => ({ type: e.type, payload: e.payload })),
      );
      expect(calEventHaystack).not.toContain(STUB_CLIENT_SECRET);
      expect(calEventHaystack).not.toContain(STUB_REFRESH_TOKEN);

      // 14.5 Enrichment — drive the runner. `calendar.attendeeContacts`
      //      resolves the kickoff event's Alice attendee deterministically
      //      (exact email match) — NO LLM call. `calendar.summary`
      //      fires for the same event (it has location + description
      //      sources via the patch; "Project kickoff" itself has a
      //      location so `hasSummarisableContent` returns true). The
      //      three ingested events are also enrichment candidates,
      //      but only the third has multiple attendees or non-empty
      //      description — so the summary job may fire on a subset.
      //      We assert specifically on the kickoff event, which is the
      //      smoke's controlled fixture.
      //
      //      A single tick is sufficient: the runner now refreshes
      //      the entity between jobs in the same tick (see
      //      `docs/dev/follow-ups/done/enrichment-runner-stale-payload.md`),
      //      so the attendeeContacts job's `attendees` write and the
      //      summary job's `meetingSummaryNote` write both land
      //      together. The second tick remains because the first
      //      tick's `store.update` re-publishes
      //      `entity.calendar_event.updated`, scheduling the entity
      //      for a follow-up tick; running that tick here drains the
      //      pending queue so the §14.6 idempotence assertion below
      //      runs against a settled state.
      await calendarEnrichmentRunner.tickOnce();
      await calendarEnrichmentRunner.tickOnce();

      // Kickoff event: attendees[0].contactEntityId should be the
      // alice-cal id, applied without invoking the attendeeContacts
      // LLM fallback.
      const kickoffAfter = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar_event/project-kickoff`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(kickoffAfter.status).toBe(200);
      const kickoffAfterBody = (await kickoffAfter.json()) as {
        entity: {
          id: string;
          meta: { version: number };
          payload: CalendarEventPayload;
        };
      };
      const aliceAttendee = kickoffAfterBody.entity.payload.attendees?.find(
        (a) => a.value === 'alice@ami.nl',
      );
      expect(aliceAttendee).toBeDefined();
      expect(aliceAttendee?.contactEntityId).toBe(aliceCalId);

      // attendeeContacts did not consult the LLM for the kickoff
      // event — the exact-email match short-circuited the job. Other
      // ingested events (e.g. the quarterly-review fake event whose
      // `admin@example.com` attendee matches no contact) may fall
      // through to the LLM fallback; we assert the kickoff branch by
      // proving no LLM call's prompt mentions the kickoff title.
      const attendeeLlmCallsAboutKickoff = calendarLlmCalls.filter(
        (c) =>
          c.flowId === 'enrichment:calendar.attendeeContacts' &&
          c.messages.includes('Project kickoff'),
      );
      expect(attendeeLlmCallsAboutKickoff.length).toBe(0);

      // Summary LLM fired for at least one event — the kickoff has
      // location which `hasSummarisableContent` accepts.
      const summaryLlmCalls = calendarLlmCalls.filter(
        (c) => c.flowId === 'enrichment:calendar.summary',
      );
      expect(summaryLlmCalls.length).toBeGreaterThanOrEqual(1);

      // The kickoff event now carries a `meetingSummaryNote`.
      expect(typeof kickoffAfterBody.entity.payload.meetingSummaryNote).toBe('string');
      expect((kickoffAfterBody.entity.payload.meetingSummaryNote ?? '').length).toBeGreaterThan(0);

      // Soul stamps for both calendar jobs land on the kickoff event.
      const soulRow = database
        .query<
          { memory_json: string },
          [string]
        >(`SELECT memory_json FROM entity_souls WHERE entity_id = ?`)
        .get(kickoffId);
      expect(soulRow).not.toBeNull();
      const soul = JSON.parse(soulRow!.memory_json) as {
        lastEnrichedAtVersionByJob?: Record<string, number>;
      };
      expect(typeof soul.lastEnrichedAtVersionByJob?.['calendar.attendeeContacts']).toBe('number');
      expect(typeof soul.lastEnrichedAtVersionByJob?.['calendar.summary']).toBe('number');

      // 14.6 Idempotence — after the pre-ticks above settle, the
      //      kickoff event is stable: its attendees carry
      //      contactEntityId and its meetingSummaryNote is present.
      //      Running another tick should not invoke the
      //      attendeeContacts LLM fallback for the kickoff (the
      //      `needsWork` short-circuit fires) and the summary job
      //      idempotence guard short-circuits too.
      const llmCallsBeforeIdem = calendarLlmCalls.length;
      await calendarEnrichmentRunner.tickOnce();
      const newAttendeeAboutKickoff = calendarLlmCalls
        .slice(llmCallsBeforeIdem)
        .filter(
          (c) =>
            c.flowId === 'enrichment:calendar.attendeeContacts' &&
            c.messages.includes('Project kickoff'),
        );
      expect(newAttendeeAboutKickoff.length).toBe(0);

      // 14.7 Stats — `_stats` returns four independently-observable
      //      counters. `total` is 4 (kickoff + 3 ingested). The
      //      ingest's third stub event has 2 attendees, of which one
      //      (admin@example.com) is NOT an existing contact and one
      //      (alice@ami.nl) IS — so attendeeContacts may link Alice on
      //      that event too. We assert lower bounds where the exact
      //      number depends on the runner's debounce timing in this
      //      step.
      const calStatsRes = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar_event/_stats`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(calStatsRes.status).toBe(200);
      const calStatsBody = (await calStatsRes.json()) as {
        stats: {
          total: number;
          upcomingNext7d: number;
          withAttendeesLinked: number;
          recentlyEnriched: number;
        };
      };
      expect(calStatsBody.stats.total).toBe(4);
      expect(calStatsBody.stats.withAttendeesLinked).toBeGreaterThanOrEqual(1);
      expect(calStatsBody.stats.recentlyEnriched).toBe(4);

      // 14.8 `meetingSummaryNote` preservation regression. The router
      //      PATCH merges the incoming payload against the stored
      //      payload at the top-level-key layer (see
      //      `docs/dev/follow-ups/done/calendar-patch-payload-merge.md`).
      //      A PATCH that omits `meetingSummaryNote` MUST preserve the
      //      runner-written value — the merge code path is exercised
      //      end-to-end here.
      const summaryBefore = kickoffAfterBody.entity.payload.meetingSummaryNote;
      const patchWithoutSummary = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar_event/project-kickoff`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            payload: {
              startsAt,
              endsAt: '2026-06-08T11:00:00Z',
              allDay: false,
              location: 'Boardroom B',
              attendees: kickoffAfterBody.entity.payload.attendees,
            },
          }),
        }),
      );
      expect(patchWithoutSummary.status).toBe(200);
      const patchedAgain = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar_event/project-kickoff`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const patchedAgainBody = (await patchedAgain.json()) as {
        entity: { payload: CalendarEventPayload };
      };
      // The runner-owned field survives a PATCH that does not include
      // it. Equal to the value the summary job wrote earlier — the
      // merge preserves the exact string, it does not regenerate it.
      expect(patchedAgainBody.entity.payload.meetingSummaryNote).not.toBeUndefined();
      expect(patchedAgainBody.entity.payload.meetingSummaryNote).toBe(summaryBefore);

      // 14.9 DELETE — soft-delete the kickoff event. The list omits
      //      it; detail keeps returning the soft-deleted row.
      const calDelete = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar_event/project-kickoff`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(calDelete.status).toBe(200);
      const calListAfterDelete = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar_event`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const calListAfterDeleteBody = (await calListAfterDelete.json()) as {
        entities: ReadonlyArray<{ slug: string }>;
      };
      expect(calListAfterDeleteBody.entities.some((e) => e.slug === 'project-kickoff')).toBe(false);
      expect(calListAfterDeleteBody.entities.length).toBe(3);
      const kickoffAfterDelete = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar_event/project-kickoff`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(kickoffAfterDelete.status).toBe(200);
      const kickoffAfterDeleteBody = (await kickoffAfterDelete.json()) as {
        entity: { meta: { deletedAt: string | null } };
      };
      expect(kickoffAfterDeleteBody.entity.meta.deletedAt).not.toBeNull();

      // 14.10 Cross-layer isolation — the project-isolation layer from
      //       step 13 stays empty of calendar events.
      const isolationList = await app.fetch(
        new Request('http://localhost/l/contact-isolation/calendar_event', {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(isolationList.status).toBe(200);
      const isolationListBody = (await isolationList.json()) as {
        entities: ReadonlyArray<{ slug: string }>;
      };
      expect(isolationListBody.entities.length).toBe(0);
    } finally {
      calendarEnrichmentRunner.stop();
      unsubCalIngestRequested();
      unsubCalIngestCompleted();
      __resetEntityRegistryForTests();
    }
    // Touch `gcalUrls` so a future maintainer who reaches for the stub
    // call ledger can lean on it without TS complaining about the
    // unread const. The leak canary above is the load-bearing assertion.
    expect(gcalUrls.length).toBeGreaterThan(0);

    // -----------------------------------------------------------------
    // 15. Phase 4d.7 — canonical Todos entity flow. Mirrors steps 12,
    //     13, and 14 for the fourth (final) phase-4 entity kind. Covers:
    //       - create / patch (CRUD via the generic router)
    //       - cross-kind link validation (POST + PATCH)
    //       - cross-kind link rejection for unknown targets
    //       - AI auto-priority (deterministic keyword path — no LLM)
    //       - AI auto-due (deterministic Dutch "morgen" path — no LLM)
    //       - todo → calendar projection bridge (4d.6) materialises a
    //         row in `calendar_projection_todos` and the
    //         `GET /l/:slug/calendar/_projections/todos` endpoint
    //         surfaces it.
    //       - projection clears on soft-delete. PATCH-clear via
    //         `dueAt: null` is intentionally NOT tested: `dueAt` is
    //         `.optional()` (not nullable) on the schema, so a PATCH
    //         carrying `dueAt: null` fails zod parse with 400 and the
    //         soft-delete path is the only HTTP-driven way to clear
    //         the projection. See the 4d.7 close-out and ADR 0017.
    //       - stats endpoint independently observable.
    //       - cross-layer isolation (todos in another layer do not
    //         leak into the list / stats / projection endpoints).
    //       - secret-strip canary mirrors prior steps (no apiKey-shaped
    //         string in any captured bus event).
    // -----------------------------------------------------------------

    // 15a. Pre-register fresh module variants for the three kinds the
    //      step needs: company + contact (the cross-kind link target
    //      pool) and todo (with the production enrichment jobs wired).
    //      The fake LLM is wired so we can assert the deterministic
    //      paths never invoked it for the kickoff todos (the runner's
    //      autoPriority job falls back to the LLM ONLY when the
    //      deterministic word/tag/proximity scans return null; the
    //      autoDue job has NO LLM fallback by design — see ADR 0013
    //      Update (4d.3)).
    const todosLlmCalls: { messages: string; flowId: string | undefined }[] = [];
    const todosFakeLlm: LlmClient = {
      endpoint: 'mock://smoke-todos',
      defaultModel: 'mock-default',
      async chat(req: ChatRequest): Promise<ChatResponse> {
        const flowId = typeof req.metadata?.flowId === 'string' ? req.metadata.flowId : undefined;
        todosLlmCalls.push({
          messages: req.messages.map((m) => m.content).join('\n'),
          flowId,
        });
        return {
          id: crypto.randomUUID(),
          model: 'mock-default',
          content: '"keep"',
          tokensIn: 4,
          tokensOut: 2,
          raw: null,
        };
      },
    };
    __resetEntityRegistryForTests();
    const stepTodoCompanyModule = createCompanyModule({ connectors: [], enrichmentJobs: [] });
    const stepTodoContactModule = createContactModule({ enrichmentJobs: [] });
    const stepTodoModule = createTodoModule({ enrichmentJobs: todoEnrichmentJobs });
    registerEntityModule(stepTodoCompanyModule);
    registerEntityModule(stepTodoContactModule);
    registerEntityModule(stepTodoModule);

    const todoStore = createEntityStore<TodoPayload>({
      module: stepTodoModule,
      db: database,
      bus,
      llm: todosFakeLlm,
    });
    const companyStoreForTodos = createEntityStore<CompanyPayload>({
      module: stepTodoCompanyModule,
      db: database,
      bus,
      llm: todosFakeLlm,
    });
    const contactStoreForTodos = createEntityStore<ContactPayload>({
      module: stepTodoContactModule,
      db: database,
      bus,
      llm: todosFakeLlm,
    });
    const todosEnrichmentRunner = createEnrichmentRunner({
      db: database,
      bus,
      llm: todosFakeLlm,
      pricing: loaded.config.llm.pricing,
      resolveStore: (mod) => {
        if (mod.kind === 'todo') return todoStore as EntityStore<unknown>;
        if (mod.kind === 'company') return companyStoreForTodos as EntityStore<unknown>;
        if (mod.kind === 'contact') return contactStoreForTodos as EntityStore<unknown>;
        return null;
      },
    });

    // 15b. Start the projection bridge against the same DB + bus. The
    //      smoke's `createApp(...)` call mounts the HTTP read endpoint
    //      (`mountTodoCalendarProjectionRoutes`) but does NOT start the
    //      bridge subscriber — production wires it in `index.ts`. Start
    //      it here so the subscriber is attached for the lifetime of
    //      this step; `stop()` in the finally block removes the
    //      subscriber before later test files run. `rebuild()` would
    //      pick up any stray dueAt-bearing todos from earlier steps;
    //      none exist, but we run it to mirror the production boot path.
    const todoProjection = createTodoCalendarProjection({ db: database, bus });
    todoProjection.start();
    todoProjection.rebuild();

    todosEnrichmentRunner.start();
    try {
      // 15c. Use fresh slugs so this step does NOT depend on the rows
      //      step 12/13/14 left behind. Per-(layer,kind) slug uniqueness
      //      lets the seeded rows coexist with new ones.
      const todoCompanyCreate = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/company`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'AMI BV',
            slug: 'ami-todo-target',
            originalLocale: 'en',
            payload: { email: 'cs@ami.nl' },
          }),
        }),
      );
      expect(todoCompanyCreate.status).toBe(201);

      const aliceForTodosCreate = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/contact`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'Alice',
            slug: 'alice-todo-target',
            originalLocale: 'en',
            payload: {
              givenName: 'Alice',
              emails: [{ value: 'alice@ami.nl', isPrimary: true }],
            },
          }),
        }),
      );
      expect(aliceForTodosCreate.status).toBe(201);
      const aliceForTodosBody = (await aliceForTodosCreate.json()) as {
        entity: { id: string };
      };
      const aliceTodosId = aliceForTodosBody.entity.id;

      // 15.1 POST /l/:slug/todo — create "Buy office supplies" with
      //      open / priority 3 / dueAt = tomorrow. Version=1.
      const today = new Date();
      const tomorrowDate = new Date(today);
      tomorrowDate.setUTCDate(tomorrowDate.getUTCDate() + 1);
      const tomorrowIso = tomorrowDate.toISOString().slice(0, 10);

      const officeCreate = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'Buy office supplies',
            slug: 'buy-office-supplies',
            originalLocale: 'en',
            payload: {
              status: 'open',
              priority: 3,
              dueAt: tomorrowIso,
            },
          }),
        }),
      );
      expect(officeCreate.status).toBe(201);
      const officeBody = (await officeCreate.json()) as {
        entity: { id: string; slug: string; meta: { version: number; originalLocale: string } };
      };
      expect(officeBody.entity.slug).toBe('buy-office-supplies');
      expect(officeBody.entity.meta.version).toBe(1);
      expect(officeBody.entity.meta.originalLocale).toBe('en');

      // 15.2 GET detail — assert original locale, deletedAt null.
      const officeGet = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo/buy-office-supplies`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(officeGet.status).toBe(200);
      const officeGetBody = (await officeGet.json()) as {
        entity: {
          meta: { version: number; originalLocale: string; deletedAt: string | null };
          payload: TodoPayload;
        };
      };
      expect(officeGetBody.entity.meta.originalLocale).toBe('en');
      expect(officeGetBody.entity.meta.deletedAt).toBeNull();
      expect(officeGetBody.entity.payload.dueAt).toBe(tomorrowIso);

      // 15.3 PATCH — bump priority to 1. Version advances to 2.
      const officePatch = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo/buy-office-supplies`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            payload: { priority: 1 },
          }),
        }),
      );
      expect(officePatch.status).toBe(200);
      const officePatchBody = (await officePatch.json()) as {
        entity: { meta: { version: number }; payload: TodoPayload };
      };
      expect(officePatchBody.entity.meta.version).toBe(2);
      expect(officePatchBody.entity.payload.priority).toBe(1);
      // The PATCH-merge contract preserves `dueAt` that was not in the
      // request body.
      expect(officePatchBody.entity.payload.dueAt).toBe(tomorrowIso);

      // 15.4 Cross-kind link via PATCH — link to Alice (the contact
      //      seeded above). Validator inside `mountTodoRoutes`
      //      confirms the target exists in this layer and the row's
      //      `linked_entity_id` column is updated.
      const officeLinkPatch = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo/buy-office-supplies`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            payload: {
              linkedEntityRef: { kind: 'contact', entityId: aliceTodosId },
            },
          }),
        }),
      );
      expect(officeLinkPatch.status).toBe(200);
      const officeLinkBody = (await officeLinkPatch.json()) as {
        entity: { payload: TodoPayload };
      };
      expect(officeLinkBody.entity.payload.linkedEntityRef?.kind).toBe('contact');
      expect(officeLinkBody.entity.payload.linkedEntityRef?.entityId).toBe(aliceTodosId);
      // Confirm the sparse-indexed column is populated alongside the
      // payload — the §4.0 `indexedColumns` projection.
      const officeLinkRow = database
        .query<
          { linked_entity_id: string | null; linked_entity_kind: string | null },
          [string]
        >(`SELECT linked_entity_id, linked_entity_kind FROM todos WHERE slug = ?`)
        .get('buy-office-supplies');
      expect(officeLinkRow?.linked_entity_id).toBe(aliceTodosId);
      expect(officeLinkRow?.linked_entity_kind).toBe('contact');

      // 15.5 Cross-kind link rejection — PATCH with a random UUID
      //      that does not resolve to any contact in the layer.
      const bogusContactId = crypto.randomUUID();
      const officeBadLink = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo/buy-office-supplies`, {
          method: 'PATCH',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            payload: {
              linkedEntityRef: { kind: 'contact', entityId: bogusContactId },
            },
          }),
        }),
      );
      expect(officeBadLink.status).toBe(400);
      const officeBadLinkBody = (await officeBadLink.json()) as { error: string };
      expect(officeBadLinkBody.error).toBe('errors.entity.todos.linkedEntityNotFound');

      // 15.6 AI auto-priority via deterministic keyword scan. "URGENT"
      //      maps to priority 1 via the lowercase word scan (see
      //      `apps/server/src/entities/todos/enrichment.ts`
      //      PRIORITY_1_WORDS). The fake LLM is NOT consulted: the
      //      keyword match short-circuits the job before the LLM
      //      fallback runs.
      const llmCallsBeforeAutoPrio = todosLlmCalls.length;
      const urgentCreate = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'URGENT: ship CI pipeline',
            slug: 'urgent-ship-ci',
            originalLocale: 'en',
            payload: {},
          }),
        }),
      );
      expect(urgentCreate.status).toBe(201);
      const urgentBody = (await urgentCreate.json()) as {
        entity: { id: string; payload: TodoPayload };
      };
      const urgentTodoId = urgentBody.entity.id;
      expect(urgentBody.entity.payload.priority).toBe(3); // default before runner.

      // Subscribe to the enrichment-succeeded event before the runner
      // fires so we can assert the patch was applied via the runner
      // (NOT a direct write).
      const enrichmentEvents: BusEvent[] = [];
      const unsubEnrichmentSucceeded = bus.subscribe('entity.enrichment.succeeded', (ev) => {
        enrichmentEvents.push(ev);
      });

      await todosEnrichmentRunner.tickOnce();

      const urgentAfter = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo/urgent-ship-ci`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const urgentAfterBody = (await urgentAfter.json()) as {
        entity: { payload: TodoPayload };
      };
      expect(urgentAfterBody.entity.payload.priority).toBe(1);

      // The enrichment-succeeded event for `todos.autoPriority` fired
      // for the urgent todo with a non-empty patch. There is no LLM
      // call carrying the `enrichment:todos.autoPriority` flowId
      // because the deterministic keyword scan short-circuited the
      // job before the LLM fallback.
      const autoPriorityEvents = enrichmentEvents.filter((ev) => {
        const p = ev.payload as { jobId?: string; entityId?: string; hasPatch?: boolean };
        return (
          p.jobId === 'todos.autoPriority' && p.entityId === urgentTodoId && p.hasPatch === true
        );
      });
      expect(autoPriorityEvents.length).toBeGreaterThanOrEqual(1);
      const autoPriorityLlmCalls = todosLlmCalls
        .slice(llmCallsBeforeAutoPrio)
        .filter((c) => c.flowId === 'enrichment:todos.autoPriority');
      expect(autoPriorityLlmCalls.length).toBe(0);

      // 15.7 AI auto-due via deterministic Dutch "morgen" phrase. The
      //      autoDue job has no LLM fallback — a title without any
      //      recognised date phrase yields no patch. "morgen" maps to
      //      tomorrow (`addDays(now, 1)` formatted as YYYY-MM-DD —
      //      see `parseDueAtFromTitle` in
      //      `apps/server/src/entities/todos/enrichment.ts`).
      const llmCallsBeforeAutoDue = todosLlmCalls.length;
      const morgenCreate = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${adminToken2}`,
          },
          body: JSON.stringify({
            title: 'Bel terug morgen',
            slug: 'bel-terug-morgen',
            originalLocale: 'nl',
            payload: {},
          }),
        }),
      );
      expect(morgenCreate.status).toBe(201);
      const morgenBody = (await morgenCreate.json()) as {
        entity: { id: string; payload: TodoPayload };
      };
      const morgenTodoId = morgenBody.entity.id;
      expect(morgenBody.entity.payload.dueAt).toBeUndefined();

      await todosEnrichmentRunner.tickOnce();

      const morgenAfter = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo/bel-terug-morgen`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const morgenAfterBody = (await morgenAfter.json()) as {
        entity: { payload: TodoPayload };
      };
      // Tomorrow's UTC date computed from the same `now` semantics the
      // runner uses (production reads `new Date()` inside the job; the
      // tests do not pin the clock for this step). One millisecond of
      // drift between `tomorrowIso` and the runner's `now` is fine —
      // the assertion is "same calendar day", not "same instant".
      expect(morgenAfterBody.entity.payload.dueAt).toBe(tomorrowIso);

      // No LLM call carried the autoDue flowId (the job has no LLM
      // fallback per the 4d.3 close-out).
      const autoDueLlmCalls = todosLlmCalls
        .slice(llmCallsBeforeAutoDue)
        .filter((c) => c.flowId === 'enrichment:todos.autoDue');
      expect(autoDueLlmCalls.length).toBe(0);
      const autoDueEvents = enrichmentEvents.filter((ev) => {
        const p = ev.payload as { jobId?: string; entityId?: string; hasPatch?: boolean };
        return p.jobId === 'todos.autoDue' && p.entityId === morgenTodoId && p.hasPatch === true;
      });
      expect(autoDueEvents.length).toBeGreaterThanOrEqual(1);

      // 15.8 Projection bridge — the auto-due tick emitted
      //      `entity.todo.updated`; the bridge subscribed at step 15b
      //      re-read the todo and upserted a projection row. The
      //      `/calendar/_projections/todos` endpoint should now return
      //      exactly one row for the "Bel terug morgen" todo whose
      //      `dueAt` matches the runner-written date.
      const projectionList = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar/_projections/todos`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(projectionList.status).toBe(200);
      const projectionListBody = (await projectionList.json()) as {
        items: ReadonlyArray<{
          todoId: string;
          dueAt: string;
          priority: number;
          status: string;
          todoSlug: string;
        }>;
      };
      // Two projected todos exist: "buy-office-supplies" (the user
      // PATCHed it to priority 1 with dueAt=tomorrow) AND
      // "bel-terug-morgen" (the auto-due runner just stamped its
      // dueAt to tomorrow). The "URGENT" todo has NO dueAt and is
      // therefore not projected.
      const morgenProjection = projectionListBody.items.find((it) => it.todoId === morgenTodoId);
      expect(morgenProjection).toBeDefined();
      expect(morgenProjection?.dueAt).toBe(tomorrowIso);
      expect(morgenProjection?.priority).toBe(2); // "morgen" hits PRIORITY_2_WORDS too.
      expect(morgenProjection?.status).toBe('open');
      expect(morgenProjection?.todoSlug).toBe('bel-terug-morgen');
      const officeProjection = projectionListBody.items.find(
        (it) => it.todoSlug === 'buy-office-supplies',
      );
      expect(officeProjection).toBeDefined();
      expect(projectionListBody.items.some((it) => it.todoSlug === 'urgent-ship-ci')).toBe(false);

      // 15.9 Stats — `_stats` returns the four counters
      //      independently. After steps 15.1–15.8:
      //        - "buy-office-supplies" — open, priority 1, dueAt
      //          tomorrow → totalOpen+1, highPriorityOpen+1.
      //        - "urgent-ship-ci" — open, priority 1 → totalOpen+1,
      //          highPriorityOpen+1. No dueAt.
      //        - "bel-terug-morgen" — open, priority 2 (autoPriority
      //          rewrote it on the same tick), dueAt tomorrow →
      //          totalOpen+1, highPriorityOpen+1.
      const todoStatsRes = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo/_stats`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(todoStatsRes.status).toBe(200);
      const todoStatsBody = (await todoStatsRes.json()) as {
        stats: {
          totalOpen: number;
          dueToday: number;
          overdue: number;
          highPriorityOpen: number;
        };
      };
      expect(todoStatsBody.stats.totalOpen).toBe(3);
      expect(todoStatsBody.stats.overdue).toBe(0);
      expect(todoStatsBody.stats.dueToday).toBe(0);
      expect(todoStatsBody.stats.highPriorityOpen).toBe(3);

      // 15.10 Projection clears on soft-delete. PATCH-clear via
      //       `dueAt: null` is NOT supported via HTTP: the zod
      //       schema declares `dueAt` as `.optional()` (not nullable)
      //       so a PATCH carrying `dueAt: null` fails parse with 400
      //       at the router boundary. The soft-delete path is the
      //       only HTTP-driven removal route. See the 4d.7 close-out
      //       in `docs/dev/plans/done/phase-04-first-entities.md` §14.
      const morgenDelete = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo/bel-terug-morgen`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(morgenDelete.status).toBe(200);
      const projectionAfterDelete = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/calendar/_projections/todos`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(projectionAfterDelete.status).toBe(200);
      const projectionAfterDeleteBody = (await projectionAfterDelete.json()) as {
        items: ReadonlyArray<{ todoId: string }>;
      };
      expect(projectionAfterDeleteBody.items.some((it) => it.todoId === morgenTodoId)).toBe(false);

      // The soft-deleted todo is omitted from the list endpoint.
      const todoListAfterDelete = await app.fetch(
        new Request(`http://localhost/l/${personalSlug}/todo`, {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      const todoListAfterDeleteBody = (await todoListAfterDelete.json()) as {
        entities: ReadonlyArray<{ slug: string }>;
      };
      expect(todoListAfterDeleteBody.entities.some((e) => e.slug === 'bel-terug-morgen')).toBe(
        false,
      );

      // 15.11 Cross-layer isolation — the `contact-isolation` project
      //       layer created in step 13.8 stays empty of todos, todo
      //       projections, and reports zero counters via `_stats`.
      const isolationTodoList = await app.fetch(
        new Request('http://localhost/l/contact-isolation/todo', {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(isolationTodoList.status).toBe(200);
      const isolationTodoListBody = (await isolationTodoList.json()) as {
        entities: ReadonlyArray<unknown>;
      };
      expect(isolationTodoListBody.entities.length).toBe(0);

      const isolationProjection = await app.fetch(
        new Request('http://localhost/l/contact-isolation/calendar/_projections/todos', {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(isolationProjection.status).toBe(200);
      const isolationProjectionBody = (await isolationProjection.json()) as {
        items: ReadonlyArray<unknown>;
      };
      expect(isolationProjectionBody.items.length).toBe(0);

      const isolationTodoStats = await app.fetch(
        new Request('http://localhost/l/contact-isolation/todo/_stats', {
          headers: { authorization: `Bearer ${adminToken2}` },
        }),
      );
      expect(isolationTodoStats.status).toBe(200);
      const isolationTodoStatsBody = (await isolationTodoStats.json()) as {
        stats: {
          totalOpen: number;
          dueToday: number;
          overdue: number;
          highPriorityOpen: number;
        };
      };
      expect(isolationTodoStatsBody.stats).toEqual({
        totalOpen: 0,
        dueToday: 0,
        overdue: 0,
        highPriorityOpen: 0,
      });

      // 15.12 Secret-strip canary mirrors the prior steps. No connector
      //       attachment was created for todos (the v1 module declares
      //       NO connectors), so there is no apiKey on a
      //       `layer_attachments.config` row to leak — but the canary
      //       still asserts no obviously-suspect literal appeared in
      //       any captured LLM prompt or any enrichment-succeeded
      //       event payload during this step. Together with the prior
      //       three steps' canaries this completes the per-entity
      //       coverage promised in `architecture/event-bus.md`.
      const todosEventHaystack = JSON.stringify(
        enrichmentEvents.map((e) => ({ type: e.type, payload: e.payload })),
      );
      expect(todosEventHaystack).not.toContain('apiKey');
      expect(todosEventHaystack).not.toContain('refreshToken');
      for (const c of todosLlmCalls) {
        expect(c.messages).not.toContain('apiKey');
        expect(c.messages).not.toContain('refreshToken');
      }

      unsubEnrichmentSucceeded();
    } finally {
      todosEnrichmentRunner.stop();
      todoProjection.stop();
      __resetEntityRegistryForTests();
    }
  });
});
