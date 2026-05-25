/**
 * Phase 6.3 — entities (resolver) step (LLM-backed).
 *
 * Given the user text + the intent classification + the registered
 * entity kinds, produces `{ kinds, queryHints }` for the retrieval
 * step. zod-validated; same retry / fail policy as the intent step.
 */

import {
  EntitiesOutputSchema,
  PIPELINE_ENTITY_KINDS,
  type EntitiesOutput,
  type IntentOutput,
  type PipelineContext,
  type PipelineDeps,
  type PipelineStep,
  type PipelineStepResult,
} from './types';
import { extractJsonObject, InvalidStepOutputError } from './step-utils';

function systemPrompt(): string {
  const kinds = PIPELINE_ENTITY_KINDS.join(', ');
  return [
    'You are the entity resolver for a small business assistant.',
    `Available entity kinds: ${kinds}.`,
    'Given the user message + the intent classification, decide which',
    'kinds to search and which short search terms to use.',
    'Reply with STRICT JSON matching:',
    '  {',
    '    "kinds": [<entity kind>, ...],',
    '    "queryHints": [',
    '      { "term": <short search string>,',
    '        "kind": <optional entity kind>,',
    '        "timeWindow": { "from": <iso>, "to": <iso> }? }',
    '    ]',
    '  }',
    'Keep `term` short and lowercase where possible. Omit `kind` to',
    'broadcast the term across all kinds. Use `timeWindow` only when',
    'the user mentions a clear date range. No prose, JSON only.',
  ].join('\n');
}

export interface EntitiesStepInput {
  readonly userContent: string;
  readonly intent: IntentOutput;
}

export function createEntitiesStep(): PipelineStep<EntitiesStepInput, EntitiesOutput> {
  return {
    kind: 'entities',
    async run(
      input: EntitiesStepInput,
      ctx: PipelineContext,
      deps: PipelineDeps,
    ): Promise<PipelineStepResult<EntitiesOutput>> {
      const res = await deps.llm.chat({
        messages: [
          { role: 'system', content: systemPrompt() },
          {
            role: 'user',
            content: JSON.stringify({
              userMessage: input.userContent,
              intent: input.intent.intent,
            }),
          },
        ],
        temperature: 0,
        ...(ctx.chatModel !== undefined ? { model: ctx.chatModel.model } : {}),
        metadata: {
          correlationId: ctx.correlationId,
          flowId: ctx.flowId,
          layerId: ctx.layerId,
          userId: ctx.userId,
          step: 'entities',
          ...(ctx.chatModel !== undefined ? { modelSource: ctx.chatModel.source } : {}),
        },
      });
      const raw = extractJsonObject(res.content);
      const parsed = EntitiesOutputSchema.safeParse(raw);
      if (!parsed.success) {
        throw new InvalidStepOutputError('entities', parsed.error.message);
      }
      return {
        value: parsed.data,
        outputJson: JSON.stringify(parsed.data),
        llmCallId: null,
        status: 'succeeded',
      };
    },
  };
}
