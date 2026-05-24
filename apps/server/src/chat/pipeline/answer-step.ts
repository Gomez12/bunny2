/**
 * Phase 6.3 — answer step (LLM, NON-STREAMED).
 *
 * Composes the final assistant reply using:
 *   - a hard system prompt locking the model to retrieval output
 *     ("answer ONLY from the supplied retrieval JSON; say 'I don't
 *      know' if it's empty" — plan §10),
 *   - the conversation history (already capped at 20 turns by the
 *     orchestrator),
 *   - the retrieval JSON,
 *   - the user message.
 *
 * Streaming variant lands in phase 6.4. Hard 60-second timeout is
 * enforced via `Promise.race`; the LLM client does NOT take an
 * AbortSignal today.
 *
 * `command.*` intents short-circuit upstream in the orchestrator —
 * the answer step is `skipped` with a hard-coded "not yet supported
 * in phase 6" message (plan §4.1).
 */

import {
  AnswerOutputSchema,
  type AnswerOutput,
  type IntentOutput,
  type PipelineContext,
  type PipelineDeps,
  type PipelineStep,
  type PipelineStepResult,
  type RetrievalOutput,
} from './types';

export const ANSWER_TIMEOUT_MS = 60_000;

export const COMMAND_NOT_SUPPORTED_MESSAGE =
  "I can't create or update entries yet — that's coming in a later release. " +
  'For now, please use the dashboard or the per-entity pages to make changes.';

export const SMALLTALK_FALLBACK_MESSAGE =
  "Hi! I'm your assistant for the entries in this layer. Ask me about your contacts, " +
  "companies, calendar, or todos and I'll do my best to look them up.";

const SYSTEM_PROMPT = [
  'You are the assistant for a small business CRM.',
  'You MUST answer ONLY from the supplied retrieval JSON below.',
  'If the retrieval JSON is empty, or does not contain the answer, say',
  '"I don\'t know" and ask the user for more detail.',
  'Do not fabricate dates, names, identifiers, or relationships that',
  'are not present in the retrieval JSON. Quote titles verbatim.',
  'Keep replies short and direct; the user is a busy operator.',
].join('\n');

export interface AnswerStepInput {
  readonly intent: IntentOutput;
  readonly retrieval: RetrievalOutput;
}

export function createAnswerStep(): PipelineStep<AnswerStepInput, AnswerOutput> {
  return {
    kind: 'answer',
    async run(
      input: AnswerStepInput,
      ctx: PipelineContext,
      deps: PipelineDeps,
    ): Promise<PipelineStepResult<AnswerOutput>> {
      // `command.*` short-circuit: write a hard-coded reply and mark
      // the step `skipped`. No LLM call. The orchestrator persists
      // the row and tags the assistant message `done` with this
      // canned content.
      const intent = input.intent.intent;
      if (intent === 'command.create' || intent === 'command.update') {
        const value: AnswerOutput = {
          content: COMMAND_NOT_SUPPORTED_MESSAGE,
          tokensIn: 0,
          tokensOut: 0,
          model: deps.llm.defaultModel,
          skipped: true,
        };
        return {
          value,
          outputJson: JSON.stringify({ ...value, content: '[redacted: canned reply]' }),
          llmCallId: null,
          status: 'skipped',
        };
      }

      const messages: {
        readonly role: 'system' | 'user' | 'assistant';
        readonly content: string;
      }[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        ...ctx.history.map((h) => ({ role: h.role, content: h.content })),
        {
          role: 'system',
          content:
            'Retrieval JSON (authoritative source of facts for this answer):\n' +
            JSON.stringify({
              hits: input.retrieval.hits,
              skipped: input.retrieval.skipped,
            }),
        },
        { role: 'user', content: ctx.userContent },
      ];

      const callPromise = deps.llm.chat({
        messages,
        temperature: 0.1,
        metadata: {
          correlationId: ctx.correlationId,
          flowId: ctx.flowId,
          layerId: ctx.layerId,
          userId: ctx.userId,
          step: 'answer',
        },
      });

      const res = await raceWithTimeout(callPromise, ANSWER_TIMEOUT_MS);

      const value: AnswerOutput = {
        content: res.content,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        model: res.model,
        skipped: false,
      };
      const parsed = AnswerOutputSchema.parse(value);
      return {
        value: parsed,
        // Persist only token counts + model + truncated marker to
        // `chat_pipeline_steps.output_json`. The full assistant text
        // already lands on `chat_messages.content`; duplicating it
        // bloats the step log and complicates retention.
        outputJson: JSON.stringify({
          model: parsed.model,
          tokensIn: parsed.tokensIn,
          tokensOut: parsed.tokensOut,
          contentBytes: parsed.content.length,
          skipped: false,
        }),
        llmCallId: null,
        status: 'succeeded',
      };
    },
  };
}

export class AnswerTimeoutError extends Error {
  readonly errorCode = 'answer_timeout';
  constructor(timeoutMs: number) {
    super(`answer step timed out after ${timeoutMs}ms`);
    this.name = 'AnswerTimeoutError';
  }
}

async function raceWithTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new AnswerTimeoutError(timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}
