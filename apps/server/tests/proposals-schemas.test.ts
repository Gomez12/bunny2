import { describe, expect, it } from 'bun:test';
import {
  AgentProposalSpecSchema,
  ArtifactKindSchema,
  CapabilitySnapshotSchema,
  ClusterReasonSchema,
  ExpectedImpactSchema,
  ImprovementProposalSchema,
  LayerCapabilitySchema,
  ProposalArtifactSchema,
  ProposalEvidenceSchema,
  ProposalSpecSchema,
  ProposalStatusSchema,
  SkillProposalSpecSchema,
  ToolProposalSpecSchema,
} from '@bunny2/shared';

/**
 * Phase 7.2 — zod schemas for the proposal contract round-trip and
 * reject invalid handler kinds / cluster reasons / threshold bounds.
 *
 * The schemas pin the closed enums ADR 0023 §2 mandates; a drift
 * between the SQL CHECK constraints and these schemas would let the
 * boundary accept rows the storage layer rejects.
 */

const sampleSnapshot = { capabilities: [], builtins: [] };

describe('proposals zod enums', () => {
  it('accepts every status value defined in ADR 0023 §5', () => {
    for (const status of [
      'new',
      'approved',
      'rejected',
      'superseded',
      'activated',
      'deactivated',
    ] as const) {
      expect(ProposalStatusSchema.parse(status)).toBe(status);
    }
  });

  it('rejects an unknown proposal status', () => {
    expect(() => ProposalStatusSchema.parse('queued')).toThrow();
  });

  it('accepts every artifact kind from the closed enum', () => {
    for (const kind of ['tool', 'skill', 'agent'] as const) {
      expect(ArtifactKindSchema.parse(kind)).toBe(kind);
    }
  });

  it('accepts every cluster reason from plan §4.3 and rejects unknowns', () => {
    for (const reason of [
      'zero-hit-retrieval',
      'thumbs-down',
      'invalid-step-output',
      'latency-over-budget',
      'repeated-error-code',
    ] as const) {
      expect(ClusterReasonSchema.parse(reason)).toBe(reason);
    }
    expect(() => ClusterReasonSchema.parse('user-confused')).toThrow();
  });
});

describe('ProposalSpec — tool artifact kind', () => {
  it('round-trips a valid tool spec with a known handler kind', () => {
    const spec = {
      artifactKind: 'tool' as const,
      name: 'calendar-week-lookup',
      description: 'Look up calendar events for the current week.',
      jsonSchema: { type: 'object', properties: {} },
      handler: {
        kind: 'searchSummaries-aliased' as const,
        config: { entityKind: 'calendar_event' },
      },
      addressesTags: ['zero-hit-retrieval' as const],
    };
    const parsed = ToolProposalSpecSchema.parse(spec);
    expect(parsed.name).toBe('calendar-week-lookup');
    expect(ProposalSpecSchema.parse(spec).artifactKind).toBe('tool');
  });

  it('rejects an unknown tool handler kind', () => {
    expect(() =>
      ToolProposalSpecSchema.parse({
        artifactKind: 'tool',
        name: 'bad',
        description: 'd',
        jsonSchema: {},
        handler: { kind: 'arbitrary-code', config: {} },
        addressesTags: ['zero-hit-retrieval'],
      }),
    ).toThrow();
  });

  it('requires at least one addressed cluster reason', () => {
    expect(() =>
      ToolProposalSpecSchema.parse({
        artifactKind: 'tool',
        name: 'x',
        description: 'd',
        jsonSchema: {},
        handler: { kind: 'projection-lookup', config: {} },
        addressesTags: [],
      }),
    ).toThrow();
  });
});

describe('ProposalSpec — skill artifact kind', () => {
  it('round-trips a valid skill spec with an intent from the shared chat enum', () => {
    const spec = {
      artifactKind: 'skill' as const,
      name: 'expand-acme-alias',
      description: 'Expand the Acmé alias to Acme.',
      intent: 'question.entity_lookup' as const,
      promptFragment: 'If the user writes Acmé, also search for Acme.',
      addressesTags: ['zero-hit-retrieval' as const],
    };
    expect(SkillProposalSpecSchema.parse(spec).intent).toBe('question.entity_lookup');
    expect(ProposalSpecSchema.parse(spec).artifactKind).toBe('skill');
  });

  it('rejects a skill spec carrying an intent outside the chat intent enum', () => {
    expect(() =>
      SkillProposalSpecSchema.parse({
        artifactKind: 'skill',
        name: 'x',
        description: 'd',
        intent: 'question.universe',
        promptFragment: 'x',
        addressesTags: ['zero-hit-retrieval'],
      }),
    ).toThrow();
  });
});

