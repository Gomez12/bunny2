/**
 * Phase 6.3/6.4 — answer step.
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
 * Phase 6.4 changes:
 *  - Streaming variant: when `deps.chunkSink` is provided AND
 *    `deps.llm.chatStream` is a function, the answerer streams
 *    chunks through `chunkSink` for the SSE route to forward as
 *    `event: token`. Otherwise it falls back to the non-streaming
 *    `chat()` path (keeps the 6.3 orchestrator tests green).
 *  - 60s timeout is now an `AbortSignal` combined with any
 *    caller-supplied signal (`deps.abortSignal` — wired from the
 *    HTTP request lifecycle). Mid-stream abort surfaces as
 *    `AnswerAbortedError`; the orchestrator marks the message
 *    `failed` and persists whatever partial content was streamed.
 *
 * `command.*` intents short-circuit upstream in the orchestrator —
 * the answer step is `skipped` with a hard-coded "not yet supported
 * in phase 6" message (plan §4.1).
 */

import {
  AnswerOutputSchema,
  ERROR_CODES,
  type AnswerOutput,
  type IntentOutput,
  type PipelineContext,
  type PipelineDeps,
  type PipelineStep,
  type PipelineStepResult,
  type RetrievalOutput,
} from './types';
import { loadSkillFragments } from '../skills/load-fragments';

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

export class AnswerTimeoutError extends Error {
  readonly errorCode = ERROR_CODES.AnswerTimeout;
  constructor(timeoutMs: number) {
    super(`answer step timed out after ${timeoutMs}ms`);
    this.name = 'AnswerTimeoutError';
  }
}

export class AnswerAbortedError extends Error {
  readonly errorCode = ERROR_CODES.AnswerAborted;
  readonly partial: string;
  constructor(partial: string) {
    super('answer step aborted (client disconnect or upstream cancel)');
    this.name = 'AnswerAbortedError';
    this.partial = partial;
  }
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

      // Phase 7.5 — load activated skill prompt-fragments for this
      // `(layerId, intent)`. The list is deterministic (ordered by
      // `activatedAt` ascending) and empty when no skills match —
      // which keeps the phase-6 byte-identical prompt path alive for
      // every test that doesn't wire a registry.
      const skillFragments =
        deps.capabilityRegistry !== undefined
          ? loadSkillFragments(deps.capabilityRegistry, ctx.layerId, intent)
          : [];

