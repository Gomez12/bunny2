/**
 * Phase 7.6 — `/l/:slug/proposals/*` HTTP routes.
 *
 * Sits behind the global `requireAuth` + `requirePasswordCurrent` +
 * `withEffectiveLayers` chain. Per-route mounting uses
 * `createRequireLayer()` so a non-member gets the same
 * `404 errors.layer.notVisible` response the rest of `/l/:slug/*`
 * uses (auth boundary; existing 404-on-not-visible policy).
 *
 * Five surfaces:
 *  - `GET    /l/:slug/proposals`                    — list summaries
 *  - `GET    /l/:slug/proposals/:id`                — detail + evidence + artifacts
 *  - `POST   /l/:slug/proposals/:id/approve`        — admin; calls `replanOnApproval`
 *  - `POST   /l/:slug/proposals/:id/reject`         — admin; body `{ reason }`
 *  - `POST   /l/:slug/proposals/:id/replay-sandbox` — admin; re-runs sandbox
 *
 * Authorization (plan §10):
 *  - GET routes: open to any user in `effectiveLayers`.
 *  - POST routes: gated by `canEditLayer`. A non-admin POST returns 403.
 *  - Cross-layer probes (a proposal id from another layer) return 404
 *    (mirrors the `errors.layer.notVisible` shape; never 403, never
 *    leaks the row's existence).
 *
 * Observability:
 *  - Every route logs `event: 'proposals.<route>.<status>'`.
 *  - `console.log('[chat.analytics] …')` placeholder primitive is the
 *    front-end's job; the server only emits structured logs.
 */

import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import { z } from 'zod';
import {
  ProposalSpecSchema,
  type CapabilitySnapshot,
  type ImprovementProposal,
  type ProposalSpec,
  type ProposalStatus,
} from '@bunny2/shared';
import { canEditLayer } from '../../layers/authz';
import { createRequireLayer } from '../middleware/layer';
import { ADMIN_GROUP_ID_KEY } from '../../auth/seed';
import { getMeta } from '../../storage/kv-meta';
import type { GroupResolver } from '../../auth/group-resolver';
import type { HonoVariables } from '../types';
import type { LlmClient } from '../../llm';
import {
  createImprovementProposalsRepo,
  type ImprovementProposalRow,
  type ProposalSortBy,
} from '../../proposals/repos/improvement-proposals-repo';
import { createImprovementProposalEvidenceRepo } from '../../proposals/repos/improvement-proposal-evidence-repo';
import { createImprovementProposalArtifactsRepo } from '../../proposals/repos/improvement-proposal-artifacts-repo';
import { createLayerCapabilitiesRepo } from '../../proposals/repos/layer-capabilities-repo';
import { createChatConversationsRepo } from '../../chat/repos/chat-conversations-repo';
import { createChatMessagesRepo } from '../../chat/repos/chat-messages-repo';
import {
  replanOnApproval,
  runSandbox,
  type CapabilityRegistry,
  type SandboxEvidenceInput,
} from '../../proposals';
import { PROPOSAL_REJECTED_EVENT_TYPE, type ProposalRejectedPayload } from '../../proposals/events';
import type { EntityKind, EntityStoreForRetrieval } from '../../chat/pipeline';

const BAD_REQUEST = { error: 'errors.proposals.badRequest' } as const;
const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;
const FORBIDDEN = { error: 'errors.layer.forbidden' } as const;
const NOT_FOUND = { error: 'errors.proposals.notFound' } as const;
const SANDBOX_FAILED = { error: 'errors.proposals.sandboxFailed' } as const;
const ALREADY_TERMINAL = { error: 'errors.proposals.alreadyTerminal' } as const;

const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 50;
const MAX_REASON_LEN = 500;

const ListQuerySchema = z
  .object({
    status: z
      .enum(['new', 'approved', 'rejected', 'superseded', 'activated', 'deactivated'])
      .optional(),
    sort: z.enum(['newest', 'impact', 'threshold']).optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  })
  .strict();

const RejectBodySchema = z
  .object({
    reason: z.string().min(1).max(MAX_REASON_LEN),
  })
  .strict();

const EmptyBodySchema = z.object({}).strict();

export interface LayerProposalsRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  readonly llm: LlmClient;
  readonly resolver: GroupResolver;
  readonly capabilityRegistry: CapabilityRegistry;
  readonly getEntityStore: (kind: EntityKind) => EntityStoreForRetrieval | null;
  readonly now?: () => Date;
}