describe('ProposalSpec — agent artifact kind', () => {
  it('round-trips a valid agent spec with a known handler kind', () => {
    const spec = {
      artifactKind: 'agent' as const,
      name: 'meeting-summariser',
      description: 'Summarise new calendar events as they land.',
      subscribesTo: ['entity.created'],
      handler: { kind: 'summary-call' as const, config: { model: 'mock' } },
      addressesTags: ['latency-over-budget' as const],
    };
    expect(AgentProposalSpecSchema.parse(spec).subscribesTo).toEqual(['entity.created']);
    expect(ProposalSpecSchema.parse(spec).artifactKind).toBe('agent');
  });

  it('rejects an unknown agent handler kind', () => {
    expect(() =>
      AgentProposalSpecSchema.parse({
        artifactKind: 'agent',
        name: 'x',
        description: 'd',
        subscribesTo: ['entity.created'],
        handler: { kind: 'eval-code', config: {} },
        addressesTags: ['zero-hit-retrieval'],
      }),
    ).toThrow();
  });

  it('rejects an agent spec with an empty subscription list', () => {
    expect(() =>
      AgentProposalSpecSchema.parse({
        artifactKind: 'agent',
        name: 'x',
        description: 'd',
        subscribesTo: [],
        handler: { kind: 'summary-call', config: {} },
        addressesTags: ['zero-hit-retrieval'],
      }),
    ).toThrow();
  });
});

describe('ExpectedImpact + CapabilitySnapshot', () => {
  it('accepts deltas in any direction (positive, zero, negative)', () => {
    expect(
      ExpectedImpactSchema.parse({ thumbsUpDelta: -0.05, tokensDelta: 0, latencyDeltaMs: 200 }),
    ).toBeTruthy();
  });

  it('requires both halves of the capability snapshot', () => {
    expect(CapabilitySnapshotSchema.parse(sampleSnapshot)).toBeTruthy();
    expect(() => CapabilitySnapshotSchema.parse({ capabilities: [] })).toThrow();
  });
});

describe('ImprovementProposal row schema', () => {
  it('rejects a threshold outside [0, 1]', () => {
    const base = {
      id: crypto.randomUUID(),
      layerId: crypto.randomUUID(),
      status: 'new' as const,
      artifactKind: 'skill' as const,
      problemSummary: 's',
      proposedSpec: {
        artifactKind: 'skill' as const,
        name: 'x',
        description: 'd',
        intent: 'question.entity_lookup' as const,
        promptFragment: 'p',
        addressesTags: ['zero-hit-retrieval' as const],
      },
      expectedImpact: { thumbsUpDelta: 0, tokensDelta: 0, latencyDeltaMs: 0 },
      capabilitySnapshot: sampleSnapshot,
      mintedByRunId: 'run-1',
      mintedAt: new Date().toISOString(),
      approvedBy: null,
      approvedAt: null,
      rejectedBy: null,
      rejectedAt: null,
      rejectedReason: null,
      activatedAt: null,
      deletedAt: null,
      deletedBy: null,
    };
    expect(ImprovementProposalSchema.parse({ ...base, threshold: 0.5 })).toBeTruthy();
    expect(() => ImprovementProposalSchema.parse({ ...base, threshold: 1.5 })).toThrow();
    expect(() => ImprovementProposalSchema.parse({ ...base, threshold: -0.1 })).toThrow();
  });
});

describe('LayerCapability + Evidence + Artifact row schemas', () => {
  it('round-trips a layer capability whose origin is a proposal uuid', () => {
    const cap = {
      id: crypto.randomUUID(),
      layerId: crypto.randomUUID(),
      kind: 'skill' as const,
      name: 'x',
      specJson: '{}',
      origin: `proposal:${crypto.randomUUID()}`,
      activatedAt: new Date().toISOString(),
      deactivatedAt: null,
    };
    expect(LayerCapabilitySchema.parse(cap).origin.startsWith('proposal:')).toBe(true);
  });

  it('rejects a layer capability origin that is neither "builtin" nor a proposal uuid', () => {
    expect(() =>
      LayerCapabilitySchema.parse({
        id: crypto.randomUUID(),
        layerId: crypto.randomUUID(),
        kind: 'skill',
        name: 'x',
        specJson: '{}',
        origin: 'experiment',
        activatedAt: new Date().toISOString(),
        deactivatedAt: null,
      }),
    ).toThrow();
  });

  it('rejects an evidence row whose cluster reason is unknown', () => {
    expect(() =>
      ProposalEvidenceSchema.parse({
        id: crypto.randomUUID(),
        proposalId: crypto.randomUUID(),
        messageId: crypto.randomUUID(),
        clusterReason: 'user-confused',
        detailJson: null,
      }),
    ).toThrow();
  });

  it('round-trips an artifact row for each variant', () => {
    for (const variant of ['current', 'proposed', 'replanned'] as const) {
      expect(
        ProposalArtifactSchema.parse({
          id: crypto.randomUUID(),
          proposalId: crypto.randomUUID(),
          variant,
          transcriptJson: '{}',
          metricsJson: '{}',
          ranAt: new Date().toISOString(),
        }).variant,
      ).toBe(variant);
    }
  });
});
