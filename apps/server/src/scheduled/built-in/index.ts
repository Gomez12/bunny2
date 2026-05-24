/**
 * Phase 5.5 — built-in scheduled-task handlers barrel.
 *
 * Re-exports the kind constants and handler factories so wiring
 * (`scheduled/index.ts`) and the seed (`scheduled/seed.ts`) share a
 * single import surface for the built-in set. New built-in handlers
 * add an entry here AND in `BUILT_IN_HANDLER_FACTORIES` (in
 * `scheduled/index.ts`) AND in `SYSTEM_TASKS` (in
 * `scheduled/seed.ts`) — three coupled lists is intentional, the
 * registry-test will catch a stray addition that forgets the docs.
 */

export {
  SCHEDULED_RUNS_PRUNE_KIND,
  scheduledRunsPruneHandler,
  pruneScheduledTaskRuns,
} from './runs-prune';
export { LLM_PRUNE_KIND, createLlmPruneHandler } from './llm-prune';
export type { CreateLlmPruneHandlerDeps } from './llm-prune';
export { SYSTEM_HEALTHCHECK_KIND, createHealthcheckHandler } from './healthcheck';
export type { CreateHealthcheckHandlerDeps } from './healthcheck';
export { BUS_OUTBOX_PRUNE_KIND, busOutboxPruneHandler, pruneBusOutbox } from './bus-outbox-prune';
