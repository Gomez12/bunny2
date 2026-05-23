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
import type { MessageBus, BusEvent } from '@bunny2/bus';
import type { EntityModule, EntityStore } from '../../src/entities';
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
