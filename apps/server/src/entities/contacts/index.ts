import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import type { MessageBus } from '@bunny2/bus';
import type { ContactPayload } from '@bunny2/shared';
import type { HonoVariables } from '../../http/types';
import type { LlmClient } from '../../llm';
import { createEntityStore } from '../store';
import { mountEntityRoutes } from '../router';
import { getEntityModule, registerEntityModule } from '../registry';
import type { EntityModule } from '../module';
import { contactModule } from './module';

export {
  contactModule,
  createContactModule,
  CONTACT_KIND,
  CONTACT_TABLE,
  type CreateContactModuleOptions,
} from './module';

/**
 * Phase 4b.1 — wire-up helper for the contacts module.
 *
 * Registers `contactModule` in the process-local entity registry (so
 * phase-5 schedulers and phase-6 chat can enumerate kinds) and mounts
 * the generic per-kind HTTP surface at `/l/:slug/contact/*`. The
 * generic store writes `primary_email`, `primary_phone`, and
 * `company_entity_id` to the per-kind `contacts` table via
 * `contactModule.indexedColumns` — no contacts-specific SQL lives
 * outside the migration.
 *
 * The wiring is exposed as a function (instead of a top-level side
 * effect on import) so tests can drive the store / module directly
 * without booting the HTTP layer and without colliding on the
 * registry.
 */
export interface MountContactRoutesDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  /**
   * Optional override for tests that need a per-fixture variant. In
   * 4b.1 there are no runtime deps to inject, but the slot mirrors the
   * companies wiring so 4b.2 (vCard import) and 4b.3 (AI enrichment)
   * stay additive.
   */
  readonly module?: EntityModule<ContactPayload>;
}

/**
 * Idempotent: safe to call multiple times per process. Mirrors
 * `registerCompanyModule` — short-circuits when ANY contact module is
 * already registered, so tests that pre-register a fixture variant
 * BEFORE `createApp(...)` runs do not collide with the production
 * default that `createApp` registers a moment later. Production has a
 * single caller (`createApp`), so the short-circuit never fires there.
 *
 * Pass `module` to register a per-test variant. Defaults to the
 * production `contactModule`.
 */
export function registerContactModule(module: EntityModule<ContactPayload> = contactModule): void {
  const existing = getEntityModule(module.kind);
  if (existing !== null) return;
  registerEntityModule(module);
}

export function mountContactRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountContactRoutesDeps,
): void {
  const module = deps.module ?? contactModule;
  const store = createEntityStore<ContactPayload>({
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
