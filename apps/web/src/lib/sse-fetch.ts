/**
 * Phase 6.5 — SSE-over-`fetch()` helper.
 *
 * The browser's native `EventSource` cannot POST. The phase-6 chat
 * endpoint (`POST /l/:slug/chat/conversations/:id/messages`) returns a
 * `text/event-stream` body in response to a POST with a JSON payload,
 * so we read the response stream by hand and parse the SSE frames in
 * userland.
 *
 * The framing follows the WHATWG SSE spec:
 *   - Frames are separated by a blank line (`\n\n`).
 *   - Inside a frame, each line is `field: value`.
 *   - Recognised fields: `event` (event name), `data` (frame data).
 *   - Multiple `data:` lines in one frame join with `\n`.
 *
 * The helper buffers across chunk boundaries so a single frame split
 * over two `Uint8Array` reads still parses correctly. {@link
 * parseSseFrames} is exported separately so it can be unit-tested with
 * a synthetic byte stream (no DOM, no network).
 *
 * Cancellation: pass an `AbortSignal`. Aborting cancels the in-flight
 * request and finalises the async iterator.
 */

import { ApiError, apiBase } from './api';

export interface SseFrame {
  /** The `event:` field. Defaults to `'message'` when omitted. */
  readonly event: string;
  /** The joined `data:` payload (may be empty). */
  readonly data: string;
}

export interface SseFetchInit {
  readonly method?: 'POST' | 'GET';
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

/**
 * Parse a {@link ReadableStream} of `Uint8Array` chunks into SSE
 * frames. Yields one `SseFrame` per complete frame. Partial lines and
 * partial frames are buffered until the next chunk completes them.
 *
 * The function is exported on its own (not coupled to `fetch`) so it
 * can be exercised from a unit test against a hand-rolled stream.
 */
export async function* parseSseFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<SseFrame, void, void> {
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  for (;;) {
    let chunk: ReadableStreamReadResult<Uint8Array>;
    try {
      chunk = await reader.read();
    } catch {
      // Aborted reader — terminate cleanly. The orchestrator above
      // owns the user-visible error path.
      return;
    }
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    // Split off any complete frames. A frame ends at the first `\n\n`
    // (or `\r\n\r\n`). The remainder stays in `buffer` until the next
    // chunk completes it.
    for (;;) {
      const lf = buffer.indexOf('\n\n');
      const crlf = buffer.indexOf('\r\n\r\n');
      // Prefer the earliest boundary that actually appears.
      const boundary = lf === -1 ? crlf : crlf === -1 ? lf : Math.min(lf, crlf);
      if (boundary === -1) break;
      const isCrlf = boundary === crlf;
      const raw = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + (isCrlf ? 4 : 2));
      const frame = parseSingleFrame(raw);
      if (frame !== null) yield frame;
    }
  }
  // Flush any trailing complete frame the server didn't terminate with
  // a blank line (defensive — should not happen with the Hono writer).
  const tail = buffer.trim();
  if (tail.length > 0) {
    const frame = parseSingleFrame(tail);
    if (frame !== null) yield frame;
  }
}

function parseSingleFrame(raw: string): SseFrame | null {
  // Drop SSE comment frames (lines starting with `:`).
  const lines = raw.split(/\r?\n/);
  let event = 'message';
  const dataParts: string[] = [];
  let seenField = false;
  for (const line of lines) {
    if (line.length === 0) continue;
    if (line.startsWith(':')) continue; // comment / keep-alive
    const colon = line.indexOf(':');
    if (colon === -1) {
      // Spec: a field without a colon is treated as the field name
      // with an empty value. We ignore it for our purposes.
      continue;
    }
    const field = line.slice(0, colon);
    // Per spec, drop one optional space after the colon.
    let value = line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') {
      event = value;
      seenField = true;
    } else if (field === 'data') {
      dataParts.push(value);
      seenField = true;
    }
    // `id` and `retry` are recognised by the spec but we don't need
    // them for the chat surface.
  }
  if (!seenField) return null;
  return { event, data: dataParts.join('\n') };
}

/**
 * Open an SSE connection over `fetch()`. The returned async generator
 * yields one {@link SseFrame} per server frame.
 *
 * Throws {@link ApiError} when the initial response is not 2xx (e.g.
 * `404 errors.chat.notFound`, `400 errors.chat.badRequest`). Once the
 * stream is open, transport errors are surfaced as a thrown
 * `ApiError('errors.network', 0)` so the caller has a single error
 * surface.
 */
export async function* sseFetch(
  path: string,
  init: SseFetchInit = {},
): AsyncGenerator<SseFrame, void, void> {
  const headers: Record<string, string> = {
    accept: 'text/event-stream',
  };
  let bodyText: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = 'application/json';
    bodyText = JSON.stringify(init.body);
  }
  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      method: init.method ?? 'POST',
      credentials: 'include',
      headers,
      ...(bodyText !== undefined ? { body: bodyText } : {}),
      ...(init.signal !== undefined ? { signal: init.signal } : {}),
    });
  } catch {
    throw new ApiError('errors.network', 0);
  }
  if (!res.ok) {
    let errorKey = 'errors.network';
    try {
      const body = (await res.json()) as { error?: string };
      if (typeof body.error === 'string' && body.error.length > 0) {
        errorKey = body.error;
      }
    } catch {
      /* keep fallback */
    }
    throw new ApiError(errorKey, res.status);
  }
  if (res.body === null) {
    // Unexpected — server returned 2xx with no body.
    throw new ApiError('errors.network', res.status);
  }
  const reader = res.body.getReader();
  try {
    yield* parseSseFrames(reader);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}
