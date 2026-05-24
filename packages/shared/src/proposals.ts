import { z } from 'zod';
import { ChatIntentSchema } from './chat';

/**
 * Cross-package zod schemas for the improvement-proposal domain
 * (phase 7.2).
 *
 * Server-internal row types live under `apps/server/src/proposals/repos/*`;
 * these schemas describe the safe shape that crosses the HTTP boundary
 * and the LLM mint boundary. Timestamps are ISO-8601 strings, like the
 * rest of the shared package.
 *
 * The four entities mirror the four tables in
 * `apps/server/src/storage/migrations/0015_proposals.sql`:
 *
 *   - `ImprovementProposal`         — one per minted proposal; carries
 *                                     the capability snapshot at mint
 *                                     and the `threshold` phase 8 will
 *                                     consume.
 *   - `ImprovementProposalEvidence` — FK from proposal to
 *                                     `chat_messages.id` with the
 *                                     cluster reason.
 *   - `ImprovementProposalArtifact` — sandbox replay transcript +
 *                                     metrics (variant ∈
 *                                     current | proposed | replanned).
 *   - `LayerCapability`             — per-layer registry of activated
 *                                     tools / skills / agents.
 *
 * Enums and discriminated unions are closed sets and must match the
 * SQL CHECK constraints and the registered handler kinds exactly; a
 * drift would let the zod boundary accept rows the storage layer (or
 * the activation registry) rejects. See ADR 0023.
 */

// ---------- enums ------------------------------------------------------

