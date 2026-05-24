/**
 * Phase 7.5 — `enrichment-call` agent handler adapter.
 *
 * Constructs a typed callable from an `agent` spec whose handler
 * declares `kind: 'enrichment-call'`. The handler receives a bus
 * event payload (the durable bus's at-least-once envelope) and the
 * spec's config, and asks the injected `LlmClient` to enrich the
 * referenced entity. Mirrors the shape of the phase-6 enrichment
 * runner but stays narrow: this adapter does NOT touch the entity
 * store directly; it returns the LLM's response as a structured
 * value and lets the caller decide what to do.
 *
 * Idempotency: every invocation produces the same LLM input given
 * the same `(payload.ref, config)` pair, so a duplicate delivery
 * yields a duplicate `llm_calls` row but no double-effect. Callers
 * that PERSIST the LLM output MUST de-dupe on the bus event id; the
 * subscriber wrapper records the event id so a consumer can skip
 * the second delivery.
 */

import { z } from 'zod';
import type { AgentHandler } from '@bunny2/shared';
import type { BusEvent } from '@bunny2/bus';
import type { LlmClient } from '../../../llm';

export const EnrichmentCallConfigSchema = z
  .object({
    /** LLM prompt template; the `${term}` placeholder is replaced with
     *  the bus event's referenced entity (caller pulls the string). */
    promptTemplate: z.string().min(1).max(4000),
    model: z.string().min(1).max(120).optional(),
    temperature: z.number().min(0).max(2).optional(),
    maxTokens: z.number().int().min(1).max(16000).optional(),
  })
  .strict();
export type EnrichmentCallConfig = z.infer<typeof EnrichmentCallConfigSchema>;

export interface EnrichmentCallInput {
  readonly term: string;
  readonly correlationId?: string;
  readonly flowId?: string;
}

export interface EnrichmentCallResult {
  readonly content: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly model: string;
}

export interface EnrichmentCallDeps {
  readonly llm: LlmClient;
}

export interface EnrichmentCallCallable {
  (event: BusEvent<unknown>, input: EnrichmentCallInput): Promise<EnrichmentCallResult>;
}

export function buildEnrichmentCallHandler(
  handler: AgentHandler,
  deps: EnrichmentCallDeps,
): EnrichmentCallCallable {
  if (handler.kind !== 'enrichment-call') {
    throw new Error(`buildEnrichmentCallHandler: unexpected handler.kind=${handler.kind}`);
  }
  const cfg = EnrichmentCallConfigSchema.parse(handler.config);
  return async (event, input) => {
    const prompt = cfg.promptTemplate.split('${term}').join(input.term);
    const metadata: Record<string, unknown> = {
      step: 'agent.enrichment-call',
      busEventId: event.id,
    };
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
