/**
 * Phase 7.3 — `chat.review-layer` scheduled-task handler.
 *
 * Replaces the phase-6 placeholder body with the real per-layer
 * review agent. The `kind`, `defaultSchedule`, and export name are
 * preserved exactly (the phase-6.6 contract guaranteed only the
 * `run(...)` implementation changes).
 *
 * Per-run shape (mirrors `phase-07-self-learning.md` §4.3):
 *  1. Iterate every non-deleted layer (Pattern A from the brief —
 *     the `chat.review-layer` job is registered scope `everyone` in
 *     `job-inventory.md`, so the single seeded row drives the loop;
 *     this avoids re-touching phase 5/6 territory).
 *  2. For each layer, read the last 7 days of chat telemetry
 *     (`chat_messages`, `chat_message_feedback`,
 *     `chat_pipeline_steps` joined via `chat_pipeline_runs`,
 *     `llm_calls`).
 *  3. Hand the rows to `groupClusters` (pure code, deterministic).
 *  4. For each surviving cluster, ask the LLM for a `ProposalSpec`
 *     wrapper (`mintProposalViaLlm`); on parse failure the minter
 *     retries once internally and on second failure returns `{ err }`
 *     so this handler logs `proposal.mint.skipped` and moves on.
 *  5. Persist one `improvement_proposals` row + N
 *     `improvement_proposal_evidence` rows per accepted cluster
 *     (phase 7.2 repos). Publish `proposal.minted` on the bus per
 *     accepted proposal.
 *  6. Log per-layer summary counters.
 *
 * Security (plan §10): every read is `WHERE layer_id = ?`; the LLM
 * is only handed that layer's cluster + that layer's capability
 * snapshot. No cross-layer joins, no cross-layer aggregation.
 *
 * Telemetry (plan §4.7): every cluster decision is logged with a
 * stable `event` name; counters live on the log lines (the codebase
 * doesn't ship a separate metrics sink — the backfill handler is
 * the model). Dims are bounded: `layerId` (bounded by layer count)
 * and `clusterReason` (closed enum). No message ids on counter dims.
 */

import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import type { CapabilitySnapshot } from '@bunny2/shared';
import type { ScheduledTaskHandler, ScheduledTaskRunContext } from '../scheduled';
import {
  groupClusters,
  type ClusterGrouperFeedback,
  type ClusterGrouperLlmCall,
  type ClusterGrouperMessage,
  type ClusterGrouperStep,
} from '../proposals/clusters';
import { mintProposalViaLlm } from '../proposals/mint';
import { createImprovementProposalsRepo } from '../proposals/repos/improvement-proposals-repo';
import { createImprovementProposalEvidenceRepo } from '../proposals/repos/improvement-proposal-evidence-repo';
import { createLayerCapabilitiesRepo } from '../proposals/repos/layer-capabilities-repo';
import { PROPOSAL_MINTED_EVENT_TYPE, type ProposalMintedPayload } from '../proposals/events';

export const CHAT_REVIEW_LAYER_KIND = 'chat.review-layer';

const DEFAULT_INTERVAL_MINUTES = 60 * 24;

const WINDOW_DAYS = 7;
const MAX_MESSAGE_SNIPPET_CHARS = 200;

