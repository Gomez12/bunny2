import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import type { MessageBus } from '@bunny2/bus';
import type { CalendarEventPayload } from '@bunny2/shared';
import type { HonoVariables } from '../../http/types';
import type { LlmClient } from '../../llm';
import { createEntityStore } from '../store';
import { mountEntityRoutes } from '../router';
import { getEntityModule, registerEntityModule } from '../registry';
import type { EntityModule } from '../module';
import { calendarEventModule, createCalendarEventModule } from './module';
import { buildProductionGoogleCalendarConnector } from './google-connector';
import { calendarEventEnrichmentJobs } from './enrichment';

export {
  calendarEventModule,
  createCalendarEventModule,
  CALENDAR_EVENT_KIND,
  CALENDAR_EVENT_TABLE,
  type CreateCalendarEventModuleOptions,
} from './module';
export {
  calendarAttendeeContactsJob,
  calendarSummaryJob,
  calendarEventEnrichmentJobs,
} from './enrichment';

export { calendarEventStatsProvider, type CalendarEventStats } from './stats';

export {
  createGoogleCalendarConnector,
  createGoogleCalendarConfigResolver,
  buildProductionGoogleCalendarConnector,
  GoogleCalendarConfigSchema,
  GOOGLE_CALENDAR_CONNECTOR_ID,
  GOOGLE_CALENDAR_CONNECTOR_KIND,
  GOOGLE_CALENDAR_ERROR_KEYS,
  GOOGLE_CALENDAR_INGEST_CONTENT_TYPE,
  type GoogleCalendarConfig,
  type CreateGoogleCalendarConnectorDeps,
} from './google-connector';

/**
 * Phase 4c.1 — wire-up helper for the calendar-event module.
 *
 * Registers `calendarEventModule` in the process-local entity
 * registry (so phase-5 schedulers and phase-6 chat can enumerate
 * kinds) and mounts the generic per-kind HTTP surface at
 * `/l/:slug/calendar_event/*`. The generic store writes
 * `starts_at`, `ends_at`, `all_day`, `rrule_string`, and
 * `external_calendar_id` to the per-kind `calendar_events` table
 * via `calendarEventModule.indexedColumns` — no calendar-specific
 * SQL lives outside the migration.
 *
 * The wiring is exposed as a function (instead of a top-level side
 * effect on import) so tests can drive the store / module directly
 * without booting the HTTP layer and without colliding on the
 * registry.
 */
export interface MountCalendarEventRoutesDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  /**
   * Optional override for tests that need a per-fixture variant.
   * Production wiring passes `buildProductionCalendarEventModule()` so
   * the Google Calendar connector is reachable via the registry.
   */
  readonly module?: EntityModule<CalendarEventPayload>;
  /**
   * Phase 4c.2 — process-wide ingest dispatcher. When provided, the
   * generic entity router mounts
   * `POST /l/:slug/calendar_event/_ingest/:connectorId` for the Google
   * Calendar bulk-sync request (content-type
   * `application/x-google-calendar-list-request`). Omitted in unit
   * tests that exercise the contract suite only.
   */
  readonly ingestDispatcher?: import('../connector-dispatcher').ConnectorDispatcher;
  /** Phase 4c.2 — max ingest body size. Production uses `config.connectors.ingestMaxBytes`. */
  readonly ingestMaxBytes?: number;
  /** Phase 4c.2 — default locale stamped on ingest-created rows. */
  readonly defaultLocale?: string;
}

/**
 * Idempotent: safe to call multiple times per process. Mirrors
 * `registerCompanyModule` / `registerContactModule` —
 * short-circuits when ANY calendar-event module is already
 * registered, so tests that pre-register a fixture variant BEFORE
 * `createApp(...)` runs do not collide with the production default
 * that `createApp` registers a moment later. Production has a
 * single caller (`createApp`), so the short-circuit never fires
 * there.
 *
 * Pass `module` to register a per-test variant. Defaults to the
 * production `calendarEventModule`.
 */
export function registerCalendarEventModule(
  module: EntityModule<CalendarEventPayload> = calendarEventModule,
): EntityModule<CalendarEventPayload> {
  const existing = getEntityModule(module.kind);
  if (existing !== null) return existing as EntityModule<CalendarEventPayload>;
  registerEntityModule(module);
  return module;
}

/**
 * Phase 4c.2 — build the calendar module with the production Google
 * Calendar connector wired in. Called from `apps/server/src/index.ts`
 * BEFORE `createApp` so the dispatcher / runner see the connector on
 * the registered module. Tests use `createCalendarEventModule` directly
 * with a stub connector.
 *
 * The connector's `SecretsService` is constructed lazily inside
 * `buildProductionGoogleCalendarConnector` — it reads
 * `BUNNY2_ENCRYPTION_KEY` via `createSecretsService()`. When the env var
 * is absent the service still constructs (hasKey === false); any
 * attempt to decrypt then fails with the stable `errors.secrets.keyMissing`
 * key. This means a deployment without OAuth connectors still boots
 * cleanly.
 */
export function buildProductionCalendarEventModule(): EntityModule<CalendarEventPayload> {
  return createCalendarEventModule({
    connectors: [buildProductionGoogleCalendarConnector()],
    enrichmentJobs: calendarEventEnrichmentJobs,
  });
}

export function mountCalendarEventRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountCalendarEventRoutesDeps,
): void {
  const module = deps.module ?? calendarEventModule;
  const store = createEntityStore<CalendarEventPayload>({
    module,
    db: deps.db,
    bus: deps.bus,
    llm: deps.llm,
  });
  mountEntityRoutes(app, {
    module,
    store,
    bus: deps.bus,
    db: deps.db,
    ...(deps.ingestDispatcher === undefined ? {} : { ingestDispatcher: deps.ingestDispatcher }),
    ...(deps.ingestMaxBytes === undefined ? {} : { ingestMaxBytes: deps.ingestMaxBytes }),
    ...(deps.defaultLocale === undefined ? {} : { defaultLocale: deps.defaultLocale }),
  });
}
