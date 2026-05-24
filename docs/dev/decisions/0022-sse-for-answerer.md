# ADR 0022 — SSE for the answerer step

- Status: proposed
- Date: 2026-05-24
- Phase: 6 (sub-phase 6.4; flips to `accepted` in 6.7)
- Related: `docs/dev/plans/phase-06-super-chat.md` §2, §4.4, §6,
  §10, §11; `docs/dev/architecture/chat-pipeline.md` (lands in 6.7);
  ADR [`0020`](./0020-chat-pipeline.md) (the pipeline whose final
  step this ADR transports);
  ADR [`0006`](./0006-http-router-choice.md) (the HTTP framework
  this transport plugs into);
  Source code (lands in 6.4):
  `apps/server/src/llm/client.ts`,
  `apps/server/src/llm/telemetry.ts`,
  `apps/server/src/http/routes/layer-chat.ts`.

---

## Context

The phase-6 chat pipeline is hard-coded as four steps (router →
resolver → retrieval → answerer; ADR 0020). The first three are
fast in absolute terms (tens to hundreds of milliseconds for
router and resolver, an in-process SQL call for retrieval). The
**answerer** is the slow step: an LLM call that can take several
seconds, and where the user benefits from seeing tokens as they
arrive.

The phase-1 chat (`apps/server/src/http/routes/chat.ts`) is a
plain request/response — the client `await`s the JSON and then
shows it. That's fine for a diagnostic; it isn't fine for the
real chat where the user is staring at the screen waiting.

This ADR records the transport choice (SSE vs WebSocket vs
chunked HTTP), the event framing the client expects, and the
telemetry contract (one `llm_calls` row per call, streamed or
not).

---

## Decisions

### 1. SSE, not WebSockets, not raw chunked HTTP

Server-Sent Events for the answerer turn. **One direction**
(server → client), **one connection per assistant message**,
**plain HTTP/1.1**, no upgrade dance.

Rejected: **WebSockets.** The chat is server-push for the
answerer only — the client never streams tokens to the server.
Bidirectional framing would solve a problem we don't have, would
require a new connection lifecycle (open / heartbeat / reconnect),
and would force every reverse proxy / Electron renderer code path
to handle the upgrade. SSE inherits the existing cookie auth,
inherits the existing `requireUser` + `requireLayer` middleware,
and survives every proxy that survives plain HTTP.

Rejected: **raw chunked HTTP (just stream the response body).**
Chunked HTTP gives no event framing — the client would have to
parse a stream of bytes and guess where one token / one
pipeline-step transition ends. SSE's `event:` + `data:` lines
solve framing for free, are part of the platform (`EventSource`),
and are trivially curl-able.

The trade-off SSE forces: **no in-flight cancellation from the
client beyond closing the connection.** That's fine for phase 6.
A "stop generating" button is recorded as a phase-7 follow-up
(plan §Non-decisions); it would need a separate `POST .../abort`
endpoint.

### 2. Four event kinds: `step`, `token`, `done`, `error`

The SSE route emits exactly these event kinds:

```
event: step
data: {"kind":"intent","status":"running","attempt":1}

event: step
data: {"kind":"intent","status":"succeeded","durationMs":312}

event: step
data: {"kind":"entities","status":"running","attempt":1}

event: step
data: {"kind":"entities","status":"succeeded","durationMs":287}

event: step
data: {"kind":"retrieval","status":"succeeded","durationMs":7,"hits":3}

event: step
data: {"kind":"answer","status":"running","attempt":1}

event: token
data: {"delta":"Your meeting "}

event: token
data: {"delta":"with Acme "}

event: token
data: {"delta":"is on Friday."}

event: done
data: {"messageId":"...","tokensIn":841,"tokensOut":12}
```

On hard failure:

```
event: error
data: {"errorKey":"chat.errors.upstream","messageId":"..."}
```

Each `data:` payload is JSON. The web client demuxes on
`event:` and treats unknown events as ignorable (forward-compatible:
phase 7 may add e.g. `event: feedback-hint`).

The `step` events for router / resolver / retrieval are emitted
**before** any `token` event — those steps complete before the
answerer call starts. The Kanban subscribes to the same SSE
stream for live updates on the active conversation; the
short-poll path (`GET /l/:slug/chat/board?since=...`) is the
fallback for inactive conversations.