export const chatReviewLayerHandler: ScheduledTaskHandler = {
  kind: CHAT_REVIEW_LAYER_KIND,
  defaultSchedule: { kind: 'interval', intervalMinutes: DEFAULT_INTERVAL_MINUTES },
  async run(ctx: ScheduledTaskRunContext): Promise<void> {
    const nowIso = ctx.now();
    const nowMs = Date.parse(nowIso);
    const windowFromIso = new Date(nowMs - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
    const windowToIso = nowIso;

    const layerIds = listActiveLayerIds(ctx.db);
    if (layerIds.length === 0) {
      ctx.logger.info('proposal.mint.no-layers', {
        event: 'proposal.mint.no-layers',
        windowFrom: windowFromIso,
        windowTo: windowToIso,
      });
      return;
    }

    for (const layerId of layerIds) {
      await runForLayer(ctx, layerId, windowFromIso, windowToIso);
    }
  },
};

async function runForLayer(
  ctx: ScheduledTaskRunContext,
  layerId: string,
  windowFromIso: string,
  windowToIso: string,
): Promise<void> {
  ctx.logger.info('proposal.mint.window-start', {
    event: 'proposal.mint.window-start',
    layerId,
    windowFrom: windowFromIso,
    windowTo: windowToIso,
  });

  const messages = listMessagesInWindow(ctx.db, layerId, windowFromIso, windowToIso);
  if (messages.length === 0) {
    ctx.logger.info('proposal.mint.no-clusters', {
      event: 'proposal.mint.no-clusters',
      layerId,
      windowFrom: windowFromIso,
      windowTo: windowToIso,
      messageCount: 0,
    });
    return;
  }

  const messageIds = messages.map((m) => m.id);
  const feedback = listFeedbackByMessageIds(ctx.db, messageIds);
  const steps = listStepsByMessageIds(ctx.db, messageIds);
  // Phase 7.3 does not derive a cluster from llm_calls; pass [].
  const llmCalls: readonly ClusterGrouperLlmCall[] = [];

  const messageById = new Map(messages.map((m) => [m.id, m]));

  const clusters = groupClusters({ messages, feedback, steps, llmCalls });
  if (clusters.length === 0) {
    ctx.logger.info('proposal.mint.no-clusters', {
      event: 'proposal.mint.no-clusters',
      layerId,
      windowFrom: windowFromIso,
      windowTo: windowToIso,
      messageCount: messages.length,
    });
    return;
  }

  const proposalsRepo = createImprovementProposalsRepo(ctx.db);
  const evidenceRepo = createImprovementProposalEvidenceRepo(ctx.db);
  const capabilitiesRepo = createLayerCapabilitiesRepo(ctx.db);

  // Capability snapshot for this layer. Phase 7.3 ships with no
  // built-in capabilities registered (that's phase 7.5); the
  // snapshot is `{ capabilities: [], builtins: [] }` for a fresh
  // layer. We still snapshot per-layer rows so layers that already
  // have activated capabilities (future runs) carry that context.
  const activeCapabilities = capabilitiesRepo.listActiveByLayer(layerId);
  const capabilitySnapshot: CapabilitySnapshot = {
    capabilities: activeCapabilities.map((c) => ({
      id: c.id,
      layerId: c.layerId,
      kind: c.kind,
      name: c.name,
      specJson: c.specJson,
      origin: c.origin,
      activatedAt: c.activatedAt,
      deactivatedAt: c.deactivatedAt,
    })),
    builtins: [],
  };
  const capabilitySnapshotJson = JSON.stringify(capabilitySnapshot);

  const feedbackByMessage = new Map(feedback.map((f) => [f.messageId, f]));
  const stepsByMessage = groupStepsByMessage(steps);

  const flowId = `proposal.mint:${ctx.run.id}`;
  let mintedCount = 0;
  let skippedCount = 0;

  for (const cluster of clusters) {
    ctx.logger.info('proposal.mint.cluster', {
      event: 'proposal.mint.cluster',
      layerId,
      reason: cluster.reason,
      messageCount: cluster.messageIds.length,
    });

    const snippets = new Map<string, string>();
    for (const messageId of cluster.messageIds) {
      const msg = messageById.get(messageId);
      if (msg === undefined) continue;
      snippets.set(messageId, truncate(msg.content, MAX_MESSAGE_SNIPPET_CHARS));
    }

    const result = await mintProposalViaLlm(ctx.llm, {
      cluster,
      capabilitySnapshot,
      layerId,
      messageSnippets: snippets,
      flowId,
      correlationId: ctx.correlationId,
    });

    if ('err' in result) {
      skippedCount += 1;
      ctx.logger.warn('proposal.mint.skipped', {
        event: 'proposal.mint.skipped',
        layerId,
        clusterReason: cluster.reason,
        errorCode: 'invalid_spec_output',
        error: clip(result.err.message),
        // Counter dim — bounded.
        'proposal.mint.skipped_count': 1,
        reason: 'invalid_spec_output',
      });
      continue;
    }

    const proposalId = crypto.randomUUID();
    const inserted = proposalsRepo.insertProposal({
      id: proposalId,
      layerId,
      status: 'new',
      artifactKind: result.ok.spec.artifactKind,
      problemSummary: cluster.summary,
      proposedSpecJson: JSON.stringify(result.ok.spec),
      expectedImpactJson: JSON.stringify(result.ok.expectedImpact),
      threshold: result.ok.threshold,
      capabilitySnapshotJson,
      mintedByRunId: ctx.run.id,
      mintedAt: ctx.now(),
    });

    evidenceRepo.insertMany(
      cluster.messageIds.map((messageId) => {
        const msg = messageById.get(messageId);
        const fb = feedbackByMessage.get(messageId);
        const msgSteps = stepsByMessage.get(messageId) ?? [];
        const retrievalStep = msgSteps.find((s) => s.kind === 'retrieval');
        const hitCount = parseRetrievalHitCountSafe(retrievalStep?.outputJson ?? null);
        const errorCode = msgSteps.find((s) => s.errorCode !== null)?.errorCode ?? null;
        const detail = {
          messageCreatedAt: msg?.createdAt ?? null,
          feedbackValue: fb?.value ?? null,
          retrievalHitCount: hitCount,
          errorCode,
        };
        return {
          id: crypto.randomUUID(),
          proposalId: inserted.id,
          messageId,
          clusterReason: cluster.reason,
          detailJson: JSON.stringify(detail),
        };
      }),
    );

    await publishProposalMinted(ctx.bus, ctx.correlationId, flowId, {
      proposalId: inserted.id,
      layerId,
      artifactKind: inserted.artifactKind,
      threshold: inserted.threshold,
      mintedByRunId: ctx.run.id,
    });

    mintedCount += 1;
    ctx.logger.info('proposal.mint.persist', {
      event: 'proposal.mint.persist',
      layerId,
      proposalId: inserted.id,
      artifactKind: inserted.artifactKind,
      threshold: inserted.threshold,
      clusterReason: cluster.reason,
      messageCount: cluster.messageIds.length,
      // Counter dim — bounded.
      'proposal.minted_count': 1,
    });
  }

  ctx.logger.info('proposal.mint.layer-summary', {
    event: 'proposal.mint.layer-summary',
    layerId,
    mintedCount,
    skippedCount,
    clusterCount: clusters.length,
    messageCount: messages.length,
  });
}

// ---------- helpers (private; raw SQL kept local to the handler) ------

function listActiveLayerIds(db: Database): readonly string[] {
  type Row = { id: string };
  return db
    .query<Row, []>('SELECT id FROM layers WHERE deleted_at IS NULL ORDER BY created_at ASC')
    .all()
    .map((r) => r.id);
}

function listMessagesInWindow(
  db: Database,
  layerId: string,
  fromIso: string,
  toIso: string,
): readonly (ClusterGrouperMessage & { content: string })[] {
  type Row = {
    id: string;
    correlation_id: string;
    created_at: string;
    content: string;
  };
  // Filter by `layer_id` via the conversations table. We focus on
  // `role='assistant'` messages because that's where pipeline state
  // (steps, feedback) attaches — user turns have no feedback in v1
  // and would skew the count.
  const rows = db
    .query<Row, [string, string, string]>(
      `SELECT m.id, m.correlation_id, m.created_at, m.content
         FROM chat_messages m
         JOIN chat_conversations c ON c.id = m.conversation_id
        WHERE c.layer_id = ?
          AND m.role = 'assistant'
          AND m.created_at >= ?
          AND m.created_at <= ?
          AND c.deleted_at IS NULL
        ORDER BY m.created_at ASC`,
    )
    .all(layerId, fromIso, toIso);
  return rows.map((r) => ({
    id: r.id,
    correlationId: r.correlation_id,
    createdAt: r.created_at,
    content: r.content,
  }));
}

function listFeedbackByMessageIds(
  db: Database,
  messageIds: readonly string[],
): readonly ClusterGrouperFeedback[] {
  if (messageIds.length === 0) return [];
  type Row = { message_id: string; value: 'up' | 'down' };
  const placeholders = messageIds.map(() => '?').join(', ');
  const sql = `SELECT message_id, value FROM chat_message_feedback WHERE message_id IN (${placeholders})`;
  const params: string[] = [...messageIds];
  const rows = db.query<Row, string[]>(sql).all(...params);
  return rows.map((r) => ({ messageId: r.message_id, value: r.value }));
}

function listStepsByMessageIds(
  db: Database,
  messageIds: readonly string[],
): readonly ClusterGrouperStep[] {
  if (messageIds.length === 0) return [];
  type Row = {
    id: string;
    message_id: string;
    kind: string;
    status: string;
    started_at: string;
    ended_at: string | null;
    output_json: string | null;
    error_code: string | null;
  };
  const placeholders = messageIds.map(() => '?').join(', ');
  const sql =
    'SELECT s.id, r.message_id AS message_id, s.kind, s.status, ' +
    's.started_at, s.ended_at, s.output_json, s.error_code ' +
    'FROM chat_pipeline_steps s ' +
    'JOIN chat_pipeline_runs r ON r.id = s.run_id ' +
    `WHERE r.message_id IN (${placeholders}) ` +
    'ORDER BY s.started_at ASC';
  const params: string[] = [...messageIds];
  const rows = db.query<Row, string[]>(sql).all(...params);
  return rows.map((r) => ({
    id: r.id,
    messageId: r.message_id,
    kind: r.kind,
    status: r.status,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    outputJson: r.output_json,
    errorCode: r.error_code,
  }));
}

function groupStepsByMessage(
  steps: readonly ClusterGrouperStep[],
): Map<string, readonly ClusterGrouperStep[]> {
  const out = new Map<string, ClusterGrouperStep[]>();
  for (const s of steps) {
    let arr = out.get(s.messageId);
    if (arr === undefined) {
      arr = [];
      out.set(s.messageId, arr);
    }
    arr.push(s);
  }
  return out;
}

function parseRetrievalHitCountSafe(outputJson: string | null): number | null {
  if (outputJson === null) return null;
  try {
    const parsed = JSON.parse(outputJson) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const obj = parsed as { hits?: unknown };
    if (!Array.isArray(obj.hits)) return null;
    return obj.hits.length;
  } catch {
    return null;
  }
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

function clip(text: string): string {
  return text.length > 500 ? `${text.slice(0, 497)}…` : text;
}

async function publishProposalMinted(
  bus: MessageBus,
  correlationId: string,
  flowId: string,
  payload: ProposalMintedPayload,
): Promise<void> {
  await bus.publish<ProposalMintedPayload>({
    type: PROPOSAL_MINTED_EVENT_TYPE,
    payload,
    correlationId,
    flowId,
  });
}
