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
import { calendarEventModule } from './module';

export {
  calendarEventModule,
  createCalendarEventModule,
  CALENDAR_EVENT_KIND,
  CALENDAR_EVENT_TABLE,
  type CreateCalendarEventModuleOptions,
} from './module';

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
   * Optional override for tests that need a per-fixture variant. In
   * 4c.1 there are no runtime deps to inject, but the slot mirrors
   * the companies / contacts wiring so 4c.2 (Google Calendar
   * connector) and 4c.3 (AI enrichment) stay additive.
   */
  readonly module?: EntityModule<CalendarEventPayload>;
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
): void {
  const existing = getEntityModule(module.kind);
  if (existing !== null) return;
  registerEntityModule(module);
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
  });
}
