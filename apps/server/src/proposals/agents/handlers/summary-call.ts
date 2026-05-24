/**
 * Phase 7.5 — `summary-call` agent handler adapter.
 *
 * Sibling of `enrichment-call`: an agent that summarises a bus
 * event's payload via the injected `LlmClient`. The split between
 * the two handler kinds is purely about intent — `enrichment` adds
 * facts to an entity, `summary` boils content down — and lets the
 * proposal LLM pick the more honest label at mint time.
 *
 * Same idempotency model as `enrichment-call`: at-least-once
 * delivery from the durable bus is safe, callers must de-dupe on
 * the bus event id when persisting.
 */

import { z } from 'zod';
import type { AgentHandler } from '@bunny2/shared';
import type { BusEvent } from '@bunny2/bus';
import type { LlmClient } from '../../../llm';

export const SummaryCallConfigSchema = z
  .object({
    promptTemplate: z.string().min(1).max(4000),
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(16000).optional(),
  })
  .strict();
export type SummaryCallConfig = z.infer<typeof SummaryCallConfigSchema>;

export interface SummaryCallInput {
  readonly text: string;
  readonly correlationId?: string;
  readonly flowId?: string;
}

export interface SummaryCallResult {
  readonly content: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly model: string;
}

export interface SummaryCallDeps {
  readonly llm: LlmClient;
}

export interface SummaryCallCallable {
  (event: BusEvent<unknown>, input: SummaryCallInput): Promise<SummaryCallResult>;
}

export function buildSummaryCallHandler(
  handler: AgentHandler,
  deps: SummaryCallDeps,
): SummaryCallCallable {
  if (handler.kind !== 'summary-call') {
    throw new Error(`buildSummaryCallHandler: unexpected handler.kind=${handler.kind}`);
  }
  const cfg = SummaryCallConfigSchema.parse(handler.config);
  return async (event, input) => {
    const prompt = cfg.promptTemplate.split('${text}').join(input.text);
    const metadata: Record<string, unknown> = { step: 'agent.summary-call', busEventId: event.id };
    if (input.correlationId !== undefined) metadata.correlationId = input.correlationId;
    if (input.flowId !== undefined) metadata.flowId = input.flowId;
    const req: Parameters<LlmClient['chat']>[0] = {
      messages: [{ role: 'user' as const, content: prompt }],
      metadata,
    };
    if (cfg.model !== undefined) (req as { model?: string }).model = cfg.model;
    if (cfg.temperature !== undefined)
      (req as { temperature?: number }).temperature = cfg.temperature;
    if (cfg.maxTokens !== undefined) (req as { maxTokens?: number }).maxTokens = cfg.maxTokens;
    const res = await deps.llm.chat(req);
    return {
      content: res.content,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      model: res.model,
    };
  };
}
