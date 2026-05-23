import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import type { MessageBus } from '@bunny2/bus';
import type { CompanyPayload } from '@bunny2/shared';
import type { HonoVariables } from '../../http/types';
import type { LlmClient } from '../../llm';
import { createEntityStore } from '../store';
import { mountEntityRoutes } from '../router';
import { getEntityModule, registerEntityModule } from '../registry';
import { companyModule } from './module';

export { companyModule, COMPANY_KIND, COMPANY_TABLE } from './module';

/**
 * Phase 4a.1 — wire-up helper for the companies module.
 *
 * Registers `companyModule` in the process-local entity registry (so
 * phase-5 schedulers and phase-6 chat can enumerate kinds) and mounts
 * the generic per-kind HTTP surface at `/l/:slug/company/*`. The
 * generic store writes `kvk_number` and `website` to the per-kind
 * `companies` table via `companyModule.indexedColumns` — no
 * companies-specific SQL lives outside the migration.
 *
 * The wiring is exposed as a function (instead of a top-level side
 * effect on import) so tests can drive the store / module directly
 * without booting the HTTP layer and without colliding on the
 * registry.
 */
export interface MountCompanyRoutesDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
}

/**
 * Idempotent: safe to call multiple times per process. The §4.0
 * registry throws on duplicate `kind`; tests build the app many times
 * per file via `makeTestApp`, so we short-circuit when the same module
 * instance is already registered. A different module under the same
 * kind is still a programming error and propagates the registry's
 * exception.
 */
export function registerCompanyModule(): void {
  const existing = getEntityModule(companyModule.kind);
  if (existing === companyModule) return;
  registerEntityModule(companyModule);
}

export function mountCompanyRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountCompanyRoutesDeps,
): void {
  const store = createEntityStore<CompanyPayload>({
    module: companyModule,
    db: deps.db,
    bus: deps.bus,
    llm: deps.llm,
  });
  mountEntityRoutes(app, {
    module: companyModule,
    store,
    bus: deps.bus,
    db: deps.db,
  });
}
