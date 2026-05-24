# LLM client and telemetry

> Status: living document.
> Owners: phase-1.4 introduced this; phase 1.5 wires it into `/chat`.
> Source code: `apps/server/src/llm/`.

This document describes the LLM client, the 100%-logging telemetry
wrapper, the redaction rules that protect the log, the cost-estimation
behaviour, and the retention prune job. Everything that talks to a
language model in bunny2 goes through this pipeline; no domain handler
talks to an external endpoint directly.

---

## 1. Goals

1. **One client interface, multiple backends.** Calling code uses
   `LlmClient.chat(req)` and never imports a provider. Today: `mock://`
   for tests + an OpenAI-compatible HTTP provider. Tomorrow: anything
   that fits the `LlmProvider` interface.
2. **100% logging.** Every call (success or failure) writes one row to
   `llm_calls`. The table is the source of truth for cost, latency,
   token use, and debugging.
3. **No secret leakage.** A user pasting an API key into a prompt, or a
   `metadata` blob with an `apiKey` field, must not land in the SQLite
   file in plaintext.
4. **Self-trimming.** A daily prune job keeps `llm_calls` bounded by a
   configurable retention window (default 180 days).

---

## 2. Interface

```ts
interface ChatMessage {
  readonly role: 'system' | 'user' | 'assistant';
  readonly content: string;
}

interface ChatRequest {
  readonly model?: string;
  readonly messages: readonly ChatMessage[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly metadata?: ChatMetadata; // see §5
}

interface ChatResponse {
  readonly id: string;
  readonly model: string;
  readonly content: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly raw: unknown;
}

interface LlmClient {
  readonly endpoint: string;
  readonly defaultModel: string;
  chat(req: ChatRequest): Promise<ChatResponse>;
}
```

`createLlmClient({ endpoint, apiKey, defaultModel })` returns the
client. The per-call `req.model` (if present) wins over `defaultModel`;
otherwise the default is used. Providers never see `defaultModel` —
the client resolves it before delegating.

---

## 3. Provider selection

Selection is by URL scheme:

| Scheme                | Provider                                 | Used for                        |
| --------------------- | ---------------------------------------- | ------------------------------- |
| `mock://echo`         | `providers/mock.ts` — deterministic echo | Tests, CI, default config seed  |
| `mock://error`        | `providers/mock.ts` — always throws      | Telemetry error-path tests      |
| `http://`, `https://` | `providers/openai-compatible.ts`         | OpenAI, Ollama, LM Studio, etc. |

The OpenAI-compatible provider POSTs to `${endpoint}/chat/completions`
with `Authorization: Bearer ${apiKey}` and the documented request shape
(`model`, `messages`, optional `temperature`, optional `max_tokens`).
The response is validated with a zod schema and only the documented
fields are promoted to first-class values — the full body is preserved
in `ChatResponse.raw` for callers that need provider-specific data.

Non-2xx responses throw with the HTTP status and body text so the
telemetry row captures the failure.

---

## 4. Telemetry row shape

`apps/server/src/llm/telemetry.ts::withTelemetry(client, opts)` wraps
the client. Every call writes one row to `llm_calls`:

| Column           | Source                                          | Notes                                        |
| ---------------- | ----------------------------------------------- | -------------------------------------------- |
| `id`             | `crypto.randomUUID()` per call                  | Independent of the provider's id (`raw.id`). |
| `started_at`     | `clock()` before delegating                     | ISO-8601.                                    |
| `ended_at`       | `clock()` after delegating (success or error)   | ISO-8601.                                    |
| `model`          | provider response `model`, or pre-call model    | Real-call model preferred for accuracy.      |
| `endpoint`       | `client.endpoint`                               | Stable across calls.                         |
| `request`        | redacted, stringified `ChatRequest`             | See §5 for redaction rules.                  |
| `response`       | redacted, stringified `ChatResponse`, or `NULL` | `NULL` on error.                             |
| `tokens_in`      | `ChatResponse.tokensIn`, or `NULL` on error     |                                              |
| `tokens_out`     | `ChatResponse.tokensOut`, or `NULL` on error    |                                              |
| `cost_usd`       | `estimateCostUsd(...)`, `NULL` if unknown       | See §6.                                      |
| `latency_ms`     | wall-clock `ended_at - started_at`              | Measured around the provider call.           |
| `correlation_id` | `metadata.correlationId`                        | See §5.                                      |
| `flow_id`        | `metadata.flowId`                               | See §5.                                      |
| `layer_id`       | `metadata.layerId`                              | See §5 — reserved for phase 3.               |
| `user_id`        | `metadata.userId`                               | See §5 — reserved for phase 2.               |
| `error`          | `String(err)` on failure, `NULL` on success     |                                              |

On error the wrapper writes the row first, then re-throws so callers
see the original failure. This means **the log is the most reliable
record of what happened, even when a downstream caller swallows the
exception**.

---

## 5. Redaction

Phase 1.4 logs 100% of calls, so the redaction rule is the security
boundary for everything that flows through the LLM. The exact rule
(see `apps/server/src/llm/redaction.ts`):

1. **Key match (case-insensitive, exact name).** When a key in any
   object inside the request equals one of:

   ```
   apiKey, api_key, authorization, bearer, password, secret, token
   ```

   the value is replaced with the string `"[REDACTED]"`. Exact name
   match (not substring), so benign names like `tokenizer` or
   `secretSantaNote` are kept.