/**
 * Compact projection used by the list endpoint. We deliberately do
 * NOT include the full spec / snapshot / impact bodies here — those
 * cross the wire only on the detail endpoint.
 */
interface ProposalSummary {
  readonly id: string;
  readonly layerId: string;
  readonly status: ProposalStatus;
  readonly artifactKind: 'tool' | 'skill' | 'agent';
  readonly problemSummary: string;
  readonly threshold: number;
  readonly mintedAt: string;
  /** Pre-extracted `expectedImpact.thumbsUpDelta` (0 when missing). */
  readonly thumbsUpDelta: number;
}

function summarize(row: ImprovementProposalRow): ProposalSummary {
  let thumbsUpDelta = 0;
  try {
    const impact = JSON.parse(row.expectedImpactJson) as { thumbsUpDelta?: number };
    if (typeof impact.thumbsUpDelta === 'number' && Number.isFinite(impact.thumbsUpDelta)) {
      thumbsUpDelta = impact.thumbsUpDelta;
    }
  } catch {
    /* keep 0 */
  }
  return {
    id: row.id,
    layerId: row.layerId,
    status: row.status,
    artifactKind: row.artifactKind,
    problemSummary: row.problemSummary,
    threshold: row.threshold,
    mintedAt: row.mintedAt,
    thumbsUpDelta,
  };
}

