/**
 * Phase 7.6 — boot-time scheduled-task registration for the
 * `proposals` domain.
 *
 * Mirrors `apps/server/src/chat/index.ts#registerChatScheduledTaskHandlers`:
 *  - imports do NOT register handlers as a side effect;
 *  - this helper is called once from `apps/server/src/index.ts` AFTER
 *    the bus, the capability registry, and the per-kind entity-store
 *    helpers are constructed (the replan-stale handler needs all
 *    three).
 *  - idempotent — calling twice with the same registry skips the
 *    kinds that are already present, matching the chat helper so
 *    test suites can register + reset freely.
 *
 * Two kinds:
 *   - `proposals.evidence.prune` — pure retention; no LLM, no bus,
 *     no registry — just a SQL prune. Handler is self-contained.
 *   - `proposals.replan-stale` — re-runs the sandbox for stale
 *     `new` proposals; needs LLM, bus, registry, entity-store
 *     resolver.
 */

import {
  registerScheduledTaskHandler,
  getScheduledTaskHandler,
  type ScheduledTaskHandler,
} from '../scheduled';
import { proposalsEvidencePruneHandler } from './evidence-prune-handler';
import {
  buildProposalsReplanStaleHandler,
  proposalsReplanStaleHandler,
  type ProposalsReplanStaleDeps,
} from './replan-stale-handler';
import {
  buildProposalsAutoActivateHandler,
  proposalsAutoActivateHandler,
  type ProposalsAutoActivateDeps,
} from './auto-activate-handler';

export interface RegisterProposalsScheduledTaskHandlersDeps {
  /**
   * Optional replan-stale dependencies. When provided, the helper
   * registers a fully-wired `proposals.replan-stale` handler. When
   * omitted (the docs-check fixture, smoke fixtures that don't run
   * the sandbox), the helper registers the placeholder shape so the
   * registry sees the `kind` without booting the chat pipeline.
   */
  readonly replanStale?: ProposalsReplanStaleDeps;
  /**
   * Phase 8.3 — optional auto-activate dependencies. Same pattern as
   * `replanStale`: when supplied, the helper registers a fully-wired
   * `proposals.auto-activate` handler; when omitted (docs-check /
   * smoke fixtures), it registers the placeholder shape.
   */
  readonly autoActivate?: ProposalsAutoActivateDeps;
}

export function registerProposalsScheduledTaskHandlers(
  deps: RegisterProposalsScheduledTaskHandlersDeps = {},
): void {
  const handlers: ScheduledTaskHandler[] = [
    proposalsEvidencePruneHandler,
    deps.replanStale !== undefined
      ? buildProposalsReplanStaleHandler(deps.replanStale)
      : proposalsReplanStaleHandler,
    deps.autoActivate !== undefined
      ? buildProposalsAutoActivateHandler(deps.autoActivate)
      : proposalsAutoActivateHandler,
  ];
  for (const handler of handlers) {
    if (getScheduledTaskHandler(handler.kind) === null) {
      registerScheduledTaskHandler(handler);
    }
  }
}