      const messages: {
        readonly role: 'system' | 'user' | 'assistant';
        readonly content: string;
      }[] = [
        { role: 'system', content: SYSTEM_PROMPT },
        // Skill fragments slot AFTER the hard grounding system prompt
        // and BEFORE the conversation history + retrieval JSON. Order
        // is `activatedAt` ascending so re-runs are stable.
        ...skillFragments.map((s) => ({ role: 'system' as const, content: s.promptFragment })),
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

      // Phase 7.6 — compute the capability-attribution JSON written to
      // `chat_pipeline_steps.attribution_json`. The Kanban board reads
      // it to render `[skill:<name>]` / `[tool:<name>]` / `[agent:<name>]`
      // chips on the card. Only `skills` is populated in 7.6; tools +
      // agents stay empty arrays (the answerer is hard-coded; the
      // tool-calling answerer follow-up will start writing them). When
      // no capability contributed (the common case for phase-6
      // pipelines), `attributionJson` stays `null` and the column is
      // not written — preserving the byte-identical phase-6 path.
      const attributionJson =
        skillFragments.length > 0
          ? JSON.stringify({
              skills: skillFragments.map((s) => ({
                capabilityId: s.capabilityId,
                name: s.name,
              })),
              tools: [],
              agents: [],
            })
          : null;

      const metadata: Readonly<Record<string, unknown>> = {
        correlationId: ctx.correlationId,
        flowId: ctx.flowId,
        layerId: ctx.layerId,
        userId: ctx.userId,
        step: 'answer',
        ...(ctx.chatModel !== undefined ? { modelSource: ctx.chatModel.source } : {}),
      };
      const modelOverride = ctx.chatModel?.model;

      // Build a linked signal: combine the request signal (HTTP
      // client disconnect) with the answerer's hard 60s timeout.
      const timeoutController = new AbortController();
      const timer = setTimeout(() => {
        timeoutController.abort(new AnswerTimeoutError(ANSWER_TIMEOUT_MS));
      }, ANSWER_TIMEOUT_MS);

      const linkedSignal = linkSignals(deps.abortSignal, timeoutController.signal);

      try {
        const streamingPossible =
          deps.chunkSink !== undefined && typeof deps.llm.chatStream === 'function';

        const inner = streamingPossible
          ? await runStreaming(
              messages,
              metadata,
              linkedSignal,
              deps,
              timeoutController,
              modelOverride,
            )
          : await runNonStreaming(
              messages,
              metadata,
              linkedSignal,
              deps,
              timeoutController,
              modelOverride,
            );
        // Tack on the attribution JSON computed above so the
        // orchestrator can persist it into `chat_pipeline_steps`.
        // `null` here keeps the column NULL (phase-6 default); a
        // populated string lights up the Kanban chips.
        return { ...inner, attributionJson };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

async function runNonStreaming(
  messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[],
  metadata: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  deps: PipelineDeps,
  timeoutController: AbortController,
  modelOverride: string | undefined,
): Promise<PipelineStepResult<AnswerOutput>> {
  try {
    const res = await deps.llm.chat({
      messages,
      temperature: 0.1,
      ...(modelOverride !== undefined ? { model: modelOverride } : {}),
      metadata,
      signal,
    });
    const value: AnswerOutput = {
      content: res.content,
      tokensIn: res.tokensIn,
      tokensOut: res.tokensOut,
      model: res.model,
      skipped: false,
      streamed: false,
    };
    const parsed = AnswerOutputSchema.parse(value);
    return {
      value: parsed,
      outputJson: JSON.stringify({
        model: parsed.model,
        tokensIn: parsed.tokensIn,
        tokensOut: parsed.tokensOut,
        contentBytes: parsed.content.length,
        skipped: false,
        streamed: false,
      }),
      llmCallId: null,
      status: 'succeeded',
    };
  } catch (err) {
    throw translateAnswerError(err, '', timeoutController);
  }
}

async function runStreaming(
  messages: readonly { readonly role: 'system' | 'user' | 'assistant'; readonly content: string }[],
  metadata: Readonly<Record<string, unknown>>,
  signal: AbortSignal,
  deps: PipelineDeps,
  timeoutController: AbortController,
  modelOverride: string | undefined,
): Promise<PipelineStepResult<AnswerOutput>> {
  const chatStream = deps.llm.chatStream;
  if (chatStream === undefined) {
    throw new Error('runStreaming called without chatStream — defensive branch');
  }
  const sink = deps.chunkSink;
  if (sink === undefined) {
    throw new Error('runStreaming called without chunkSink — defensive branch');
  }

  let accumulated = '';
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let finalModel: string = modelOverride ?? deps.llm.defaultModel;

  try {
    const iter = chatStream({
      messages,
      temperature: 0.1,
      ...(modelOverride !== undefined ? { model: modelOverride } : {}),
      metadata,
      signal,
    });
    for await (const chunk of iter) {
      if (chunk.done === true) {
        if (typeof chunk.delta === 'string' && chunk.delta.length > 0) {
          accumulated += chunk.delta;
          sink({ delta: chunk.delta });
        }
        if (typeof chunk.tokensIn === 'number') tokensIn = chunk.tokensIn;
        if (typeof chunk.tokensOut === 'number') tokensOut = chunk.tokensOut;
        if (typeof chunk.model === 'string' && chunk.model.length > 0) finalModel = chunk.model;
        continue;
      }
      const delta = chunk.delta ?? '';
      if (delta.length > 0) {
        accumulated += delta;
        sink({ delta });
      }
    }
  } catch (err) {
    throw translateAnswerError(err, accumulated, timeoutController);
  }

  // Fall back to char-count estimates when the upstream did not
  // report `usage` — keeps the assertion that token counts are
  // present on the assistant message row.
  if (tokensOut === null) tokensOut = Math.max(0, Math.floor(accumulated.length / 4));
  if (tokensIn === null) {
    const inChars = messages.reduce((acc, m) => acc + m.content.length, 0);
    tokensIn = Math.max(0, Math.floor(inChars / 4));
  }

  const value: AnswerOutput = {
    content: accumulated,
    tokensIn,
    tokensOut,
    model: finalModel,
    skipped: false,
    streamed: true,
  };
  const parsed = AnswerOutputSchema.parse(value);
  return {
    value: parsed,
    outputJson: JSON.stringify({
      model: parsed.model,
      tokensIn: parsed.tokensIn,
      tokensOut: parsed.tokensOut,
      contentBytes: parsed.content.length,
      skipped: false,
      streamed: true,
    }),
    llmCallId: null,
    status: 'succeeded',
  };
}

function translateAnswerError(
  err: unknown,
  partial: string,
  timeoutController: AbortController,
): Error {
  // The hard 60s timeout AbortController aborts with our typed
  // `AnswerTimeoutError`; signal.reason carries it. Distinguishing
  // timeout from caller-abort matters because timeout is a hard
  // failure while caller-abort is "client disconnected mid-stream".
  if (timeoutController.signal.aborted === true) {
    const reason = timeoutController.signal.reason;
    if (reason instanceof AnswerTimeoutError) return reason;
    return new AnswerTimeoutError(ANSWER_TIMEOUT_MS);
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError' || (err as { code?: string }).code === 'ABORT_ERR') {
      return new AnswerAbortedError(partial);
    }
  }
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * Combine zero or more `AbortSignal`s into one that aborts when any
 * input aborts. Falls back to a pass-through when only one input is
 * present. `AbortSignal.any(...)` is the standard one-liner, but
 * Bun's older runtimes do not always expose it on the global; this
 * helper degrades gracefully.
 */
function linkSignals(...signals: readonly (AbortSignal | undefined)[]): AbortSignal {
  const real = signals.filter((s): s is AbortSignal => s !== undefined);
  if (real.length === 0) {
    return new AbortController().signal;
  }
  if (real.length === 1) {
    const onlySignal = real[0];
    if (onlySignal !== undefined) return onlySignal;
  }
  const anyFn = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anyFn === 'function') {
    return anyFn.call(AbortSignal, [...real]);
  }
  const combined = new AbortController();
  for (const sig of real) {
    if (sig.aborted) {
      combined.abort(sig.reason);
      break;
    }
    sig.addEventListener('abort', () => combined.abort(sig.reason), { once: true });
  }
  return combined.signal;
}
