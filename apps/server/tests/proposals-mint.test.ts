/**
 * Phase 7.3 — `mintProposalViaLlm` unit tests.
 *
 * Pins the LLM mint contract:
 *  - Valid JSON output → `{ ok }`.
 *  - Malformed JSON first call → retry once → success on second.
 *  - Malformed JSON twice → `{ err }`.
 *  - Closed-enum violation (zod rejects an unknown handler kind) →
 *    `{ err }`.
 *  - `addressesTags` MUST contain the cluster's reason.
 *
 * Uses the programmable-llm test fixture (keyed by `metadata.step`),
 * pinning step='proposal.mint' so we can enqueue replies.
 */

import { describe, expect, it } from 'bun:test';
import type { CapabilitySnapshot } from '@bunny2/shared';
import { mintProposalViaLlm } from '../src/proposals/mint';
import type { Cluster } from '../src/proposals/clusters';
import { createProgrammableLlm } from './_helpers/programmable-llm';

function sampleCluster(): Cluster {
  return {
    reason: 'zero-hit-retrieval',
    messageIds: ['m1', 'm2'],
    summary: '2 message(s) got 0 retrieval hits',
    stats: { count: 2, thumbsDownRate: 0.5 },
  };
}

function emptySnapshot(): CapabilitySnapshot {
  return { capabilities: [], builtins: [] };
}

function validSpecJson(): string {
  return JSON.stringify({
    spec: {
      artifactKind: 'skill',
      name: 'expand-acme-alias',
      description: 'Expand the Acmé alias to Acme so retrieval finds matches.',
      intent: 'question.entity_lookup',
      promptFragment: 'If the user writes Acmé, also search for Acme.',
      addressesTags: ['zero-hit-retrieval'],
    },
    expectedImpact: { thumbsUpDelta: 0.18, tokensDelta: 12, latencyDeltaMs: 14 },
    threshold: 0.72,
  });
}

describe('mintProposalViaLlm — happy path', () => {
  it('returns ok with a zod-validated wrapper when the LLM emits a valid spec', async () => {
    const llm = createProgrammableLlm();
    llm.enqueue('proposal.mint', { content: validSpecJson() });

    const result = await mintProposalViaLlm(llm, {
      cluster: sampleCluster(),
      capabilitySnapshot: emptySnapshot(),
      layerId: '00000000-0000-0000-0000-000000000001',
      messageSnippets: new Map([
        ['m1', 'when do I meet Acmé?'],
        ['m2', 'show me Acmé strategy notes'],
      ]),
      flowId: 'proposal.mint:run-1',
      correlationId: 'cor-1',
    });

    expect('ok' in result).toBe(true);
    if ('ok' in result) {
      expect(result.ok.spec.artifactKind).toBe('skill');
      expect(result.ok.threshold).toBeCloseTo(0.72, 5);
      expect(result.ok.spec.addressesTags).toContain('zero-hit-retrieval');
    }
    expect(llm.calls.length).toBe(1);
    expect(llm.calls[0]?.step).toBe('proposal.mint');
  });
});

describe('mintProposalViaLlm — retry on malformed JSON', () => {
  it('retries once and succeeds on the second call', async () => {
    const llm = createProgrammableLlm();
    llm.enqueue('proposal.mint', { content: 'not-json-at-all' });
    llm.enqueue('proposal.mint', { content: validSpecJson() });

    const result = await mintProposalViaLlm(llm, {
      cluster: sampleCluster(),
      capabilitySnapshot: emptySnapshot(),
      layerId: '00000000-0000-0000-0000-000000000001',
      messageSnippets: new Map(),
      flowId: 'proposal.mint:run-1',
      correlationId: 'cor-1',
    });

    expect('ok' in result).toBe(true);
    expect(llm.calls.length).toBe(2);
  });

  it('returns err after two malformed responses', async () => {
    const llm = createProgrammableLlm();
    llm.enqueue('proposal.mint', { content: 'bad-1' });
    llm.enqueue('proposal.mint', { content: 'bad-2' });

    const result = await mintProposalViaLlm(llm, {
      cluster: sampleCluster(),
      capabilitySnapshot: emptySnapshot(),
      layerId: '00000000-0000-0000-0000-000000000001',
      messageSnippets: new Map(),
      flowId: 'proposal.mint:run-1',
      correlationId: 'cor-1',
    });

    expect('err' in result).toBe(true);
    expect(llm.calls.length).toBe(2);
  });
});

