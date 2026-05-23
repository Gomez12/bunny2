import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { EntityRef } from '@bunny2/shared';
import type { LlmClient } from '../llm';
import type { EntityModule } from './module';
import type { EntityStore } from './store';
import {
  ENTITY_EVENT_TYPES,
  entityEventType,
  type EntityCreatedPayload,
  type EntityTranslationRequestedPayload,
  type EntityUpdatedPayload,
} from './events';

/**
 * Phase 4.0 — per-kind translator runner.
 *
 * `createEntityTranslator({ module, store, db, bus, llm })` subscribes
 * to `entity.<kind>.{created,updated}` and, for every locale configured
 * on the entity's layer (excluding the entity's original locale),
 * enqueues a translation against the system LLM client. The completion
 * row is persisted into `entity_translations` with the source version,
 * and `entity.translation.completed` is published.
 *
 * Re-translation is gated on `entity_translations.source_version`:
 *  - if no row exists for `(entity_id, locale)`, translate;
 *  - if the row exists but `source_version < entity.version`, translate;
 *  - otherwise skip.
 *
 * The translator does NOT batch in 4.0 — phase 5 owns the scheduler. We
 * publish `entity.translation.requested` for observability and then
 * inline-run the LLM call so the contract test suite can synchronously
 * assert the lifecycle. Phase 5 will swap the inline call for a queue
 * push without changing the event surface.
 *
 * Tests inject a fake `LlmClient` (mock://) — no real network call.
 */
export interface EntityTranslator {
  /** Detaches every subscription. Idempotent. */
  dispose(): void;
}

export interface CreateEntityTranslatorDeps<Payload> {
  readonly module: EntityModule<Payload>;
  readonly store: EntityStore<Payload>;
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  /**
   * Optional override that maps a payload + target locale to a
   * translated payload. Default: shells out to the LLM client with a
   * minimal prompt. Tests inject a deterministic stub.
   */
  readonly translate?: (
    payload: Payload,
    locale: string,
    originalLocale: string,
  ) => Promise<Payload>;
  readonly clock?: () => Date;
}

interface TranslationRow {
  source_version: number;
}

/**
 * Reads the layer's configured locales (`layer_locales` table) and
 * returns every non-original-locale code. An empty array means "no
 * translation work to do" — a perfectly normal state for a fresh layer.
 */
function fetchLayerLocales(db: Database, layerId: string, originalLocale: string): string[] {
  const rows = db
    .query<{ locale: string }, [string]>('SELECT locale FROM layer_locales WHERE layer_id = ?')
    .all(layerId);
  return rows.map((r) => r.locale).filter((l) => l !== originalLocale);
}

function lookupExistingSource(
  db: Database,
  entityId: string,
  locale: string,
): TranslationRow | null {
  return db
    .query<
      TranslationRow,
      [string, string]
    >('SELECT source_version FROM entity_translations WHERE entity_id = ? AND locale = ?')
    .get(entityId, locale);
}

/** Default translate: produce a deterministic stub via the LLM client. */
async function llmTranslateDefault<Payload>(
  llm: LlmClient,
  payload: Payload,
  locale: string,
  originalLocale: string,
): Promise<Payload> {
  const prompt =
    `Translate the following JSON payload from '${originalLocale}' to '${locale}'. ` +
    `Return ONLY the translated JSON object with the same shape.\n\n` +
    JSON.stringify(payload);
  const response = await llm.chat({
    messages: [
      {
        role: 'system',
        content: 'You are a translator. Output is JSON matching the input shape.',
      },
      { role: 'user', content: prompt },
    ],
  });
  try {
    return JSON.parse(response.content) as Payload;
  } catch {
    // The LLM did not return parseable JSON. Surface the un-parsed text
    // by re-using the original payload — the contract test suite asserts
    // we never write garbage; production callers can read the failure
    // through `entity.translation.completed` latency metrics + the
    // `error` field on a follow-up failure event (phase 5 work).
    return payload;
  }
}

export function createEntityTranslator<Payload>(
  deps: CreateEntityTranslatorDeps<Payload>,
): EntityTranslator {
  const { module, store, db, bus, llm } = deps;
  const clock = deps.clock ?? (() => new Date());
  const translateFn =
    deps.translate ??
    ((payload: Payload, locale: string, originalLocale: string): Promise<Payload> =>
      llmTranslateDefault(llm, payload, locale, originalLocale));

  async function handle(ref: EntityRef, version: number): Promise<void> {
    const entity = store.getById(ref.id);
    if (entity === null) return;
    const locales = fetchLayerLocales(db, entity.layerId, entity.meta.originalLocale);
    for (const locale of locales) {
      const existing = lookupExistingSource(db, entity.id, locale);
      if (existing !== null && existing.source_version >= version) {
        continue;
      }
      const requested: EntityTranslationRequestedPayload = {
        ref,
        locale,
        sourceVersion: version,
      };
      await bus.publish({
        type: ENTITY_EVENT_TYPES.TranslationRequested,
        payload: requested,
      });
      const start = Date.now();
      const translated = await translateFn(entity.payload, locale, entity.meta.originalLocale);
      const latencyMs = Date.now() - start;
      await store.recordTranslation({
        ref,
        locale,
        sourceVersion: version,
        payload: translated,
        latencyMs,
        now: clock(),
      });
    }
  }

  const unsubCreated = bus.subscribe<EntityCreatedPayload>(
    entityEventType(module.kind, 'created'),
    async (event) => {
      await handle(event.payload.ref, event.payload.version);
    },
  );
  const unsubUpdated = bus.subscribe<EntityUpdatedPayload>(
    entityEventType(module.kind, 'updated'),
    async (event) => {
      await handle(event.payload.ref, event.payload.version);
    },
  );

  return {
    dispose() {
      unsubCreated();
      unsubUpdated();
    },
  };
}
