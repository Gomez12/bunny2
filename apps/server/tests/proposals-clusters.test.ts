/**
 * Phase 7.3 — cluster grouper unit tests.
 *
 * Pins:
 *  - Each of the five cluster reasons is detected from a positive
 *    fixture.
 *  - Clusters with `count < MIN_CLUSTER_COUNT` are dropped.
 *  - Output ordering is `CLUSTER_REASON_ORDER` then `stats.count`
 *    desc (deterministic — the LLM-mint step iterates this list).
 *  - Within a cluster, thumbs-down messages sort first, then by
 *    `createdAt` desc, capped at `MAX_MESSAGES_PER_CLUSTER`.
 */

import { describe, expect, it } from 'bun:test';
import {
  CLUSTER_REASON_ORDER,
  LATENCY_BUDGET_MS,
  MAX_MESSAGES_PER_CLUSTER,
  groupClusters,
  type ClusterGrouperFeedback,
  type ClusterGrouperMessage,
  type ClusterGrouperStep,
} from '../src/proposals/clusters';

function msg(id: string, createdAt: string): ClusterGrouperMessage {
  return { id, createdAt, correlationId: `cor-${id}` };
}

function step(messageId: string, partial: Partial<ClusterGrouperStep> = {}): ClusterGrouperStep {
  return {
    id: `step-${messageId}-${partial.kind ?? 'k'}-${partial.errorCode ?? 'ok'}`,
    messageId,
    kind: partial.kind ?? 'retrieval',
    status: partial.status ?? 'succeeded',
    startedAt: partial.startedAt ?? '2026-05-01T12:00:00.000Z',
    endedAt: partial.endedAt ?? '2026-05-01T12:00:00.100Z',
    outputJson: partial.outputJson ?? null,
    errorCode: partial.errorCode ?? null,
  };
}

describe('groupClusters — zero-hit-retrieval', () => {
  it('emits one zero-hit cluster when ≥2 messages have a retrieval step with 0 hits', () => {
    const messages = [msg('m1', '2026-05-01T12:00:00.000Z'), msg('m2', '2026-05-01T12:01:00.000Z')];
    const steps: ClusterGrouperStep[] = [
      step('m1', { kind: 'retrieval', outputJson: JSON.stringify({ hits: [] }) }),
      step('m2', { kind: 'retrieval', outputJson: JSON.stringify({ hits: [] }) }),
    ];
    const clusters = groupClusters({ messages, feedback: [], steps, llmCalls: [] });
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.reason).toBe('zero-hit-retrieval');
    expect(clusters[0]?.stats.count).toBe(2);
    expect(new Set(clusters[0]?.messageIds)).toEqual(new Set(['m1', 'm2']));
  });

  it('does not include messages whose retrieval step has hits', () => {
    const messages = [msg('m1', '2026-05-01T12:00:00.000Z'), msg('m2', '2026-05-01T12:01:00.000Z')];
    const steps: ClusterGrouperStep[] = [
      step('m1', { kind: 'retrieval', outputJson: JSON.stringify({ hits: [] }) }),
      step('m2', {
        kind: 'retrieval',
        outputJson: JSON.stringify({ hits: [{ id: 'x' }] }),
      }),
    ];
    const clusters = groupClusters({ messages, feedback: [], steps, llmCalls: [] });
    expect(clusters.length).toBe(0); // only one zero-hit → < MIN_CLUSTER_COUNT
  });
});

describe('groupClusters — thumbs-down', () => {
  it('emits a thumbs-down cluster for ≥2 down feedback rows', () => {
    const messages = [msg('m1', '2026-05-01T12:00:00.000Z'), msg('m2', '2026-05-01T12:01:00.000Z')];
    const feedback: ClusterGrouperFeedback[] = [
      { messageId: 'm1', value: 'down' },
      { messageId: 'm2', value: 'down' },
    ];
    const clusters = groupClusters({ messages, feedback, steps: [], llmCalls: [] });
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.reason).toBe('thumbs-down');
    expect(clusters[0]?.stats.thumbsDownRate).toBe(1);
  });
});

