/**
 * Phase 8.3 — `proposals.auto-activate` scheduled-task handler.
 *
 * Hourly job that consumes the pure gate function from 8.2
 * (`evaluateAutoActivation`) and, for every proposal that passes the
 * seven gates (ADR 0026 §1), calls the same `replanOnApproval(...)`
 * path the admin "approve" route uses — only with
 * `actorKind: 'system'` so the proposal row's `approved_by` FK stays
 * clean and the audit lands in `auto_activated_by` / `auto_activated_at`
 * instead (ADR 0026 §3).
 *
 * Iteration shape per ADR 0026 + plan §4.3:
 *  - Walk every layer with `auto_activation_enabled = true`.
 *  - Walk every `status='new'` proposal in that layer.
 *  - Load the artifact pair (`variant='current'` + `variant='proposed'`)
 *    via `artifactsRepo.listByProposal(...)` — the runner always writes
 *    them together (ADR 0026 §1 gate 4 treats a missing half as
 *    `no-sandbox-evidence`).
 *  - Evaluate the gates with `now = ctx.now()` (the scheduled-task
 *    harness's clock; tests inject a fixed value).
 *  - **Always** persist the decision JSON via
 *    `recordAutoActivationDecision(...)` BEFORE calling
 *    `replanOnApproval` (ADR 0026 §4). This gives admins a forensic
 *    trail even when the auto-path fails mid-flight.
 *  - On `eligible`: call `replanOnApproval(id, SYSTEM_ACTOR, deps)`.
 *    On success — regardless of which of the four outcomes it lands —
 *    stamp `auto_activated_by = 'system'` + `auto_activated_at` via
 *    `recordAutoActivation(...)` and publish
 *    `proposal.auto-activated`. On throw: log + continue (decision
 *    JSON already written; the auto_activated_* columns stay NULL
 *    so the row reflects "system tried, failed").
 *
 * Logging fields are structured per `AGENTS.md §Logging`; closed-enum
 * dimensions (`decision`, `rejectionReason`, `outcome`) keep
 * telemetry cardinality bounded (`AGENTS.md §Telemetry`).
 *
 * Default schedule: interval, 60 minutes.
 */

import type { MessageBus } from '@bunny2/bus';
import type {
  ScheduledTaskHandler,
  ScheduledTaskHandlerLogger,
  ScheduledTaskRunContext,
} from '../scheduled';
import { SYSTEM_ACTOR, evaluateAutoActivation } from './auto-activate';
import type { ImprovementProposalsRepo } from './repos/improvement-proposals-repo';
import type { ImprovementProposalArtifactsRepo } from './repos/improvement-proposal-artifacts-repo';
import type { LayerProposalSettingsRepo } from './repos/layer-proposal-settings-repo';
import type { VariantMetrics } from './sandbox/metrics';
import type { ReplanOutcome } from './replan';
import { PROPOSAL_AUTO_ACTIVATED_EVENT_TYPE, type ProposalAutoActivatedPayload } from './events';

export const PROPOSALS_AUTO_ACTIVATE_KIND = 'proposals.auto-activate';

const DEFAULT_INTERVAL_MINUTES = 60;

/**
 * Minimal layers-repo seam the handler needs. The real
 * `LayersRepo.listLayers()` returns the full layer row; this seam
 * narrows to the id field so tests can supply a tiny shim without
 * pulling the whole repo factory.
 */
export interface AutoActivateLayersSeam {
  listAllNonDeleted(): ReadonlyArray<{ readonly id: string }>;
}

/**
 * Production-time deps for the auto-activate handler. The `replan`
 * field is a closure: the handler does NOT know about the inner
 * sandbox / capability registry plumbing — the boot code in
 * `apps/server/src/index.ts` constructs the closure once and threads
 * it in, so the handler stays unit-testable with a scripted replan.
 *
 * `bus` is wide-open `MessageBus` so the handler can publish the
 * `proposal.auto-activated` event in-process.
 */
export interface ProposalsAutoActivateDeps {
  readonly layersRepo: AutoActivateLayersSeam;
  readonly settingsRepo: LayerProposalSettingsRepo;
  readonly proposalsRepo: ImprovementProposalsRepo;
  readonly artifactsRepo: ImprovementProposalArtifactsRepo;
  /**
   * Closure that calls `replanOnApproval(id, approvedBy, { ...replanDeps, actorKind: 'system' })`.
   * Returns the four-outcome verdict; throws if the replan path
   * itself failed (LLM hiccup, DB error). The handler logs the
   * throw and moves to the next proposal.
   */
  readonly replan: (proposalId: string, approvedBy: string) => Promise<ReplanOutcome>;
  readonly bus: MessageBus;
}

/**
 * Parses one artifact row's `metrics_json` into a `VariantMetrics`.
 * Returns `null` on parse failure — gate 4 (`no-sandbox-evidence`)
 * treats that the same as a missing row. The runner always writes
 * valid JSON, so a parse failure here is corruption; we refuse to
 * second-guess it.
 */