function materialiseProposal(row: ImprovementProposalRow): ImprovementProposal | null {
  const specParse = ProposalSpecSchema.safeParse(JSON.parse(row.proposedSpecJson));
  if (!specParse.success) return null;
  const spec: ProposalSpec = specParse.data;
  return {
    id: row.id,
    layerId: row.layerId,
    status: row.status,
    artifactKind: row.artifactKind,
    problemSummary: row.problemSummary,
    proposedSpec: spec,
    expectedImpact: JSON.parse(row.expectedImpactJson),
    threshold: row.threshold,
    capabilitySnapshot: JSON.parse(row.capabilitySnapshotJson) as CapabilitySnapshot,
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
}

export function registerLayerProposalsRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: LayerProposalsRouteDeps,
): void {
  const requireLayer = createRequireLayer();
  const clock = deps.now ?? ((): Date => new Date());
  const proposalsRepo = createImprovementProposalsRepo(deps.db);
  const evidenceRepo = createImprovementProposalEvidenceRepo(deps.db);
  const artifactsRepo = createImprovementProposalArtifactsRepo(deps.db);
  const conversationsRepo = createChatConversationsRepo(deps.db);
  const messagesRepo = createChatMessagesRepo(deps.db);

  function computeIsSiteAdmin(userId: string): boolean {
    const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY);
    if (adminGroupId === null || adminGroupId === '') return false;
    return deps.resolver.isUserInGroup(userId, adminGroupId);
  }

  // ---------- GET /l/:slug/proposals -------------------------------------

  app.get('/l/:slug/proposals', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const parsed = ListQuerySchema.safeParse(Object.fromEntries(new URL(c.req.url).searchParams));
    if (!parsed.success) {
      console.log('[proposals.list.bad-request]', {
        event: 'proposals.list.bad-request',
        layerId: layer.id,
        issues: parsed.error.issues.length,
      });
      return c.json(BAD_REQUEST, 400);
    }
    const { status, sort, limit, offset } = parsed.data;
    const sortBy: ProposalSortBy | undefined =
      sort === 'threshold' ? 'threshold' : sort === 'impact' ? 'impact' : 'mintedAt';
    const rows = proposalsRepo.listProposals({
      layerId: layer.id,
      ...(status !== undefined ? { status } : {}),
      sortBy,
      limit: limit ?? DEFAULT_LIST_LIMIT,
      offset: offset ?? 0,
    });
    const total = proposalsRepo.countProposals({
      layerId: layer.id,
      ...(status !== undefined ? { status } : {}),
    });
    console.log('[proposals.list.ok]', {
      event: 'proposals.list.ok',
      layerId: layer.id,
      count: rows.length,
      total,
    });
    return c.json({ items: rows.map(summarize), total });
  });

  // ---------- GET /l/:slug/proposals/:id ---------------------------------

  app.get('/l/:slug/proposals/:id', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const id = c.req.param('id');
    const row = proposalsRepo.getProposalById(id);
    // 404 on cross-layer / missing / soft-deleted; never 403.
    if (row === null || row.deletedAt !== null || row.layerId !== layer.id) {
      return c.json(NOT_FOUND, 404);
    }
    const evidenceRows = evidenceRepo.listByProposal(row.id);
    const artifactRows = artifactsRepo.listByProposal(row.id);
    // Enrich evidence with the user message + its conversation +
    // primary cluster context so the detail page can render
    // `[#m1] when do I meet Acmé?` lines without a second round-trip.
    const evidence = evidenceRows.map((e) => {
      const msg = messagesRepo.getMessageById(e.messageId);
      const conv = msg !== null ? conversationsRepo.getConversationById(msg.conversationId) : null;
      return {
        id: e.id,
        messageId: e.messageId,
        conversationId: msg?.conversationId ?? null,
        conversationTitle: conv?.title ?? null,
        clusterReason: e.clusterReason,
        detailJson: e.detailJson,
        messageContent: msg?.content ?? null,
        messageRole: msg?.role ?? null,
      };
    });
    console.log('[proposals.detail.ok]', {
      event: 'proposals.detail.ok',
      layerId: layer.id,
      proposalId: row.id,
      evidence: evidence.length,
      artifacts: artifactRows.length,
    });
    return c.json({
      proposal: {
        id: row.id,
        layerId: row.layerId,
        status: row.status,
        artifactKind: row.artifactKind,
        problemSummary: row.problemSummary,
        proposedSpec: JSON.parse(row.proposedSpecJson),
        expectedImpact: JSON.parse(row.expectedImpactJson),
        threshold: row.threshold,
        capabilitySnapshot: JSON.parse(row.capabilitySnapshotJson),
        mintedByRunId: row.mintedByRunId,
        mintedAt: row.mintedAt,
        approvedBy: row.approvedBy,
        approvedAt: row.approvedAt,
        rejectedBy: row.rejectedBy,
        rejectedAt: row.rejectedAt,
        rejectedReason: row.rejectedReason,
        activatedAt: row.activatedAt,
      },
      evidence,
      artifacts: artifactRows.map((a) => ({
        id: a.id,
        variant: a.variant,
        transcript: JSON.parse(a.transcriptJson),
        metrics: JSON.parse(a.metricsJson),
        ranAt: a.ranAt,
      })),
    });
  });

  // ---------- POST /l/:slug/proposals/:id/approve ------------------------

  app.post('/l/:slug/proposals/:id/approve', requireLayer, async (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    const id = c.req.param('id');
    const row = proposalsRepo.getProposalById(id);
    if (row === null || row.deletedAt !== null || row.layerId !== layer.id) {
      return c.json(NOT_FOUND, 404);
    }
    if (row.status !== 'new') {
      return c.json(ALREADY_TERMINAL, 409);
    }
    // Optional empty body — we accept either no body or `{}`.
    if ((await readOptionalBody(c, EmptyBodySchema)) === 'invalid') {
      return c.json(BAD_REQUEST, 400);
    }
    try {
      const outcome = await replanOnApproval(id, user.id, {
        proposalsRepo,
        evidenceRepo,
        artifactsRepo,
        layerCapabilitiesRepo: createLayerCapabilitiesRepo(deps.db),
        conversationsRepo,
        messagesRepo,
        bus: deps.bus,
        llm: deps.llm,
        db: deps.db,
        capabilityRegistry: deps.capabilityRegistry,
        getEntityStore: deps.getEntityStore,
        logger: makeLogger('proposals.approve'),
        clock,
      });
      console.log('[proposals.approve.ok]', {
        event: 'proposals.approve.ok',
        layerId: layer.id,
        proposalId: id,
        outcome: outcome.outcome,
      });
      return c.json(outcome);
    } catch (err) {
      console.error('[proposals.approve.failed]', {
        event: 'proposals.approve.failed',
        layerId: layer.id,
        proposalId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json({ error: 'errors.proposals.replanFailed' }, 500);
    }
  });

  // ---------- POST /l/:slug/proposals/:id/reject -------------------------

  app.post('/l/:slug/proposals/:id/reject', requireLayer, async (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    const id = c.req.param('id');
    const row = proposalsRepo.getProposalById(id);
    if (row === null || row.deletedAt !== null || row.layerId !== layer.id) {
      return c.json(NOT_FOUND, 404);
    }
    if (row.status !== 'new') {
      return c.json(ALREADY_TERMINAL, 409);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = RejectBodySchema.safeParse(raw);
    if (!parsed.success) return c.json(BAD_REQUEST, 400);
    const nowIso = clock().toISOString();
    proposalsRepo.updateStatus(id, {
      status: 'rejected',
      rejectedBy: user.id,
      rejectedAt: nowIso,
      rejectedReason: parsed.data.reason,
    });
    const payload: ProposalRejectedPayload = {
      proposalId: id,
      layerId: layer.id,
      rejectedBy: user.id,
    };
    void deps.bus.publish({
      type: PROPOSAL_REJECTED_EVENT_TYPE,
      payload,
    });
    console.log('[proposals.reject.ok]', {
      event: 'proposals.reject.ok',
      layerId: layer.id,
      proposalId: id,
    });
    return c.json({ status: 'rejected' as const, rejectedAt: nowIso });
  });

  // ---------- POST /l/:slug/proposals/:id/replay-sandbox -----------------

  app.post('/l/:slug/proposals/:id/replay-sandbox', requireLayer, async (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    const id = c.req.param('id');
    const row = proposalsRepo.getProposalById(id);
    if (row === null || row.deletedAt !== null || row.layerId !== layer.id) {
      return c.json(NOT_FOUND, 404);
    }
    if ((await readOptionalBody(c, EmptyBodySchema)) === 'invalid') {
      return c.json(BAD_REQUEST, 400);
    }
    const proposal = materialiseProposal(row);
    if (proposal === null) {
      return c.json({ error: 'errors.proposals.invalidSpec' }, 422);
    }
    const evidence: readonly SandboxEvidenceInput[] = evidenceRepo
      .listByProposal(row.id)
      .map((e) => ({ id: e.id, messageId: e.messageId, clusterReason: e.clusterReason }));
    try {
      const result = await runSandbox(proposal, evidence, {
        llm: deps.llm,
        db: deps.db,
        bus: deps.bus,
        capabilityRegistry: deps.capabilityRegistry,
        artifactsRepo,
        conversationsRepo,
        messagesRepo,
        getEntityStore: deps.getEntityStore,
        logger: makeLogger('proposals.replay-sandbox'),
        clock,
      });
      if ('err' in result) {
        console.log('[proposals.replay-sandbox.failed]', {
          event: 'proposals.replay-sandbox.failed',
          layerId: layer.id,
          proposalId: id,
          error: result.err.error,
        });
        return c.json({ error: 'errors.proposals.sandboxFailed', code: result.err.error }, 422);
      }
      console.log('[proposals.replay-sandbox.ok]', {
        event: 'proposals.replay-sandbox.ok',
        layerId: layer.id,
        proposalId: id,
        outcome: result.ok.outcome,
      });
      return c.json({
        outcome: result.ok.outcome,
        metrics: result.ok.metrics,
        variantArtifacts: result.ok.variantArtifacts,
      });
    } catch (err) {
      console.error('[proposals.replay-sandbox.error]', {
        event: 'proposals.replay-sandbox.error',
        layerId: layer.id,
        proposalId: id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(SANDBOX_FAILED, 500);
    }
  });
}

async function readOptionalBody(
  c: import('hono').Context,
  schema: z.ZodTypeAny,
): Promise<'ok' | 'invalid'> {
  const contentType = c.req.header('content-type') ?? '';
  if (!contentType.includes('application/json')) return 'ok';
  let raw: unknown = {};
  try {
    raw = await c.req.json();
  } catch {
    const len = c.req.header('content-length');
    if (len !== undefined && len !== '0') return 'invalid';
    return 'ok';
  }
  const parsed = schema.safeParse(raw);
  return parsed.success ? 'ok' : 'invalid';
}

function makeLogger(scope: string) {
  return {
    info: (msg: string, fields?: Readonly<Record<string, unknown>>): void =>
      console.log(`[${scope}] ${msg}`, fields ?? {}),
    warn: (msg: string, fields?: Readonly<Record<string, unknown>>): void =>
      console.warn(`[${scope}] ${msg}`, fields ?? {}),
    error: (msg: string, fields?: Readonly<Record<string, unknown>>): void =>
      console.error(`[${scope}] ${msg}`, fields ?? {}),
  };
}