### 3. One `llm_calls` row per LLM call, streamed or not

The phase-1 telemetry contract — one row per LLM call with
prompt, response, tokens_in/out, latency, correlation, layer,
user — is preserved. The streaming variant of `withTelemetry`
buffers chunks, computes `tokens_out` and `latency_ms` when the
stream closes (success or error), and writes **one** row. The
`response` column carries the full collected content; the
`raw` column carries the upstream's stream-encoded response if
the provider returns one (OpenAI's `delta` chunks coalesced).

Rejected: **one row per chunk.** Would balloon `llm_calls` by
~50–500x with no diagnostic gain — the chunks are reconstructible
from one row's `response` column.

Rejected: **no telemetry on streamed calls.** Would break the
`overall.md` §4 "100% message logging on every LLM path"
invariant. Streamed calls cost real tokens; they get logged like
everything else.

On client abort mid-stream: the partial response is collected up
to that point, persisted to `chat_messages.content`, the row is
marked `failed`, and **one** `llm_calls` row is written with the
partial response and `error = 'client_aborted'`. The web client
uses `EventSource`'s `close()` plus `AbortController` on the
fetch fallback path.

### 4. SSE lifecycle is the HTTP request lifecycle

The SSE handler:

- Opens with `Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `X-Accel-Buffering: no` (defang
  proxies that buffer).
- Pushes a `: keepalive\n\n` comment line every 15 seconds to
  defeat idle-connection killers. (`EventSource` ignores comment
  lines.)
- Caps the total stream duration at **60 seconds** (configurable).
  On timeout: emits `event: error` with
  `errorKey: 'chat.errors.upstream'` and closes. The message is
  marked `failed`.
- On normal completion: emits `event: done`, then closes the
  writer in a `finally` block so a misbehaving LLM client cannot
  leak the connection.

No keepalive ping is required by `EventSource`, but the 15-second
comment protects against the most common deployment surface
(Electron's bundled net proxy and any future reverse proxy).

---

## Consequences

- `apps/server/src/llm/types.ts` grows an optional
  `chatStream(req: ChatRequest): AsyncIterable<ChatChunk>` method
  on `LlmClient`. The non-streaming `chat(...)` stays exactly as
  it is; phase-1 callers don't change.
- `apps/server/src/llm/telemetry.ts` grows a streaming wrapper
  that consumes the async iterable, collects, and writes one row
  on close.
- The web app gains its first SSE consumer
  (`apps/web/src/pages/LayerChatPage.tsx`). Native `EventSource`
  is sufficient — Electron's Chromium has had it forever, and
  there is no plan for non-Electron clients in v1.
- A future Postgres backend (ADR 0002 "Postgres later") does not
  change the transport — SSE is a delivery contract, not a
  storage one. The `llm_calls` row still lands wherever
  `LlmCallLog` writes.
- Curl-debuggable: `curl -N -b cookies.txt
http://localhost:.../messages -X POST ...` streams events as
  plain text, which speeds up smoke testing.

---

## Non-decisions (intentional)

- **No SSE for the non-answerer steps individually.** Router /
  resolver / retrieval emit `step` events on the same SSE stream,
  but none of them stream their **content** chunk-by-chunk. They
  return small JSON blobs; the `output_json` is in
  `chat_pipeline_steps` for anyone who wants to inspect.
- **No HTTP/2 server-push.** SSE works fine on HTTP/1.1; HTTP/2
  is opt-in at the reverse-proxy layer and doesn't change the
  framing.
- **No reconnect / `Last-Event-ID` resume.** A dropped connection
  fails the message. The user re-asks. The complexity of correct
  resumption (preserving generation state across reconnect)
  outweighs the user benefit in v1.
- **No fan-out to multiple subscribers per message.** The SSE
  stream is 1:1 with the request. The Kanban board's other-tab
  view of the same message uses the short-poll fallback (or the
  bus → server-push bridge, which is a phase-7 follow-up if it's
  needed at all).
- **No compression on the SSE stream.** Chunks are tiny; the
  default `Content-Encoding: identity` is correct. Compression
  would buffer chunks and defeat the streaming.
