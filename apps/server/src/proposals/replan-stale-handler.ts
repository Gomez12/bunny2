/**
 * Phase 7.6 — `proposals.replan-stale` scheduled-task handler.
 *
 * For every `new` proposal older than 7 days, re-snapshot the layer's
 * current capability set and compare to the proposal's mint-time
 * snapshot. When the diff is non-empty, **re-run the sandbox** (NOT
 * the LLM mint) to refresh the artifact rows under the current
 * capability set, so the admin viewing the detail page sees evidence
 * grounded in today's reality.
 *
 * Important guarantees:
 *  - **Idempotent.** A proposal whose snapshot already matches the
 *    current set is left alone (no rows written; no LLM cost).
 *  - **Status never changes.** This handler refreshes evidence; the
 *    admin still chooses approve / reject. This is what separates it
 *    from `replanOnApproval` (the approval-driven path that does
 *    activate / supersede).
 *  - The sandbox uses the deps wired through `ProposalsReplanStaleDeps`;
 *    the snapshot is computed exactly like 7.4's `replanOnApproval`
 *    (the registry's live read; built-ins reserved for later).
 *
 * Default schedule: interval, 24 h.
 */

import {
  ProposalSpecSchema,
  type CapabilitySnapshot,
  type ImprovementProposal,
  type ProposalSpec,
} from '@bunny2/shared';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { LlmClient } from '../llm';
import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../scheduled';
import type { CapabilityRegistry } from './capability-registry';
import { createImprovementProposalsRepo } from './repos/improvement-proposals-repo';
import { createImprovementProposalEvidenceRepo } from './repos/improvement-proposal-evidence-repo';
import { createImprovementProposalArtifactsRepo } from './repos/improvement-proposal-artifacts-repo';
import { createChatConversationsRepo } from '../chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../chat/repos/chat-messages-repo';
import { runSandbox, type SandboxEvidenceInput } from './sandbox/runner';
import { diffSnapshots } from './replan';
import type { EntityKind, EntityStoreForRetrieval } from '../chat/pipeline';

export const PROPOSALS_REPLAN_STALE_KIND = 'proposals.replan-stale';

const DEFAULT_INTERVAL_MINUTES = 60 * 24;
const STALE_AFTER_DAYS = 7;

export interface ProposalsReplanStaleConfig {
  readonly staleAfterDays: number;
}

export interface ProposalsReplanStaleResult {
  readonly proposalsScanned: number;
  readonly proposalsRefreshed: number;
  readonly proposalsSkippedNoDrift: number;
  readonly proposalsSkippedError: number;
}

export interface ProposalsReplanStaleDeps {
  readonly llm: LlmClient;
  readonly bus: MessageBus;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly getEntityStore: (kind: EntityKind) => EntityStoreForRetrieval | null;
}

function readConfig(raw: Readonly<Record<string, unknown>>): ProposalsReplanStaleConfig {
  return { staleAfterDays: pickPositiveInt(raw['staleAfterDays'], STALE_AFTER_DAYS) };
}

function pickPositiveInt(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v) && v > 0 && Number.isInteger(v)) {
    return v;
  }
  return fallback;
}

interface StaleScanRow {
  readonly id: string;
}

/**
 * Walk every `status='new'` proposal older than `staleAfterDays` and
 * re-run the sandbox when the layer's capability snapshot has drifted.
 * The proposal row's `status` and `capability_snapshot_json` are
 * NEVER mutated by this path — only the artifact rows are refreshed.
 *
 * Pure-ish: takes deps, returns a count. The `now` argument lets tests
 * pin time deterministically.
 */
