/**
 * Phase 6.3 — intent step (LLM-backed).
 *
 * Classifies the user message into a closed enum. Output JSON is
 * validated by `IntentOutputSchema`; a parse failure raises an
 * `InvalidStepOutputError` so the orchestrator can apply the §4.1
 * "retry once, then mark step `failed`" policy.
 *
 * The step itself returns `llmCallId: null`; the orchestrator wraps
 * `deps.llm` with a fresh `withTelemetry` wrapper per step (so
 * `onCall` fires exactly once per step) and stitches the captured
 * id onto the persisted row.
 */

import {
  IntentOutputSchema,
  type IntentOutput,
  type PipelineContext,
  type PipelineDeps,
  type PipelineStep,
  type PipelineStepResult,
} from './types';
import { extractJsonObject, InvalidStepOutputError } from './step-utils';

const SYSTEM_PROMPT = [
  'You are the intent router for a small business assistant.',
  'Classify the user message into exactly one of these intents:',
  '  - question.entity_lookup  (asks about a known entity, e.g. "when do I meet Acme")',
  '  - question.summary        (asks for a summary of something the user has)',
  '  - command.create          (asks to create a new entity or todo)',
  '  - command.update          (asks to update an existing entity or todo)',
  '  - smalltalk               (greeting, thanks, casual)',
  '  - unsupported             (anything else)',
  'Reply with STRICT JSON matching:',
  '  { "intent": <one of above>, "confidence": <0..1>, "reason": <short> }',
  'No prose, no markdown, no code fence — JSON only.',
].join('\n');

export interface IntentStepInput {
  readonly userContent: string;
}

export function createIntentStep(): PipelineStep<IntentStepInput, IntentOutput> {
  return {
    kind: 'intent',
    async run(
      input: IntentStepInput,
      ctx: PipelineContext,
      deps: PipelineDeps,
    ): Promise<PipelineStepResult<IntentOutput>> {
      const res = await deps.llm.chat({
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: input.userContent },
        ],
        temperature: 0,
        metadata: {
          correlationId: ctx.correlationId,
          flowId: ctx.flowId,
          layerId: ctx.layerId,
          userId: ctx.userId,
          step: 'intent',
        },
      });
      const raw = extractJsonObject(res.content);
      const parsed = IntentOutputSchema.safeParse(raw);
      if (!parsed.success) {
        throw new InvalidStepOutputError('intent', parsed.error.message);
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
