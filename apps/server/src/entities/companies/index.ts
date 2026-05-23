import type { Database } from 'bun:sqlite';
import type { Hono } from 'hono';
import type { MessageBus } from '@bunny2/bus';
import type { CompanyPayload } from '@bunny2/shared';
import type { HonoVariables } from '../../http/types';
import type { LlmClient } from '../../llm';
import { createEntityStore } from '../store';
import { mountEntityRoutes } from '../router';
import { getEntityModule, registerEntityModule } from '../registry';
import type { EntityModule } from '../module';
import { companyModule } from './module';

export {
  companyModule,
  createCompanyModule,
  COMPANY_KIND,
  COMPANY_TABLE,
  type CreateCompanyModuleOptions,
} from './module';
export {
  createKvkConnector,
  KvkConfigSchema,
  KVK_CONNECTOR_ID,
  KVK_CONNECTOR_KIND,
  KVK_ERROR_KEYS,
  mapBasisprofielToCompanyPayload,
  type KvkConfig,
  type CreateKvkConnectorDeps,
} from './kvk-connector';
export { companiesSummaryJob, companiesFillFieldsJob, companyEnrichmentJobs } from './enrichment';
export { companyStatsProvider, type CompanyStats } from './stats';

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
  /** Optional override for tests that need a stubbed KvK connector. */
  readonly module?: EntityModule<CompanyPayload>;
}

/**
 * Idempotent: safe to call multiple times per process. The §4.0
 * registry throws on duplicate `kind`; tests build the app many times
 * per file via `makeTestApp`, so we short-circuit when ANY company
 * module is already registered. This deliberately allows the 4a.6
 * smoke (and any future per-fixture wiring) to pre-register a
 * stub-fetched variant BEFORE `createApp(...)` runs — `createApp` then
 * calls `registerCompanyModule()` with the production default, sees
 * the pre-registered stub, and no-ops. Production has a single caller
 * (in `createApp`), so the short-circuit never fires there.
 *
 * Pass `module` to register a per-test variant (e.g. with a stubbed
 * KvK connector). Defaults to the production `companyModule`.
 */
export function registerCompanyModule(module: EntityModule<CompanyPayload> = companyModule): void {
  const existing = getEntityModule(module.kind);
  if (existing !== null) return;
  registerEntityModule(module);
}

export function mountCompanyRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountCompanyRoutesDeps,
): void {
  const module = deps.module ?? companyModule;
  const store = createEntityStore<CompanyPayload>({
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
