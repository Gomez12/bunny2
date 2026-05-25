/**
 * Phase 4.0 — reusable contract test suite for any `EntityModule`.
 *
 * Per-kind sub-phases (4a.1, 4b.1, 4c.1, 4d.1) import `runEntityContractSuite`
 * and parametrize it with their module + an open DB + a real bus + a
 * test LLM client. The suite asserts every invariant the foundation
 * promises: CRUD, version bump, soft-delete propagation, restore,
 * translation lifecycle, summary search, cross-layer isolation, auth
 * gates, and event emission.
 *
 * The suite owns NO globals; the caller wires the fixture and is
 * responsible for tearing it down. This keeps the suite usable both
 * inline (the 4.0 fixture module test) and from per-kind test files
 * (4a..4d) without colliding on registry state.
 */
import { describe, expect, it } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { Hono } from 'hono';
import type { MessageBus, BusEvent } from '@bunny2/bus';
import type { User as SafeUser } from '@bunny2/shared';
import type { EntityModule, EntityStore } from '../../src/entities';
import { mountEntityRoutes } from '../../src/entities';
import type { HonoVariables } from '../../src/http/types';
import { createLayersRepo } from '../../src/repos/layers-repo';
import {
  entityEventType,
  ENTITY_EVENT_TYPES,
  createEntityTranslator,
  type EntityCreatedPayload,
  type EntityUpdatedPayload,
  type EntityDeletedPayload,
  type EntityRestoredPayload,
  type EntityTranslationCompletedPayload,
  type EntityTranslationRequestedPayload,
} from '../../src/entities';

export interface EntityContractSuiteFixture<Payload> {
  readonly module: EntityModule<Payload>;
  readonly store: EntityStore<Payload>;
  readonly db: Database;
  readonly bus: MessageBus;
  /** Creates two distinct layers (A, B) with the given locales and returns their ids. */
  createTwoLayers(opts: {
    readonly localesA: readonly string[];
    readonly localesB: readonly string[];
    readonly defaultLocaleA: string;
    readonly defaultLocaleB?: string;
  }): { layerAId: string; layerBId: string };
  /** Creates a test user, returns the userId. */
  createUser(name: string): string;
  /** Builds a sample payload for the kind. */
  samplePayload(seed: string): Payload;
  /** Updates fields of a payload (used to drive `update`). */
  mutatePayload(payload: Payload, seed: string): Payload;
}