describe('groupClusters — invalid-step-output', () => {
  it('emits an invalid-step-output cluster when ≥2 messages have a step with error_code=invalid_step_output', () => {
    const messages = [msg('m1', '2026-05-01T12:00:00.000Z'), msg('m2', '2026-05-01T12:01:00.000Z')];
    const steps: ClusterGrouperStep[] = [
      step('m1', { kind: 'intent', status: 'failed', errorCode: 'invalid_step_output' }),
      step('m2', { kind: 'entities', status: 'failed', errorCode: 'invalid_step_output' }),
    ];
    const clusters = groupClusters({ messages, feedback: [], steps, llmCalls: [] });
    expect(clusters.length).toBe(1);
    expect(clusters[0]?.reason).toBe('invalid-step-output');
  });
});

describe('groupClusters — latency-over-budget', () => {
  it('emits a latency cluster when ≥2 messages exceed LATENCY_BUDGET_MS total step duration', () => {
    const messages = [msg('m1', '2026-05-01T12:00:00.000Z'), msg('m2', '2026-05-01T12:01:00.000Z')];
    const overMs = LATENCY_BUDGET_MS + 1000;
    const steps: ClusterGrouperStep[] = [
      step('m1', {
        kind: 'retrieval',
        startedAt: '2026-05-01T12:00:00.000Z',
        endedAt: new Date(Date.parse('2026-05-01T12:00:00.000Z') + overMs).toISOString(),
      }),
      step('m2', {
        kind: 'retrieval',
        startedAt: '2026-05-01T12:01:00.000Z',
        endedAt: new Date(Date.parse('2026-05-01T12:01:00.000Z') + overMs).toISOString(),
      }),
    ];
    const clusters = groupClusters({ messages, feedback: [], steps, llmCalls: [] });
    const c = clusters.find((x) => x.reason === 'latency-over-budget');
    expect(c).toBeDefined();
    expect(c?.stats.avgLatencyMs).toBeGreaterThan(LATENCY_BUDGET_MS);
  });
});

describe('groupClusters — repeated-error-code', () => {
  it('emits a repeated-error cluster when an error code appears in ≥3 distinct messages', () => {
    const messages = [
      msg('m1', '2026-05-01T12:00:00.000Z'),
      msg('m2', '2026-05-01T12:01:00.000Z'),
      msg('m3', '2026-05-01T12:02:00.000Z'),
    ];
    const steps: ClusterGrouperStep[] = [
      step('m1', { kind: 'answer', status: 'failed', errorCode: 'answer_llm_failed' }),
      step('m2', { kind: 'answer', status: 'failed', errorCode: 'answer_llm_failed' }),
      step('m3', { kind: 'answer', status: 'failed', errorCode: 'answer_llm_failed' }),
    ];
    const clusters = groupClusters({ messages, feedback: [], steps, llmCalls: [] });
    const c = clusters.find((x) => x.reason === 'repeated-error-code');
    expect(c).toBeDefined();
    expect(c?.stats.count).toBe(3);
    expect(c?.summary).toContain('answer_llm_failed');
  });

  it('does not emit when no error code reaches the threshold of 3', () => {
    const messages = [msg('m1', '2026-05-01T12:00:00.000Z'), msg('m2', '2026-05-01T12:01:00.000Z')];
    const steps: ClusterGrouperStep[] = [
      step('m1', { kind: 'answer', status: 'failed', errorCode: 'answer_llm_failed' }),
      step('m2', { kind: 'answer', status: 'failed', errorCode: 'answer_llm_failed' }),
    ];
    const clusters = groupClusters({ messages, feedback: [], steps, llmCalls: [] });
    // Note: the invalid-step-output rule does NOT match here
    // (errorCode is `answer_llm_failed`, not `invalid_step_output`),
    // so no cluster surfaces.
    expect(clusters.find((c) => c.reason === 'repeated-error-code')).toBeUndefined();
  });
});