export async function replanStaleProposals(
  db: Database,
  bus: MessageBus,
  llm: LlmClient,
  registry: CapabilityRegistry,
  getEntityStore: (kind: EntityKind) => EntityStoreForRetrieval | null,
  config: ProposalsReplanStaleConfig,
  now: Date,
  logger: {
    info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
    error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  },
): Promise<ProposalsReplanStaleResult> {
  const proposalsRepo = createImprovementProposalsRepo(db);
  const evidenceRepo = createImprovementProposalEvidenceRepo(db);
  const artifactsRepo = createImprovementProposalArtifactsRepo(db);
  const conversationsRepo = createChatConversationsRepo(db);
  const messagesRepo = createChatMessagesRepo(db);

  const cutoffIso = new Date(
    now.getTime() - config.staleAfterDays * 24 * 60 * 60 * 1000,
  ).toISOString();

  const scanRows = db
    .query<StaleScanRow, [string]>(
      `SELECT id FROM improvement_proposals
        WHERE status = 'new'
          AND deleted_at IS NULL
          AND minted_at < ?
        ORDER BY minted_at ASC`,
    )
    .all(cutoffIso);

  let refreshed = 0;
  let skippedNoDrift = 0;
  let skippedError = 0;

  for (const scan of scanRows) {
    const row = proposalsRepo.getProposalById(scan.id);
    if (row === null) {
      skippedError += 1;
      continue;
    }

    const specParse = ProposalSpecSchema.safeParse(JSON.parse(row.proposedSpecJson));
    if (!specParse.success) {
      logger.warn('proposals.replan-stale invalid-spec', {
        event: 'proposals.replan-stale.skipped',
        proposalId: row.id,
        reason: 'invalid_spec',
      });
      skippedError += 1;
      continue;
    }
    const spec: ProposalSpec = specParse.data;

    const mintedSnapshot = JSON.parse(row.capabilitySnapshotJson) as CapabilitySnapshot;
    const currentSnapshot: CapabilitySnapshot = {
      capabilities: registry.listActive(row.layerId).map((c) => ({ ...c })),
      builtins: [],
    };
    const diff = diffSnapshots(mintedSnapshot, currentSnapshot);
    if (diff.isEmpty) {
      skippedNoDrift += 1;
      continue;
    }

    const proposal: ImprovementProposal = {
      id: row.id,
      layerId: row.layerId,
      status: row.status,
      artifactKind: row.artifactKind,
      problemSummary: row.problemSummary,
      proposedSpec: spec,
      expectedImpact: JSON.parse(row.expectedImpactJson),
      threshold: row.threshold,
      capabilitySnapshot: mintedSnapshot,
      mintedByRunId: row.mintedByRunId,
      mintedAt: row.mintedAt,
      approvedBy: row.approvedBy,
      approvedAt: row.approvedAt,
      rejectedBy: row.rejectedBy,
      rejectedAt: row.rejectedAt,
      rejectedReason: row.rejectedReason,
      activatedAt: row.activatedAt,
      deletedAt: row.deletedAt,
      deletedBy: row.deletedBy,
    };

    const evidence: readonly SandboxEvidenceInput[] = evidenceRepo
      .listByProposal(row.id)
      .map((e) => ({ id: e.id, messageId: e.messageId, clusterReason: e.clusterReason }));

    if (evidence.length === 0) {
      // No supporting messages to replay; nothing useful to refresh.
      skippedNoDrift += 1;
      continue;
    }

    try {
      const result = await runSandbox(proposal, evidence, {
        llm,
        db,
        bus,
        capabilityRegistry: registry,
        artifactsRepo,
        conversationsRepo,
        messagesRepo,
        getEntityStore,
        logger,
      });
      if ('err' in result) {
        logger.warn('proposals.replan-stale sandbox error', {
          event: 'proposals.replan-stale.skipped',
          proposalId: row.id,
          reason: result.err.error,
        });
        skippedError += 1;
        continue;
      }
      refreshed += 1;
      logger.info('proposals.replan-stale refreshed', {
        event: 'proposals.replan-stale.refreshed',
        proposalId: row.id,
        layerId: row.layerId,
        evidenceCount: evidence.length,
      });
    } catch (err) {
      logger.error('proposals.replan-stale unexpected error', {
        event: 'proposals.replan-stale.failed',
        proposalId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
      skippedError += 1;
    }
  }

  return {
    proposalsScanned: scanRows.length,
    proposalsRefreshed: refreshed,
    proposalsSkippedNoDrift: skippedNoDrift,
    proposalsSkippedError: skippedError,
  };
}

/**
 * Build the scheduled-task handler. Production wires real deps via
 * `registerProposalsScheduledTaskHandlers`; tests can pass scripted
 * deps to drive the inner function.
 */
export function buildProposalsReplanStaleHandler(
  deps: ProposalsReplanStaleDeps,
): ScheduledTaskHandler {
  return {
    kind: PROPOSALS_REPLAN_STALE_KIND,
    defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
    async run(ctx: ScheduledTaskRunContext): Promise<void> {
      const config = readConfig(ctx.task.config);
      const now = new Date(ctx.now());
      const result = await replanStaleProposals(
        ctx.db,
        deps.bus,
        deps.llm,
        deps.capabilityRegistry,
        deps.getEntityStore,
        config,
        now,
        ctx.logger,
      );
      ctx.logger.info('proposals.replan-stale summary', {
        event: 'proposals.replan-stale.summary',
        scanned: result.proposalsScanned,
        refreshed: result.proposalsRefreshed,
        skippedNoDrift: result.proposalsSkippedNoDrift,
        skippedError: result.proposalsSkippedError,
        staleAfterDays: config.staleAfterDays,
      });
    },
  };
}

/**
 * Lazy placeholder export so `registerProposalsScheduledTaskHandlers`
 * (which carries the real deps) is the canonical wire-up. Tests that
 * want to introspect the handler kind use `PROPOSALS_REPLAN_STALE_KIND`.
 *
 * Carries a default-build-with-throwing-deps so the docs-check /
 * job-inventory test fixture can register the kind without booting
 * the full chat pipeline. Calling `run(...)` on this placeholder
 * panics — production always uses the builder above.
 */
export const proposalsReplanStaleHandler: ScheduledTaskHandler = {
  kind: PROPOSALS_REPLAN_STALE_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(): Promise<void> {
    throw new Error(
      'proposals.replan-stale: placeholder handler invoked. ' +
        'Production wiring must call buildProposalsReplanStaleHandler({...}) ' +
        'with real deps and register that handler.',
    );
  },
};