export const ProposalStatusSchema = z.enum([
  'new',
  'approved',
  'rejected',
  'superseded',
  'activated',
  'deactivated',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;
export const proposalStatusEnum = ProposalStatusSchema;

export const ArtifactKindSchema = z.enum(['tool', 'skill', 'agent']);
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export const artifactKindEnum = ArtifactKindSchema;

/**
 * The closed set of failure modes the cluster grouper (phase 7.3)
 * may tag evidence with. Mirrors plan §4.3 + ADR 0025 §2
 * `failureModeTags`. The review-agent LLM is constrained to address
 * one or more of these tags in every `ProposalSpec`.
 */
export const ClusterReasonSchema = z.enum([
  'zero-hit-retrieval',
  'thumbs-down',
  'invalid-step-output',
  'latency-over-budget',
  'repeated-error-code',
]);
export type ClusterReason = z.infer<typeof ClusterReasonSchema>;
export const clusterReasonEnum = ClusterReasonSchema;

export const ArtifactVariantSchema = z.enum(['current', 'proposed', 'replanned']);
export type ArtifactVariant = z.infer<typeof ArtifactVariantSchema>;

// ---------- expected impact -------------------------------------------

export const ExpectedImpactSchema = z
  .object({
    thumbsUpDelta: z.number(),
    tokensDelta: z.number(),
    latencyDeltaMs: z.number(),
  })
  .strict();
export type ExpectedImpact = z.infer<typeof ExpectedImpactSchema>;
export const expectedImpactSchema = ExpectedImpactSchema;

// ---------- artifact spec (discriminated union by artifactKind) -------

/**
 * Tool handler kinds — closed enum. The proposal LLM is constrained at
 * mint time to emit only handler kinds in this set; the activation
 * registry defensively re-checks. Adding a kind is an explicit code
 * change in a future sub-phase (ADR 0023 §2).
 */
export const ToolHandlerKindSchema = z.enum(['searchSummaries-aliased', 'projection-lookup']);
export type ToolHandlerKind = z.infer<typeof ToolHandlerKindSchema>;

export const ToolHandlerSchema = z
  .object({
    kind: ToolHandlerKindSchema,
    config: z.record(z.unknown()),
  })
  .strict();
export type ToolHandler = z.infer<typeof ToolHandlerSchema>;

export const AgentHandlerKindSchema = z.enum(['enrichment-call', 'summary-call']);
export type AgentHandlerKind = z.infer<typeof AgentHandlerKindSchema>;

export const AgentHandlerSchema = z
  .object({
    kind: AgentHandlerKindSchema,
    config: z.record(z.unknown()),
  })
  .strict();
export type AgentHandler = z.infer<typeof AgentHandlerSchema>;

export const ToolProposalSpecSchema = z
  .object({
    artifactKind: z.literal('tool'),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    jsonSchema: z.record(z.unknown()),
    handler: ToolHandlerSchema,
    addressesTags: z.array(ClusterReasonSchema).min(1),
  })
  .strict();
export type ToolProposalSpec = z.infer<typeof ToolProposalSpecSchema>;

export const SkillProposalSpecSchema = z
  .object({
    artifactKind: z.literal('skill'),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    intent: ChatIntentSchema,
    promptFragment: z.string().min(1).max(4000),
    addressesTags: z.array(ClusterReasonSchema).min(1),
  })
  .strict();
export type SkillProposalSpec = z.infer<typeof SkillProposalSpecSchema>;

export const AgentProposalSpecSchema = z
  .object({
    artifactKind: z.literal('agent'),
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1000),
    subscribesTo: z.array(z.string().min(1)).min(1),
    handler: AgentHandlerSchema,
    addressesTags: z.array(ClusterReasonSchema).min(1),
  })
  .strict();
export type AgentProposalSpec = z.infer<typeof AgentProposalSpecSchema>;

export const ProposalSpecSchema = z.discriminatedUnion('artifactKind', [
  ToolProposalSpecSchema,
  SkillProposalSpecSchema,
  AgentProposalSpecSchema,
]);
export type ProposalSpec = z.infer<typeof ProposalSpecSchema>;
export const proposalSpecSchema = ProposalSpecSchema;

// ---------- layer capability (registry row) ---------------------------

/**
 * `origin` is the literal `'builtin'` or the prefixed
 * `'proposal:<uuid>'`. The zod schema validates the literal-or-prefix
 * shape; the row in `layer_capabilities` stores the same string verbatim.
 */
export const LayerCapabilityOriginSchema = z
  .string()
  .refine((value) => value === 'builtin' || /^proposal:[0-9a-fA-F-]{36}$/.test(value), {
    message: 'origin must be "builtin" or "proposal:<uuid>"',
  });

export const LayerCapabilitySchema = z
  .object({
    id: z.string().uuid(),
    layerId: z.string().uuid(),
    kind: ArtifactKindSchema,
    name: z.string().min(1).max(120),
    specJson: z.string(),
    origin: LayerCapabilityOriginSchema,
    activatedAt: z.string(),
    deactivatedAt: z.string().nullable(),
  })
  .strict();
export type LayerCapability = z.infer<typeof LayerCapabilitySchema>;
export const layerCapabilitySchema = LayerCapabilitySchema;

// ---------- capability snapshot (stored on every proposal) ------------

/**
 * The snapshot recorded at mint time. ADR 0023 §4 says
 * "JSON.stringify(layerCapabilities.list(layerId, { activeOnly: true }))
 *  plus the built-in capability list (constant array)". Two arrays here:
 *  the active per-layer capabilities and the built-in list. Re-plan
 *  (phase 7.4 / ADR 0025) reads both halves.
 */
export const CapabilitySnapshotSchema = z
  .object({
    capabilities: z.array(LayerCapabilitySchema),
    builtins: z.array(LayerCapabilitySchema),
  })
  .strict();
export type CapabilitySnapshot = z.infer<typeof CapabilitySnapshotSchema>;
export const capabilitySnapshotSchema = CapabilitySnapshotSchema;

// ---------- proposal row ----------------------------------------------

export const ImprovementProposalSchema = z
  .object({
    id: z.string().uuid(),
    layerId: z.string().uuid(),
    status: ProposalStatusSchema,
    artifactKind: ArtifactKindSchema,
    problemSummary: z.string().min(1),
    proposedSpec: ProposalSpecSchema,
    expectedImpact: ExpectedImpactSchema,
    threshold: z.number().min(0).max(1),
    capabilitySnapshot: CapabilitySnapshotSchema,
    mintedByRunId: z.string().min(1),
    mintedAt: z.string(),
    approvedBy: z.string().uuid().nullable(),
    approvedAt: z.string().nullable(),
    rejectedBy: z.string().uuid().nullable(),
    rejectedAt: z.string().nullable(),
    rejectedReason: z.string().nullable(),
    activatedAt: z.string().nullable(),
    deletedAt: z.string().nullable(),
    deletedBy: z.string().uuid().nullable(),
  })
  .strict();
export type ImprovementProposal = z.infer<typeof ImprovementProposalSchema>;
export const improvementProposalSchema = ImprovementProposalSchema;

// ---------- evidence row ----------------------------------------------

export const ProposalEvidenceSchema = z
  .object({
    id: z.string().uuid(),
    proposalId: z.string().uuid(),
    messageId: z.string().uuid(),
    clusterReason: ClusterReasonSchema,
    detailJson: z.string().nullable(),
  })
  .strict();
export type ProposalEvidence = z.infer<typeof ProposalEvidenceSchema>;
export const proposalEvidenceSchema = ProposalEvidenceSchema;

// ---------- artifact (sandbox replay transcript) ----------------------

export const ProposalArtifactSchema = z
  .object({
    id: z.string().uuid(),
    proposalId: z.string().uuid(),
    variant: ArtifactVariantSchema,
    transcriptJson: z.string(),
    metricsJson: z.string(),
    ranAt: z.string(),
  })
  .strict();
export type ProposalArtifact = z.infer<typeof ProposalArtifactSchema>;
export const proposalArtifactSchema = ProposalArtifactSchema;

// ---------- phase 8.1 — layer proposal settings -----------------------

/**
 * Per-layer auto-activation knobs. Mirrors the SQL CHECK constraints
 * on `layer_proposal_settings`
 * (`apps/server/src/storage/migrations/0017_proposals_phase8.sql`):
 * `thresholdCutoff` in [0, 1], `cooldownHours` in [0, 720],
 * `maxTokensDelta` ≥ 0 when not null. Plan §4.1 + ADR 0026 §1.
 */
export const LayerProposalSettingsSchema = z.object({
  layerId: z.string().min(1),
  autoActivationEnabled: z.boolean(),
  thresholdCutoff: z.number().min(0).max(1),
  cooldownHours: z.number().int().min(0).max(720),
  requireThumbsUpDeltaPositive: z.boolean(),
  maxTokensDelta: z.number().int().min(0).nullable(),
  updatedAt: z.string().min(1),
  updatedBy: z.string().min(1),
});
export type LayerProposalSettings = z.infer<typeof LayerProposalSettingsSchema>;

/**
 * Input shape for `PUT /l/:slug/settings/proposals` (lands in 8.4).
 * The server fills `layerId` from the route, and `updatedAt` /
 * `updatedBy` from `ctx.now()` / the session user.
 */
export const LayerProposalSettingsInputSchema = LayerProposalSettingsSchema.pick({
  autoActivationEnabled: true,
  thresholdCutoff: true,
  cooldownHours: true,
  requireThumbsUpDeltaPositive: true,
  maxTokensDelta: true,
});
export type LayerProposalSettingsInput = z.infer<typeof LayerProposalSettingsInputSchema>;

// ---------- phase 8.1 — auto-activation decision JSON -----------------

/**
 * One gate's record in the auto-activation decision JSON
 * (ADR 0026 §1). The full record list is written verbatim to
 * `improvement_proposals.auto_activation_decision_json` so both
 * the UI and telemetry can render the evaluation in order.
 */
export const AutoActivationGateRecordSchema = z.object({
  name: z.string().min(1),
  passed: z.boolean(),
  detail: z.record(z.unknown()).optional(),
});
export type AutoActivationGateRecord = z.infer<typeof AutoActivationGateRecordSchema>;

/**
 * Closed enum of rejection reasons the gate may return
 * (ADR 0026 §1). Telemetry dimension `rejectionReason` uses this
 * enum verbatim, keeping cardinality bounded.
 */
export const AutoActivationRejectionSchema = z.enum([
  'auto-activation-disabled',
  'cooldown-not-elapsed',
  'threshold-below-cutoff',
  'sandbox-outcome-not-ok',
  'thumbs-up-delta-non-positive',
  'tokens-delta-over-cap',
  'no-sandbox-evidence',
]);
export type AutoActivationRejection = z.infer<typeof AutoActivationRejectionSchema>;

/**
 * The decision JSON written to
 * `improvement_proposals.auto_activation_decision_json` before
 * `replanOnApproval` runs (ADR 0026 §4). The gate function (lands
 * in 8.2) returns this exact shape; the auto-activate job (lands
 * in 8.3) serializes it.
 */
export const AutoActivationDecisionSchema = z.discriminatedUnion('outcome', [
  z.object({
    outcome: z.literal('eligible'),
    gates: z.array(AutoActivationGateRecordSchema),
  }),
  z.object({
    outcome: z.literal('rejected'),
    reason: AutoActivationRejectionSchema,
    gates: z.array(AutoActivationGateRecordSchema),
  }),
]);
export type AutoActivationDecision = z.infer<typeof AutoActivationDecisionSchema>;
