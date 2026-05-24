import type { ChatRequest, ChatResponse, LlmClient } from './types';
import type { LlmCallLog, LlmCallRow } from './call-log';
import { estimateCostUsd, type PricingMap } from './pricing';
import { redact } from './redaction';

export interface TelemetryOpts {
  readonly log: LlmCallLog;
  readonly pricing?: PricingMap;
  /** Override the clock for tests. Returns a Date. */
  readonly clock?: () => Date;
  /**
   * Phase 6.3 — optional callback invoked with the freshly-minted
   * `llm_calls.id` BEFORE the upstream call returns. The chat
   * orchestrator uses it to record `chat_pipeline_steps.llm_call_id`
   * without having to query the table back. Invoked exactly once per
   * `chat()` call (success or failure). Errors thrown from the
   * callback are swallowed — telemetry must never break a model call.
   */
  readonly onCall?: (id: string) => void;
}

/**
 * Wraps an `LlmClient` so EVERY call (success or failure) writes one row
 * to `llm_calls`. The wrapper is the only place that knows about
 * redaction, cost estimation, and metadata→column promotion.
 *
 * Metadata convention: telemetry promotes
 * `metadata.correlationId | flowId | layerId | userId` to the matching
 * columns. Unknown metadata keys stay in the (redacted) request JSON so
 * later analyses can recover them.
 *
 * Error path: the wrapper catches, writes the row with `error =
 * String(err)`, `response = null`, `ended_at` and `latency_ms` populated,
 * then re-throws so callers see the original failure.
 */
export function withTelemetry(client: LlmClient, opts: TelemetryOpts): LlmClient {
  const clock = opts.clock ?? ((): Date => new Date());
  const pricing = opts.pricing ?? {};

  return {
    endpoint: client.endpoint,
    defaultModel: client.defaultModel,
    async chat(req: ChatRequest): Promise<ChatResponse> {
      const id = crypto.randomUUID();
      if (opts.onCall !== undefined) {
        try {
          opts.onCall(id);
        } catch {
          // Swallow — telemetry must never break a model call.
        }
      }
      const start = clock();
      const startMs = start.getTime();
      const model = req.model ?? client.defaultModel;
      const meta = req.metadata ?? {};
      const correlationId = stringOrNull(meta.correlationId);
      const flowId = stringOrNull(meta.flowId);
      const layerId = stringOrNull(meta.layerId);
      const userId = stringOrNull(meta.userId);

      const requestJson = JSON.stringify(redact(req));

      try {
        const res = await client.chat(req);
        const end = clock();
        const row: LlmCallRow = {
          id,
          startedAt: start.toISOString(),
          endedAt: end.toISOString(),
          model: res.model || model,
          endpoint: client.endpoint,
          request: requestJson,
          response: JSON.stringify(redact(res)),
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          costUsd: estimateCostUsd(res.model || model, res.tokensIn, res.tokensOut, pricing),
          latencyMs: Math.max(0, end.getTime() - startMs),
          correlationId,
          flowId,
          layerId,
          userId,
          error: null,
        };
        opts.log.write(row);
        return res;
      } catch (err) {
        const end = clock();
        const row: LlmCallRow = {
          id,
          startedAt: start.toISOString(),
          endedAt: end.toISOString(),
          model,
          endpoint: client.endpoint,
          request: requestJson,
          response: null,
          tokensIn: null,
          tokensOut: null,
          costUsd: null,
          latencyMs: Math.max(0, end.getTime() - startMs),
          correlationId,
          flowId,
          layerId,
          userId,
          error: stringifyError(err),
        };
        opts.log.write(row);
        throw err;
      }
    },
  };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ?? `${err.name}: ${err.message}`;
  }
  return String(err);
}