function parseMetrics(metricsJson: string): VariantMetrics | null {
  try {
    const parsed = JSON.parse(metricsJson) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'sandboxOutcome' in parsed &&
      'thumbsScore' in parsed &&
      'tokensIn' in parsed &&
      'tokensOut' in parsed
    ) {
      return parsed as VariantMetrics;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Builds a handler closed over real production deps. Mirrors
 * `buildProposalsReplanStaleHandler(...)`; the placeholder export
 * below carries a throwing `run(...)` so the docs-check fixture can
 * register the kind without booting the auto-activate machinery.
 */
export function buildProposalsAutoActivateHandler(
  deps: ProposalsAutoActivateDeps,
): ScheduledTaskHandler {
  return {
    kind: PROPOSALS_AUTO_ACTIVATE_KIND,
    defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
    async run(ctx: ScheduledTaskRunContext): Promise<void> {
      await runAutoActivate(ctx, deps);
    },
  };
}

/**
 * The inner loop. Extracted so tests can drive it without going
 * through the scheduled-task runner. Pure with respect to deps —
 * every side effect is via the injected repos / bus / logger /
 * replan closure.
 */
export async function runAutoActivate(
  ctx: ScheduledTaskRunContext,
  deps: ProposalsAutoActivateDeps,
): Promise<void> {
  const logger: ScheduledTaskHandlerLogger = ctx.logger;
  const nowIso = ctx.now();
  const now = new Date(nowIso);

  let layersScanned = 0;
  let proposalsScanned = 0;
  let proposalsEligible = 0;
  let proposalsRejected = 0;
  let proposalsErrored = 0;

  for (const layer of deps.layersRepo.listAllNonDeleted()) {
    const settings = deps.settingsRepo.getOrDefault(layer.id);
    if (!settings.autoActivationEnabled) continue;
    layersScanned += 1;

    const candidates = deps.proposalsRepo.listProposals({
      layerId: layer.id,
      status: 'new',
    });

    for (const proposal of candidates) {
      proposalsScanned += 1;

      // Load the artifact pair. `listByProposal` returns every variant
      // (current, proposed, replanned); we pick the first matching row
      // for `current` / `proposed`. Replanned rows from the existing
      // approve path are ignored here — the gate evaluates the
      // mint-time pair (ADR 0026 §1 gate 4 + 5).
      const artifacts = deps.artifactsRepo.listByProposal(proposal.id);
      const proposedRow = artifacts.find((a) => a.variant === 'proposed') ?? null;
      const currentRow = artifacts.find((a) => a.variant === 'current') ?? null;
      const proposedMetrics = proposedRow === null ? null : parseMetrics(proposedRow.metricsJson);
      const currentMetrics = currentRow === null ? null : parseMetrics(currentRow.metricsJson);

      const decision = evaluateAutoActivation({
        proposal,
        proposedMetrics,
        currentMetrics,
        settings,
        now,
      });

      // ADR 0026 §4 — ALWAYS write the decision JSON before any
      // side-effect, so a mid-flight replan throw still leaves a
      // forensic trail on the proposal row.
      deps.proposalsRepo.recordAutoActivationDecision(proposal.id, JSON.stringify(decision));

      // Structured log carrying the closed-enum decision +
      // rejectionReason dimensions. Proposal/layer ids live in the
      // log fields (`AGENTS.md §Logging` permits them) but are NOT
      // used as telemetry-counter dimensions (cardinality bound —
      // `AGENTS.md §Telemetry`).
      logger.info('proposal.auto-activate.decided', {
        event: 'proposal.auto-activate.decided',
        proposalId: proposal.id,
        layerId: layer.id,
        decision: decision.outcome,
        rejectionReason: decision.outcome === 'rejected' ? decision.reason : 'none',
      });

      if (decision.outcome !== 'eligible') {
        proposalsRejected += 1;
        continue;
      }
      proposalsEligible += 1;

      // Call into the existing approve path. The closure passed by
      // boot wiring threads `actorKind: 'system'` so `activateProposal`
      // does NOT write `approved_by` / `approved_at` — those columns
      // stay NULL (ADR 0026 §3).
      let outcome: ReplanOutcome;
      try {
        outcome = await deps.replan(proposal.id, SYSTEM_ACTOR);
      } catch (err) {
        proposalsErrored += 1;
        logger.error('proposal.auto-activate.replan-failed', {
          event: 'proposal.auto-activate.replan-failed',
          proposalId: proposal.id,
          layerId: layer.id,
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      // Stamp the audit columns AFTER the four-outcome verdict (ADR
      // 0026 §4 — "only carries those two columns when the system
      // actually made the call"). `recordAutoActivation` writes the
      // literal 'system' to `auto_activated_by` (not a users.id).
      deps.proposalsRepo.recordAutoActivation(proposal.id, nowIso);

      const payload: ProposalAutoActivatedPayload = {
        proposalId: proposal.id,
        layerId: layer.id,
        artifactKind: proposal.artifactKind,
        outcome: outcome.outcome,
        threshold: proposal.threshold,
      };
      void deps.bus
        .publish<ProposalAutoActivatedPayload>({
          type: PROPOSAL_AUTO_ACTIVATED_EVENT_TYPE,
          payload,
          flowId: `proposal.auto-activate:${ctx.task.id}-${proposal.id}`,
        })
        .catch((err) => {
          logger.warn('proposal.auto-activated.publish-failed', {
            event: 'proposal.auto-activated.publish-failed',
            proposalId: proposal.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  logger.info('proposal.auto-activate.summary', {
    event: 'proposal.auto-activate.summary',
    layersScanned,
    proposalsScanned,
    proposalsEligible,
    proposalsRejected,
    proposalsErrored,
  });
}

/**
 * Lazy placeholder export so `registerProposalsScheduledTaskHandlers`
 * (which carries the real deps) is the canonical wire-up. Tests that
 * want to introspect the handler kind use `PROPOSALS_AUTO_ACTIVATE_KIND`.
 *
 * Carries a throwing `run(...)` so the docs-check / job-inventory
 * test fixture can register the kind without booting the auto-activate
 * machinery. Production always uses the builder above.
 */
export const proposalsAutoActivateHandler: ScheduledTaskHandler = {
  kind: PROPOSALS_AUTO_ACTIVATE_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(): Promise<void> {
    throw new Error(
      'proposals.auto-activate: placeholder handler invoked. ' +
        'Production wiring must call buildProposalsAutoActivateHandler({...}) ' +
        'with real deps and register that handler.',
    );
  },
};