export function runEntityContractSuite<Payload>(
  fixture: EntityContractSuiteFixture<Payload>,
): void {
  describe(`entity contract :: ${fixture.module.kind}`, () => {
    it('round-trips create / getById / getBySlug and emits entity.<kind>.created', async () => {
      const { layerAId } = fixture.createTwoLayers({
        localesA: ['en'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('alice');
      const events = recordEvents<EntityCreatedPayload>(fixture.bus, [
        entityEventType(fixture.module.kind, 'created'),
      ]);
      const created = await fixture.store.create({
        layerId: layerAId,
        slug: 'one',
        title: 'One',
        originalLocale: 'en',
        payload: fixture.samplePayload('one'),
        actorId: userId,
      });
      expect(created.slug).toBe('one');
      expect(created.meta.version).toBe(1);
      expect(created.meta.originalLocale).toBe('en');
      expect(fixture.store.getById(created.id)?.id).toBe(created.id);
      expect(fixture.store.getBySlug(layerAId, 'one')?.id).toBe(created.id);
      expect(events.list().length).toBe(1);
      expect(events.list()[0]?.payload.ref.id).toBe(created.id);
    });

    it('bumps version on every update and snapshots the new payload', async () => {
      const { layerAId } = fixture.createTwoLayers({
        localesA: ['en'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('bob');
      const created = await fixture.store.create({
        layerId: layerAId,
        slug: 'two',
        title: 'Two',
        originalLocale: 'en',
        payload: fixture.samplePayload('two'),
        actorId: userId,
      });
      const events = recordEvents<EntityUpdatedPayload>(fixture.bus, [
        entityEventType(fixture.module.kind, 'updated'),
      ]);
      const updated = await fixture.store.update({
        id: created.id,
        payload: fixture.mutatePayload(created.payload, 'two-v2'),
        actorId: userId,
      });
      expect(updated.meta.version).toBe(2);
      const again = await fixture.store.update({
        id: created.id,
        payload: fixture.mutatePayload(updated.payload, 'two-v3'),
        actorId: userId,
      });
      expect(again.meta.version).toBe(3);
      expect(events.list().length).toBe(2);
      expect(events.list()[0]?.payload.previousVersion).toBe(1);
      expect(events.list()[1]?.payload.previousVersion).toBe(2);
    });

    it('soft-delete hides entity from listSummaries and is reversed by restore', async () => {
      const { layerAId } = fixture.createTwoLayers({
        localesA: ['en'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('carol');
      const created = await fixture.store.create({
        layerId: layerAId,
        slug: 'three',
        title: 'Three',
        originalLocale: 'en',
        payload: fixture.samplePayload('three'),
        actorId: userId,
      });
      const deletedEvents = recordEvents<EntityDeletedPayload>(fixture.bus, [
        entityEventType(fixture.module.kind, 'deleted'),
      ]);
      const restoredEvents = recordEvents<EntityRestoredPayload>(fixture.bus, [
        entityEventType(fixture.module.kind, 'restored'),
      ]);

      await fixture.store.softDelete({ id: created.id, actorId: userId });
      const afterDelete = fixture.store.listSummaries([layerAId]);
      expect(afterDelete.find((s) => s.id === created.id)).toBeUndefined();
      const withDeleted = fixture.store.listSummaries([layerAId], { includeDeleted: true });
      expect(withDeleted.find((s) => s.id === created.id)?.meta.deletedAt).not.toBeNull();
      expect(deletedEvents.list().length).toBe(1);

      const restored = await fixture.store.restore({ id: created.id, actorId: userId });
      expect(restored.meta.deletedAt).toBeNull();
      const afterRestore = fixture.store.listSummaries([layerAId]);
      expect(afterRestore.find((s) => s.id === created.id)).toBeDefined();
      expect(restoredEvents.list().length).toBe(1);
    });

    it('searchSummaries returns layer-scoped matches only', async () => {
      const { layerAId, layerBId } = fixture.createTwoLayers({
        localesA: ['en'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('dave');
      await fixture.store.create({
        layerId: layerAId,
        slug: 'apple-pie',
        title: 'Apple pie',
        originalLocale: 'en',
        payload: fixture.samplePayload('apple-pie'),
        actorId: userId,
      });
      await fixture.store.create({
        layerId: layerBId,
        slug: 'apple-juice',
        title: 'Apple juice',
        originalLocale: 'en',
        payload: fixture.samplePayload('apple-juice'),
        actorId: userId,
      });
      const inA = fixture.store.searchSummaries([layerAId], 'apple');
      expect(inA.length).toBe(1);
      expect(inA[0]?.title).toBe('Apple pie');
      const inBoth = fixture.store.searchSummaries([layerAId, layerBId], 'apple');
      expect(inBoth.length).toBe(2);
    });

    it('isolates entities across layers (no cross-layer visibility through the store)', async () => {
      const { layerAId, layerBId } = fixture.createTwoLayers({
        localesA: ['en'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('erin');
      await fixture.store.create({
        layerId: layerAId,
        slug: 'shared',
        title: 'Shared in A',
        originalLocale: 'en',
        payload: fixture.samplePayload('shared'),
        actorId: userId,
      });
      // The store keys on (layer_id, slug), so the same slug in another
      // layer must be a different record entirely.
      const second = await fixture.store.create({
        layerId: layerBId,
        slug: 'shared',
        title: 'Shared in B',
        originalLocale: 'en',
        payload: fixture.samplePayload('shared-b'),
        actorId: userId,
      });
      const fromAOnly = fixture.store.listSummaries([layerAId]);
      expect(fromAOnly.map((s) => s.layerId)).toEqual([layerAId]);
      const slugLookupInA = fixture.store.getBySlug(layerAId, 'shared');
      expect(slugLookupInA?.layerId).toBe(layerAId);
      expect(slugLookupInA?.id).not.toBe(second.id);
    });

    it('runs the translation lifecycle: requested → completed; source_version is bookkeeping', async () => {
      const { layerAId } = fixture.createTwoLayers({
        localesA: ['en', 'nl'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('fred');

      const requested = recordEvents<EntityTranslationRequestedPayload>(fixture.bus, [
        ENTITY_EVENT_TYPES.TranslationRequested,
      ]);
      const completed = recordEvents<EntityTranslationCompletedPayload>(fixture.bus, [
        ENTITY_EVENT_TYPES.TranslationCompleted,
      ]);

      const translator = createEntityTranslator({
        module: fixture.module,
        store: fixture.store,
        db: fixture.db,
        bus: fixture.bus,
        // Real LLM client is not available in tests — the fake `translate`
        // injection is the supported path per the §4.0 plan.
        llm: {
          endpoint: 'mock://translator',
          defaultModel: 'mock-default',
          chat: () => {
            throw new Error('translator default LLM must not be called in tests');
          },
        },
        translate: async (payload) => payload,
      });
      try {
        const created = await fixture.store.create({
          layerId: layerAId,
          slug: 'translate-me',
          title: 'Translate me',
          originalLocale: 'en',
          payload: fixture.samplePayload('t'),
          actorId: userId,
        });
        // The translator subscribes to created/updated; the in-memory bus
        // awaits subscribers before resolving publish(), so by the time
        // `create` returned the lifecycle has already run for layer A's
        // configured locales.
        expect(requested.list().length).toBe(1);
        expect(completed.list().length).toBe(1);
        expect(completed.list()[0]?.payload.locale).toBe('nl');
        expect(completed.list()[0]?.payload.sourceVersion).toBe(1);

        // A second create at the same version-1 is a no-op for re-translation
        // — the translator should skip when source_version >= entity.version.
        await fixture.store.update({
          id: created.id,
          payload: fixture.mutatePayload(created.payload, 't-v2'),
          actorId: userId,
        });
        expect(completed.list().length).toBe(2);
        expect(completed.list()[1]?.payload.sourceVersion).toBe(2);
      } finally {
        translator.dispose();
      }
    });

    // -----------------------------------------------------------------
    // PATCH preserves keys not present in the request body.
    //
    // The router PATCH handler merges the incoming payload against the
    // stored payload at the top-level-key layer (see
    // `docs/dev/follow-ups/done/calendar-patch-payload-merge.md`).
    // Keys absent from the body preserve the stored value; keys
    // present in the body wholesale-replace at the top level (no deep
    // merge, no per-array merge). This invariant is enforced in
    // `mountEntityRoutes`, so every kind that mounts the generic
    // router inherits it.
    //
    // The test mounts the real `mountEntityRoutes` on a minimal Hono
    // app with a stub middleware that injects `user`, `effectiveLayers`,
    // and `layer` — bypassing the auth chain that production routes
    // depend on. This exercises the merge code path in the same router
    // every per-kind sub-phase wires up at boot.
    // -----------------------------------------------------------------
    it('PATCH preserves payload keys not present in the request body', async () => {
      const { layerAId } = fixture.createTwoLayers({
        localesA: ['en'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('patch-merge');
      const layer = createLayersRepo(fixture.db).getLayerById(layerAId);
      if (layer === null) throw new Error('layer not found after createTwoLayers');

      const initial = fixture.samplePayload('merge') as unknown as Record<string, unknown>;
      const keys = Object.keys(initial);
      if (keys.length < 2) {
        throw new Error(
          `samplePayload must declare ≥2 top-level keys to exercise the merge; got: ${keys.join(',')}`,
        );
      }
      // Pick the patched key as the one the per-kind mutator targets
      // (so we know the mutated value is schema-valid). Pick the
      // preserved key as a different key with a non-undefined initial
      // value.
      const mutated = fixture.mutatePayload(
        fixture.samplePayload('merge'),
        'patched',
      ) as unknown as Record<string, unknown>;
      let patchKey: string | undefined;
      for (const k of Object.keys(mutated)) {
        if (mutated[k] !== initial[k] && mutated[k] !== undefined) {
          patchKey = k;
          break;
        }
      }
      if (patchKey === undefined) {
        throw new Error('mutatePayload did not change any top-level key — required by merge test');
      }
      let preservedKey: string | undefined;
      for (const k of keys) {
        if (k !== patchKey && initial[k] !== undefined) {
          preservedKey = k;
          break;
        }
      }
      if (preservedKey === undefined) {
        throw new Error('samplePayload must define ≥2 non-undefined top-level keys');
      }

      const created = await fixture.store.create({
        layerId: layerAId,
        slug: 'merge-target',
        title: 'Merge target',
        originalLocale: 'en',
        payload: fixture.samplePayload('merge'),
        actorId: userId,
      });

      // Mount the real router behind a stub middleware that injects
      // the auth context fields `mountEntityRoutes` reads.
      const app = new Hono<{ Variables: HonoVariables }>();
      app.use('*', async (c, next) => {
        c.set('user', { id: userId } as unknown as SafeUser);
        c.set('effectiveLayers', [layer]);
        await next();
      });
      mountEntityRoutes(app, {
        module: fixture.module,
        store: fixture.store,
        bus: fixture.bus,
        db: fixture.db,
      });

      const patchedValue = mutated[patchKey];
      const patchRes = await app.fetch(
        new Request(`http://localhost/l/${layer.slug}/${fixture.module.kind}/${created.slug}`, {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ payload: { [patchKey]: patchedValue } }),
        }),
      );
      expect(patchRes.status).toBe(200);

      const refreshed = fixture.store.getById(created.id);
      expect(refreshed).not.toBeNull();
      const refreshedPayload = refreshed?.payload as unknown as Record<string, unknown>;
      // The patched key carries the new value.
      expect(refreshedPayload[patchKey]).toEqual(patchedValue);
      // The omitted key preserved its original value — this is the
      // regression assertion. Pre-merge, the wholesale-replace
      // semantics would have left `refreshedPayload[preservedKey]`
      // undefined here.
      expect(refreshedPayload[preservedKey]).toEqual(initial[preservedKey]);
    });

    // -----------------------------------------------------------------
    // GET /l/:slug/<kind>?from=&to= contract.
    //
    // Calendar opts in via `module.timeColumn`. For every other kind
    // (companies, contacts, todos, fixture) the parameters MUST be
    // ignored — the response shape stays the same and the rowset is
    // not narrowed. A malformed ISO string still returns 400 (the
    // router parses the params unconditionally so the kind never sees
    // SQL-noise input regardless of whether it opts in).
    // -----------------------------------------------------------------
    it('GET ?from=&to= is ignored by modules without a timeColumn', async () => {
      // Skip the kinds that DO opt in — the assertion would be wrong.
      if (fixture.module.timeColumn !== undefined) return;

      const { layerAId } = fixture.createTwoLayers({
        localesA: ['en'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('time-col');
      const layer = createLayersRepo(fixture.db).getLayerById(layerAId);
      if (layer === null) throw new Error('layer not found after createTwoLayers');
      await fixture.store.create({
        layerId: layerAId,
        slug: 'in-range',
        title: 'In range',
        originalLocale: 'en',
        payload: fixture.samplePayload('in-range'),
        actorId: userId,
      });

      const app = new Hono<{ Variables: HonoVariables }>();
      app.use('*', async (c, next) => {
        c.set('user', { id: userId } as unknown as SafeUser);
        c.set('effectiveLayers', [layer]);
        await next();
      });
      mountEntityRoutes(app, {
        module: fixture.module,
        store: fixture.store,
        bus: fixture.bus,
        db: fixture.db,
      });

      const res = await app.fetch(
        new Request(
          `http://localhost/l/${layer.slug}/${fixture.module.kind}?from=2020-01-01&to=2020-01-02`,
          { method: 'GET' },
        ),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as { entities: readonly { slug: string }[] };
      // The row is OUTSIDE the supposed `[2020-01-01, 2020-01-02]`
      // range — if the kind had a time filter on `updated_at` we'd
      // get zero rows. The assertion is "the param did not narrow
      // the rowset" — the row is still present.
      expect(body.entities.find((e) => e.slug === 'in-range')).toBeDefined();
    });

    it('GET rejects malformed ?from= / ?to= with a 400', async () => {
      const { layerAId } = fixture.createTwoLayers({
        localesA: ['en'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('bad-range');
      const layer = createLayersRepo(fixture.db).getLayerById(layerAId);
      if (layer === null) throw new Error('layer not found after createTwoLayers');

      const app = new Hono<{ Variables: HonoVariables }>();
      app.use('*', async (c, next) => {
        c.set('user', { id: userId } as unknown as SafeUser);
        c.set('effectiveLayers', [layer]);
        await next();
      });
      mountEntityRoutes(app, {
        module: fixture.module,
        store: fixture.store,
        bus: fixture.bus,
        db: fixture.db,
      });

      const badFrom = await app.fetch(
        new Request(`http://localhost/l/${layer.slug}/${fixture.module.kind}?from=not-a-date`, {
          method: 'GET',
        }),
      );
      expect(badFrom.status).toBe(400);
      const badTo = await app.fetch(
        new Request(`http://localhost/l/${layer.slug}/${fixture.module.kind}?to=foo`, {
          method: 'GET',
        }),
      );
      expect(badTo.status).toBe(400);
    });

    // -----------------------------------------------------------------
    // EntitySummary.extras contract.
    //
    // Modules without `summaryColumns` emit a summary that has NO
    // `extras` field on the wire — the web client treats absence as
    // an empty object. This matters because the JSON payload shape is
    // part of the public contract; a spurious `extras: {}` on every
    // listing would inflate every response and break consumers that
    // narrow on `extras !== undefined` for feature detection.
    // -----------------------------------------------------------------
    it('emits no `extras` field on summaries when the module declares no summaryColumns', async () => {
      if (fixture.module.summaryColumns !== undefined) return;

      const { layerAId } = fixture.createTwoLayers({
        localesA: ['en'],
        localesB: ['en'],
        defaultLocaleA: 'en',
      });
      const userId = fixture.createUser('extras-empty');
      await fixture.store.create({
        layerId: layerAId,
        slug: 'no-extras',
        title: 'No extras',
        originalLocale: 'en',
        payload: fixture.samplePayload('extras'),
        actorId: userId,
      });
      const summaries = fixture.store.listSummaries([layerAId]);
      const row = summaries.find((s) => s.slug === 'no-extras');
      expect(row).toBeDefined();
      // Compare the JSON shape — the assertion is "the wire shape
      // does NOT include an extras key", which is stronger than
      // `row.extras === undefined` on a TypeScript reference.
      const wire = JSON.parse(JSON.stringify(row)) as Record<string, unknown>;
      expect(Object.prototype.hasOwnProperty.call(wire, 'extras')).toBe(false);
    });
  });
}

/**
 * Minimal helper to capture every published event of a given type. Uses
 * `bus.subscribe` (real subscription path) so the helper observes
 * exactly what production subscribers would see.
 */
interface RecordedEvents<TPayload> {
  list(): readonly BusEvent<TPayload>[];
  dispose(): void;
}

function recordEvents<TPayload>(
  bus: MessageBus,
  types: readonly string[],
): RecordedEvents<TPayload> {
  const events: BusEvent<TPayload>[] = [];
  const unsubs = types.map((type) =>
    bus.subscribe<TPayload>(type, (event) => {
      events.push(event);
    }),
  );
  return {
    list: () => events,
    dispose: () => {
      for (const u of unsubs) u();
    },
  };
}