describe('groupClusters — count<2 filter', () => {
  it('drops clusters that would have a single supporting message', () => {
    const messages = [msg('m1', '2026-05-01T12:00:00.000Z')];
    const feedback: ClusterGrouperFeedback[] = [{ messageId: 'm1', value: 'down' }];
    const clusters = groupClusters({ messages, feedback, steps: [], llmCalls: [] });
    expect(clusters.length).toBe(0);
  });
});

describe('groupClusters — deterministic ordering', () => {
  it('orders clusters by CLUSTER_REASON_ORDER then stats.count desc', () => {
    const messages = [
      msg('m1', '2026-05-01T12:00:00.000Z'),
      msg('m2', '2026-05-01T12:01:00.000Z'),
      msg('m3', '2026-05-01T12:02:00.000Z'),
      msg('m4', '2026-05-01T12:03:00.000Z'),
      msg('m5', '2026-05-01T12:04:00.000Z'),
      msg('m6', '2026-05-01T12:05:00.000Z'),
    ];
    const steps: ClusterGrouperStep[] = [
      // zero-hit on m5+m6 (count=2)
      step('m5', { kind: 'retrieval', outputJson: JSON.stringify({ hits: [] }) }),
      step('m6', { kind: 'retrieval', outputJson: JSON.stringify({ hits: [] }) }),
    ];
    // thumbs-down on m1..m4 (count=4)
    const feedback: ClusterGrouperFeedback[] = [
      { messageId: 'm1', value: 'down' },
      { messageId: 'm2', value: 'down' },
      { messageId: 'm3', value: 'down' },
      { messageId: 'm4', value: 'down' },
    ];
    const clusters = groupClusters({ messages, feedback, steps, llmCalls: [] });
    // Even though thumbs-down has a higher count, zero-hit-retrieval
    // is earlier in the enum order — it sorts first.
    expect(clusters.map((c) => c.reason)).toEqual(['zero-hit-retrieval', 'thumbs-down']);
    expect(CLUSTER_REASON_ORDER.indexOf('zero-hit-retrieval')).toBeLessThan(
      CLUSTER_REASON_ORDER.indexOf('thumbs-down'),
    );
  });

  it('orders messages within a cluster: thumbs-down first, then created_at desc, capped at 5', () => {
    // Six zero-hit messages: three with thumbs-down (older), three
    // without (newer). Expect the three thumbs-down messages first,
    // then two of the newest plain ones (cap=5).
    const messages: ClusterGrouperMessage[] = [
      msg('down-old-1', '2026-05-01T10:00:00.000Z'),
      msg('down-old-2', '2026-05-01T10:01:00.000Z'),
      msg('down-old-3', '2026-05-01T10:02:00.000Z'),
      msg('plain-1', '2026-05-01T11:00:00.000Z'),
      msg('plain-2', '2026-05-01T11:01:00.000Z'),
      msg('plain-3', '2026-05-01T11:02:00.000Z'),
    ];
    const steps: ClusterGrouperStep[] = messages.map((m) =>
      step(m.id, { kind: 'retrieval', outputJson: JSON.stringify({ hits: [] }) }),
    );
    const feedback: ClusterGrouperFeedback[] = [
      { messageId: 'down-old-1', value: 'down' },
      { messageId: 'down-old-2', value: 'down' },
      { messageId: 'down-old-3', value: 'down' },
    ];
    const clusters = groupClusters({ messages, feedback, steps, llmCalls: [] });
    expect(clusters[0]?.reason).toBe('zero-hit-retrieval');
    expect(clusters[0]?.messageIds.length).toBe(MAX_MESSAGES_PER_CLUSTER);
    const ids = clusters[0]?.messageIds ?? [];
    // First three are the thumbs-down ones (newest down first).
    expect(ids.slice(0, 3).sort()).toEqual(['down-old-1', 'down-old-2', 'down-old-3']);
    // Next two are the two newest plain ones (plain-3, plain-2).
    expect(ids[3]).toBe('plain-3');
    expect(ids[4]).toBe('plain-2');
  });
});
