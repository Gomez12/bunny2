/**
 * Phase 7.4 — sandbox message replay.
 *
 * Replays one evidence message through the live chat pipeline against
 * a **scratch in-memory database** so that ADR 0024 §5 holds: the
 * sandbox writes nothing to production storage (no `chat_messages`,
 * no `chat_pipeline_runs`, no `chat_pipeline_steps`, no
 * `chat_message_feedback`, no LLM-call rows). The only durable side
 * effects of a sandbox run are the two `improvement_proposal_artifacts`
 * rows the runner writes against the production DB.
 *
 * Approach:
 *   1. Open a fresh `:memory:` `bun:sqlite` Database; apply every
 *      migration in `MIGRATIONS`. The schema is identical to
 *      production — including the `chat_*` tables `runPipeline`
 *      writes into.
 *   2. Copy the evidence message's conversation row + the user row +
 *      the last-20-turn history slice across into the scratch DB
 *      (mirrors the phase-6 history cap from ADR 0020).
 *   3. Build orchestrator repos against the scratch DB and an
 *      `InMemoryMessageBus` (so the `chat.*` bus events the
 *      orchestrator emits don't leak to the production bus —
 *      reviewer feedback).
 *   4. Run `runPipeline(...)` with the supplied `entityVectorSearch`
 *      adapter, the supplied `LlmClient`, and a hard 10 s timeout per
 *      message (ADR 0024 §3).
 *   5. Read the resulting assistant row + retrieval step row back
 *      from the scratch DB to assemble a `MessageReplayResult`.
 *   6. Drop the scratch DB.
 *
 * The 7.4 brief mandates a `capabilityRegistry?` seam on
 * `RunPipelineDeps`. The orchestrator does NOT consult it yet (the
 * answerer / retrieval consumers land in 7.5) — so the runner passes
 * it but both `current` and `proposed` variants produce identical
 * transcripts under the same scripted LLM. The synthetic thumbs-score
 * heuristic in `metrics.ts` is the deterministic bridge until 7.5
 * lands.
 */

import { Database } from 'bun:sqlite';
import { InMemoryMessageBus } from '@bunny2/bus/test-utils';
import type { ClusterReason } from '@bunny2/shared';
import { applyMigrations } from '../../storage/migrations';
import { MIGRATIONS } from '../../storage/sqlite';
import { createSqliteLlmCallLog } from '../../llm/call-log';
import { createChatConversationsRepo } from '../../chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../../chat/repos/chat-messages-repo';
import { createChatPipelineRunsRepo } from '../../chat/repos/chat-pipeline-runs-repo';
import { createChatPipelineStepsRepo } from '../../chat/repos/chat-pipeline-steps-repo';
import { runPipeline, type EntityKind, type EntityStoreForRetrieval } from '../../chat/pipeline';
import type { LlmClient } from '../../llm';
import type { CapabilityRegistry } from '../capability-registry';
import type { MessageReplayResult, SandboxOutcome } from './types';

/**
 * Per-message replay budget (ADR 0024 §3). Total per-proposal
 * wall-clock is bounded at 5 messages × 2 variants × 10 s = 100 s.
 */
export const REPLAY_TIMEOUT_MS = 10_000;

/**
 * Mirror of the orchestrator's `HISTORY_TURN_CAP` (ADR 0020).
 * Re-stated here so the replay slice + the orchestrator's slice agree.
 */
export const HISTORY_TURN_CAP = 20;

export interface ReplayEvidenceMessage {
  readonly messageId: string;
  readonly conversationId: string;
  readonly layerId: string;
  readonly userId: string;
  readonly userContent: string;
  /**
   * Cluster reason tagged on the evidence row (mirrors
   * `improvement_proposal_evidence.cluster_reason`). The runner uses
   * this to feed the metrics heuristic; the replay itself is
   * cluster-agnostic.
   */
  readonly clusterReason?: ClusterReason;
}

export interface PriorTurn {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly createdAt: string;
}

export interface ReplayInput {
  readonly evidence: ReplayEvidenceMessage;
  /** Last-20 history turns from the production conversation,
   *  excluding the user message being replayed. Caller owns the cap. */
  readonly history: readonly PriorTurn[];
  readonly conversationTitle: string;
  readonly conversationLocale: string;
}

export interface ReplayDeps {
  readonly llm: LlmClient;
  readonly getEntityStore: (kind: EntityKind) => EntityStoreForRetrieval | null;
  readonly capabilityRegistry?: CapabilityRegistry;
  readonly clock?: () => Date;
  readonly logger?: {
    info(msg: string, fields?: Readonly<Record<string, unknown>>): void;
    warn(msg: string, fields?: Readonly<Record<string, unknown>>): void;
    error(msg: string, fields?: Readonly<Record<string, unknown>>): void;
  };
}

