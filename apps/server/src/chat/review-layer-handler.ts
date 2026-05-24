/**
 * Phase 6.6 — `chat.review-layer` scheduled-task handler placeholder.
 *
 * Per `phase-06-super-chat.md` §2 ("Out of scope") the
 * self-learning / review-job body is deferred to phase 7. Phase 6
 * registers the handler so the scheduled-task surface (admin list,
 * job inventory, seed) already knows about the kind; the run body
 * is a no-op that logs a single line per invocation.
 *
 * Phase 7 will replace the body with the real layer review job —
 * the kind, default cadence, and registration shape stay; only the
 * `run(...)` implementation changes. ADR 0020 records the contract.
 */

import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../scheduled';

export const CHAT_REVIEW_LAYER_KIND = 'chat.review-layer';

const DEFAULT_INTERVAL_MINUTES = 60 * 24;

export const chatReviewLayerHandler: ScheduledTaskHandler = {
  kind: CHAT_REVIEW_LAYER_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(ctx: ScheduledTaskRunContext): Promise<void> {
    // Placeholder body — phase 7 will fill this in. We still log so an
    // ops dashboard can confirm the kind is wired correctly.
    ctx.logger.info('chat.review-layer placeholder ran', {
      event: 'chat.review-layer.placeholder',
      message: 'phase 6 placeholder — phase 7 will fill',
      taskId: ctx.task.id,
      layerId: ctx.task.layerId,
    });
  },
};
