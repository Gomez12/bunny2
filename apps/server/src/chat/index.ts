/**
 * Phase 6 — chat module barrel + boot-time scheduled-task wiring.
 *
 * Mirrors `apps/server/src/scheduled/index.ts`:
 *  - imports do NOT register handlers as a side effect;
 *  - `registerChatScheduledTaskHandlers(deps)` is a boot-time call
 *    that hands the registry the deps each handler needs (the
 *    embedder + the LanceDB writer, in 6.2's case).
 *
 * The function is idempotent — calling twice with the same registry
 * skips the kinds that are already present, matching
 * `registerBuiltInScheduledTaskHandlers` and letting test suites
 * register and reset freely.
 *
 * Subscribers (the entity-event → LanceDB writer) live behind the
 * shape returned by `createEmbeddingSubscriber({...}).start()`,
 * which is invoked from `apps/server/src/index.ts` AFTER `createApp`
 * (every per-kind module must register first — same dance as the
 * enrichment runner).
 */

import {
  registerScheduledTaskHandler,
  getScheduledTaskHandler,
  type ScheduledTaskHandler,
} from '../scheduled';
import { createChatEmbeddingsBackfillHandler, type Embedder, type LanceWriter } from './embeddings';
import { chatRunsPruneHandler } from './runs-prune-handler';
import { chatReviewLayerHandler } from './review-layer-handler';

export interface RegisterChatScheduledTaskHandlersDeps {
  readonly embedder: Embedder;
  readonly writer: LanceWriter;
}

/**
 * Idempotent registration of the chat-domain scheduled-task handlers
 * (just `chat.embeddings.backfill` in 6.2; 6.6 will add
 * `chat.review-layer` + `chat.runs.prune`).
 *
 * `scripts/docs-check.ts` and `apps/server/tests/docs/job-inventory.test.ts`
 * BOTH call this helper with stub deps so the registered set lines up
 * with the documented rows in `docs/dev/architecture/job-inventory.md`.
 */
export function registerChatScheduledTaskHandlers(
  deps: RegisterChatScheduledTaskHandlersDeps,
): void {
  const handlers: readonly ScheduledTaskHandler[] = [
    createChatEmbeddingsBackfillHandler({
      embedder: deps.embedder,
      writer: deps.writer,
    }),
    chatReviewLayerHandler,
    chatRunsPruneHandler,
  ];
  for (const handler of handlers) {
    if (getScheduledTaskHandler(handler.kind) === null) {
      registerScheduledTaskHandler(handler);
    }
  }
}

export * from './embeddings';
export * from './pipeline';
export * from './events';
export {
  CHAT_RUNS_PRUNE_KIND,
  pruneChatPipelineRuns,
  chatRunsPruneHandler,
  type ChatRunsPruneConfig,
  type ChatRunsPruneResult,
} from './runs-prune-handler';
export { CHAT_REVIEW_LAYER_KIND, chatReviewLayerHandler } from './review-layer-handler';