/**
 * Replay one evidence message. Returns the per-message replay result.
 * `sandboxOutcome` is `'ok'` on a successful pipeline run (regardless
 * of pipeline-internal `status`), `'timeout'` when the per-message
 * 10 s budget is exceeded, `'error'` when an unexpected throw escapes.
 */
export async function replayMessage(
  input: ReplayInput,
  deps: ReplayDeps,
): Promise<{ readonly result: MessageReplayResult; readonly outcome: SandboxOutcome }> {
  const clock = deps.clock ?? ((): Date => new Date());

  // `:memory:` DBs are per-Database-instance; each replay gets its
  // own (no cross-replay state leak). Migrations are idempotent.
  const scratchDb = new Database(':memory:');
  scratchDb.exec('PRAGMA foreign_keys = ON');
  applyMigrations(scratchDb, MIGRATIONS);

  try {
    seedScratch(scratchDb, input);
    const startedAtMs = clock().getTime();
    const bus = new InMemoryMessageBus();
    const conversationsRepo = createChatConversationsRepo(scratchDb);
    const messagesRepo = createChatMessagesRepo(scratchDb);
    const runsRepo = createChatPipelineRunsRepo(scratchDb);
    const stepsRepo = createChatPipelineStepsRepo(scratchDb);
    const llmCallLog = createSqliteLlmCallLog(scratchDb);

    const correlationId = crypto.randomUUID();
    const flowId = `proposal.sandbox.replay:${input.evidence.messageId}`;

    let outcome: SandboxOutcome = 'ok';
    let assistantContent = '';
    let status: 'done' | 'failed' = 'failed';
    let errorCode: string | undefined;
    let runId = '';
    try {
      const runResult = await runWithTimeout(
        () =>
          runPipeline(
            {
              conversationId: input.evidence.conversationId,
              userMessageId: input.evidence.messageId,
              userContent: input.evidence.userContent,
              layerId: input.evidence.layerId,
              effectiveLayerIds: [input.evidence.layerId],
              userId: input.evidence.userId,
              correlationId,
              flowId,
            },
            {
              db: scratchDb,
              bus,
              llm: deps.llm,
              llmCallLog,
              conversationsRepo,
              messagesRepo,
              runsRepo,
              stepsRepo,
              getEntityStore: deps.getEntityStore,
              ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
            },
          ),
        REPLAY_TIMEOUT_MS,
      );
      assistantContent = runResult.assistantContent;
      status = runResult.status;
      runId = runResult.runId;
      if (runResult.errorCode !== undefined) errorCode = runResult.errorCode;
    } catch (err) {
      if (err instanceof TimeoutError) {
        outcome = 'timeout';
        errorCode = 'sandbox_timeout';
        deps.logger?.warn?.('proposal.sandbox.timeout', {
          event: 'proposal.sandbox.timeout',
          messageId: input.evidence.messageId,
          timeoutMs: REPLAY_TIMEOUT_MS,
        });
      } else {
        outcome = 'error';
        errorCode = 'sandbox_error';
        deps.logger?.warn?.('proposal.sandbox.error', {
          event: 'proposal.sandbox.error',
          messageId: input.evidence.messageId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    const latencyMs = Math.max(0, clock().getTime() - startedAtMs);
    const { tokensIn, tokensOut, hitCount } = readReplayMetrics(scratchDb, runId);

    return {
      result: {
        messageId: input.evidence.messageId,
        userContent: input.evidence.userContent,
        assistantContent,
        status,
        ...(errorCode !== undefined ? { errorCode } : {}),
        tokensIn,
        tokensOut,
        latencyMs,
        retrievalHitCount: hitCount,
        ...(input.evidence.clusterReason !== undefined
          ? { clusterReason: input.evidence.clusterReason }
          : {}),
      },
      outcome,
    };
  } finally {
    scratchDb.close();
  }
}

/**
 * Copy the conversation row + the user message + the prior-turn
 * history into the scratch DB. The conversation row carries the
 * layer id; the orchestrator hands it forward via `effectiveLayerIds`
 * so the auth boundary still applies to the replay's retrieval calls.
 *
 * Note: we do NOT copy the production `chat_message_feedback` /
 * `chat_pipeline_steps` rows — the orchestrator generates its own
 * during the replay.
 */
function seedScratch(scratchDb: Database, input: ReplayInput): void {
  // Insert a synthetic user row so the conversation FK is satisfied
  // (the orchestrator validates that `users(id)` exists when it
  // touches conversation rows). We use the production `userId` so
  // any future audit log carries the real owner.
  const nowIso = new Date().toISOString();
  scratchDb
    .query<unknown, [string, string, string, string, string, string]>(
      `INSERT INTO users (id, username, display_name, password_hash, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      input.evidence.userId,
      `sandbox-${input.evidence.userId.slice(0, 8)}`,
      'sandbox',
      '!sandbox',
      nowIso,
      nowIso,
    );

  // Layer row — bare minimum so the conversation FK holds. We tag it
  // `everyone` type because the auth boundary on retrieval keys off
  // the `layer_id` filter, not the layer type.
  scratchDb
    .query<unknown, [string, string, string, string, string]>(
      `INSERT INTO layers (id, type, slug, name, created_at, updated_at)
       VALUES (?, 'everyone', ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .run(
      input.evidence.layerId,
      `sandbox-${input.evidence.layerId.slice(0, 8)}`,
      'Sandbox',
      nowIso,
      nowIso,
    );

  // Conversation row.
  scratchDb
    .query<unknown, [string, string, string, string, string, string, string]>(
      `INSERT INTO chat_conversations (id, layer_id, user_id, title, locale, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.evidence.conversationId,
      input.evidence.layerId,
      input.evidence.userId,
      input.conversationTitle.slice(0, 200),
      input.conversationLocale,
      nowIso,
      nowIso,
    );

  // Prior-turn history (capped at HISTORY_TURN_CAP by caller).
  const insertMsg = scratchDb.query<
    unknown,
    [string, string, string, string, string, string, string]
  >(
    `INSERT INTO chat_messages
       (id, conversation_id, role, content, status, correlation_id, flow_id, created_at)
     VALUES (?, ?, ?, ?, 'done', ?, ?, ?)`,
  );
  const corr = crypto.randomUUID();
  for (const turn of input.history) {
    insertMsg.run(
      turn.id,
      input.evidence.conversationId,
      turn.role,
      turn.content,
      corr,
      input.evidence.conversationId,
      turn.createdAt,
    );
  }
  // The user message being replayed. The orchestrator expects this
  // row to already exist (per its phase-6 contract).
  insertMsg.run(
    input.evidence.messageId,
    input.evidence.conversationId,
    'user',
    input.evidence.userContent,
    corr,
    input.evidence.conversationId,
    nowIso,
  );
}

/**
 * Read replay-time tokens + retrieval-hit count from the scratch DB.
 * Tokens come from the answerer's assistant message row; the retrieval
 * step's `output_json` carries the hits array.
 */
function readReplayMetrics(
  scratchDb: Database,
  runId: string,
): { readonly tokensIn: number; readonly tokensOut: number; readonly hitCount: number } {
  let tokensIn = 0;
  let tokensOut = 0;
  let hitCount = 0;
  if (runId.length === 0) {
    return { tokensIn, tokensOut, hitCount };
  }
  const runRow = scratchDb
    .query<
      { message_id: string },
      [string]
    >('SELECT message_id FROM chat_pipeline_runs WHERE id = ?')
    .get(runId);
  if (runRow !== null) {
    const msgRow = scratchDb
      .query<
        { tokens_in: number | null; tokens_out: number | null },
        [string]
      >('SELECT tokens_in, tokens_out FROM chat_messages WHERE id = ?')
      .get(runRow.message_id);
    if (msgRow !== null) {
      tokensIn = msgRow.tokens_in ?? 0;
      tokensOut = msgRow.tokens_out ?? 0;
    }
  }
  const retrievalRow = scratchDb
    .query<
      { output_json: string | null },
      [string]
    >(`SELECT output_json FROM chat_pipeline_steps WHERE run_id = ? AND kind = 'retrieval' ORDER BY attempt DESC LIMIT 1`)
    .get(runId);
  if (retrievalRow?.output_json !== undefined && retrievalRow.output_json !== null) {
    try {
      const parsed = JSON.parse(retrievalRow.output_json) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        const obj = parsed as { hits?: unknown };
        if (Array.isArray(obj.hits)) hitCount = obj.hits.length;
      }
    } catch {
      /* swallow — synthetic 0 */
    }
  }
  return { tokensIn, tokensOut, hitCount };
}

class TimeoutError extends Error {
  constructor() {
    super('sandbox replay timed out');
    this.name = 'TimeoutError';
  }
}

async function runWithTimeout<T>(fn: () => Promise<T>, timeoutMs: number): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new TimeoutError());
    }, timeoutMs);
    fn().then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
