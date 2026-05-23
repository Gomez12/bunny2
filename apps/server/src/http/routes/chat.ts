import type { Hono } from 'hono';
import { z } from 'zod';
import type { AppDeps, HonoVariables } from '../types';

const ChatRequestBodySchema = z.object({
  message: z.string().min(1, 'message must be a non-empty string'),
  model: z.string().min(1).optional(),
});

/**
 * Payload shape for the `chat.requested` event. Kept inline because phase
 * 1.5 only has one producer; promote to `packages/shared/` if a second
 * producer appears.
 */
export interface ChatRequestedPayload {
  readonly message: string;
  readonly model: string | null;
}

export interface ChatRespondedPayload {
  readonly content: string;
  readonly model: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly latencyMs: number;
}

export interface ChatFailedPayload {
  readonly model: string | null;
  readonly error: string;
}

/**
 * Mounts `POST /chat`. The handler:
 *
 * 1. Validates the body with zod.
 * 2. Mints a `correlationId` and `flowId` (both UUIDs).
 * 3. Publishes `chat.requested`.
 * 4. Calls the (already telemetry-wrapped) LLM client.
 * 5. Publishes `chat.responded` on success, or `chat.failed` on error.
 * 6. Returns 200 with the response shape, or 502 with a localizable error
 *    key on upstream failure.
 *
 * The `errors.chat.upstream` value returned on failure is an i18n key —
 * not an English string — so the frontend can render it in the user's
 * locale. `AGENTS.md` forbids hardcoded user-facing strings.
 */
export function mountChatRoute(app: Hono<{ Variables: HonoVariables }>, deps: AppDeps): void {
  app.post('/chat', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'errors.chat.badRequest' }, 400);
    }
    const parsed = ChatRequestBodySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'errors.chat.badRequest' }, 400);
    }

    const { message } = parsed.data;
    const modelOverride = parsed.data.model;
    const correlationId = crypto.randomUUID();
    const flowId = crypto.randomUUID();

    const requestedPayload: ChatRequestedPayload = {
      message,
      model: modelOverride ?? null,
    };
    await deps.bus.publish<ChatRequestedPayload>({
      type: 'chat.requested',
      payload: requestedPayload,
      correlationId,
      flowId,
    });

    const startedAt = Date.now();
    try {
      const res = await deps.llmClient.chat({
        messages: [{ role: 'user', content: message }],
        ...(modelOverride !== undefined ? { model: modelOverride } : {}),
        metadata: { correlationId, flowId },
      });
      const latencyMs = Math.max(0, Date.now() - startedAt);

      const respondedPayload: ChatRespondedPayload = {
        content: res.content,
        model: res.model,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        latencyMs,
      };
      await deps.bus.publish<ChatRespondedPayload>({
        type: 'chat.responded',
        payload: respondedPayload,
        correlationId,
        flowId,
      });

      return c.json({
        content: res.content,
        model: res.model,
        tokensIn: res.tokensIn,
        tokensOut: res.tokensOut,
        correlationId,
      });
    } catch (err) {
      const failedPayload: ChatFailedPayload = {
        model: modelOverride ?? null,
        error: err instanceof Error ? err.message : String(err),
      };
      await deps.bus.publish<ChatFailedPayload>({
        type: 'chat.failed',
        payload: failedPayload,
        correlationId,
        flowId,
      });
      return c.json({ error: 'errors.chat.upstream', correlationId }, 502);
    }
  });
}