2. **Value-pattern match (anywhere).** Any string value matching one of
   these regexes is replaced with `"[REDACTED]"`, even when the
   surrounding key is innocuous (e.g. a user paste in `content`):
   - `sk-[A-Za-z0-9_-]{16,}` (OpenAI-style)
   - `sk-ant-[A-Za-z0-9_-]{16,}` (Anthropic-style)
   - `Bearer\s+[A-Za-z0-9_\-.=]{16,}`

3. **Recursive walk.** Objects and arrays are walked; non-object,
   non-array values are passed through unchanged except for the
   value-pattern check on strings.

Things that are deliberately NOT redacted:

- Message `content` other than embedded provider-key shapes. Treating
  the conversation itself as a secret would defeat the point of the
  log; the value-pattern check is the surgical answer to "user pasted
  a key into the prompt".
- The `Authorization: Bearer ${apiKey}` HTTP header. The provider
  never echoes it back into the `ChatRequest` we hand to telemetry, so
  it stays out of the log by construction.

### Metadata convention

`ChatRequest.metadata` is a free-form bag. Telemetry recognises four
keys and promotes them to first-class columns:

| metadata key    | column           | Notes                               |
| --------------- | ---------------- | ----------------------------------- |
| `correlationId` | `correlation_id` | Joins to `events.correlation_id`.   |
| `flowId`        | `flow_id`        | Joins to `events.flow_id`.          |
| `layerId`       | `layer_id`       | Reserved for phase 3 layer scoping. |
| `userId`        | `user_id`        | Reserved for phase 2 auth.          |

Other metadata keys are kept inside the (redacted) request JSON so
later analyses can recover them; they just don't have a column today.

---

## 6. Cost estimation

`apps/server/src/llm/pricing.ts::estimateCostUsd(model, tokensIn, tokensOut, pricing)`.

`pricing` is a `Record<string, { inputPerMTokens: number; outputPerMTokens: number }>`
keyed by model name. Rates are USD per **million** tokens to match how
providers publish their pricing pages.

If the model is not in the pricing map, the function returns `null`
and the column is stored as `NULL`. Per phase-1 plan §11.4, uncertain
values are honest nulls rather than fake zeros. The user fills in
`config.json` `llm.pricing` and either backfills on demand or accepts
gaps in historical data.

Empty pricing config (the default) means `cost_usd` is always `NULL`
until the user populates it — which is the right behaviour for
`mock://` and for any provider whose pricing the user hasn't pinned.

---

## 7. Retention prune

Since phase 5.5, the `llm_calls` retention prune runs through the
generic scheduled-task registry as the `llm.calls.prune` handler
kind (see plan §15 hand-off and `phase-05-scheduled-tasks.md`). The
bespoke `setInterval`-based `startLlmRetentionPrune` is gone; the
pure `pruneLlmCalls({ log, retentionDays, now, logger })` helper in
`apps/server/src/llm/prune.ts` is what the handler invokes on every
tick.

Defaults: 180-day retention, daily cadence (`intervalMinutes = 24 *
60`). On first boot the handler's row is seeded into the `everyone`
layer; admins can pause / resume / change cadence via the layer
settings page (5.6 UI). Per-row config:
`config.retentionDays` overrides the boot default without a code
change.

`retentionDays` boot default still comes from `llm.retentionDays` in
the project config. Tests inject `now` to make the cutoff
deterministic; the `pruneLlmCalls` helper has no timer of its own.

---

## 8. Server wiring

`apps/server/src/index.ts` constructs the pipeline at startup:

```
createSqliteLlmCallLog(db)
  → createLlmClient({ endpoint, apiKey, defaultModel })
    → withTelemetry(rawClient, { log, pricing })
      → registerBuiltInScheduledTaskHandlers({ llmCallLog, llmRetentionDays, ... })
        → seedSystemScheduledTasksIfNeeded({ db, bus, repo })
```

The wrapped client is held at module scope so phase 1.5's chat handler
can consume it directly. The `/status` payload includes
`llm: { endpoint, defaultModel, calls }` so operators can see at a
glance that the pipeline is alive.

---

## 9. How to add a new provider

1. Implement `LlmProvider` in `apps/server/src/llm/providers/<name>.ts`.
   `endpoint` is stable; `chat(req)` accepts a `ChatRequest` with the
   resolved `model` and returns a `ChatResponse`.
2. Extend `client.ts::pickProvider` with the URL scheme that selects
   your provider.
3. Add a unit test alongside the mock and openai-compatible ones. If
   the provider talks HTTP, prefer a `Bun.serve({ port: 0 })` test
   server that captures the outgoing request shape.
4. Pricing entries go into `config.json` `llm.pricing` keyed by the
   model names your provider returns. The telemetry wrapper does the
   rest — no provider-specific code in cost or redaction logic.

---

## 10. Future extensions (not in phase 1.4)

- **Streaming responses.** Today the client returns a single
  `ChatResponse`. Streaming will likely return an async iterator and
  the telemetry wrapper will write the row on completion (or on
  abort), with `tokensOut` derived from the accumulated content.
- **Per-call cost ceilings.** A middleware that rejects calls whose
  estimated cost exceeds a per-flow budget. Sits between the client
  and the telemetry wrapper so the rejection is still logged.
- **Provider-specific adapters.** When a provider's response shape
  diverges materially from OpenAI's (e.g. Anthropic's tool-use), add
  a dedicated adapter behind the same `LlmProvider` interface rather
  than bending the OpenAI-compatible one.