describe('mintProposalViaLlm — closed-enum violation', () => {
  it('rejects a spec whose handler.kind is not in the enum', async () => {
    const llm = createProgrammableLlm();
    const badContent = JSON.stringify({
      spec: {
        artifactKind: 'tool',
        name: 'bad-tool',
        description: 'desc',
        jsonSchema: {},
        handler: { kind: 'made-up-handler-kind', config: {} },
        addressesTags: ['zero-hit-retrieval'],
      },
      expectedImpact: { thumbsUpDelta: 0.1, tokensDelta: 1, latencyDeltaMs: 1 },
      threshold: 0.5,
    });
    // enqueue twice so the retry path also fails the same way
    llm.enqueue('proposal.mint', { content: badContent });
    llm.enqueue('proposal.mint', { content: badContent });

    const result = await mintProposalViaLlm(llm, {
      cluster: sampleCluster(),
      capabilitySnapshot: emptySnapshot(),
      layerId: '00000000-0000-0000-0000-000000000001',
      messageSnippets: new Map(),
      flowId: 'proposal.mint:run-1',
      correlationId: 'cor-1',
    });
    expect('err' in result).toBe(true);
  });
});

describe('mintProposalViaLlm — addressesTags must include cluster reason', () => {
  it('rejects when addressesTags does not contain the cluster reason', async () => {
    const llm = createProgrammableLlm();
    const badContent = JSON.stringify({
      spec: {
        artifactKind: 'skill',
        name: 'unrelated',
        description: 'wrong tag set',
        intent: 'question.entity_lookup',
        promptFragment: 'x',
        addressesTags: ['thumbs-down'], // cluster.reason is zero-hit-retrieval
      },
      expectedImpact: { thumbsUpDelta: 0.1, tokensDelta: 1, latencyDeltaMs: 1 },
      threshold: 0.5,
    });
    llm.enqueue('proposal.mint', { content: badContent });
    llm.enqueue('proposal.mint', { content: badContent });

    const result = await mintProposalViaLlm(llm, {
      cluster: sampleCluster(),
      capabilitySnapshot: emptySnapshot(),
      layerId: '00000000-0000-0000-0000-000000000001',
      messageSnippets: new Map(),
      flowId: 'proposal.mint:run-1',
      correlationId: 'cor-1',
    });
    expect('err' in result).toBe(true);
    if ('err' in result) {
      expect(result.err.message).toMatch(/zero-hit-retrieval/);
    }
  });

  it('always passes the cluster reason through when LLM returns valid spec containing it', async () => {
    // Iterate every cluster reason: each one demands a spec that
    // includes it in addressesTags.
    const reasons = [
      'zero-hit-retrieval',
      'thumbs-down',
      'invalid-step-output',
      'latency-over-budget',
      'repeated-error-code',
    ] as const;
    for (const reason of reasons) {
      const llm = createProgrammableLlm();
      const content = JSON.stringify({
        spec: {
          artifactKind: 'skill',
          name: `for-${reason}`,
          description: 'd',
          intent: 'question.entity_lookup',
          promptFragment: 'x',
          addressesTags: [reason],
        },
        expectedImpact: { thumbsUpDelta: 0.1, tokensDelta: 1, latencyDeltaMs: 1 },
        threshold: 0.5,
      });
      llm.enqueue('proposal.mint', { content });
      const result = await mintProposalViaLlm(llm, {
        cluster: {
          reason,
          messageIds: ['m1', 'm2'],
          summary: `${reason} fixture`,
          stats: { count: 2 },
        },
        capabilitySnapshot: emptySnapshot(),
        layerId: '00000000-0000-0000-0000-000000000001',
        messageSnippets: new Map(),
        flowId: 'proposal.mint:run-1',
        correlationId: 'cor-1',
      });
      expect('ok' in result).toBe(true);
      if ('ok' in result) {
        expect(result.ok.spec.addressesTags).toContain(reason);
      }
    }
  });
});
