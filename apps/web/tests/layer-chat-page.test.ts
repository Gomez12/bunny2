/**
 * Phase 6.5 — pure-logic tests for the layer-chat page.
 *
 * The web app has no DOM test runtime (see
 * `docs/dev/follow-ups/web-component-tests.md`), so the parts of the
 * page that would normally be exercised through `@testing-library/react`
 * live in `layer-chat-page-state.ts` and are exercised directly here.
 *
 * Covers:
 *  - Composer Enter / Shift+Enter / Cmd+Enter behavior.
 *  - Pipeline-step reducer folding `step` SSE events into a map with
 *    a stable four-step ordering.
 *  - Server `event: error` `message` field mapping to the page's
 *    `chat.errors.*` namespace.
 *  - Sentence-boundary buffering for the `aria-live="polite"` region.
 *  - SSE-over-`fetch()` parser: framing across chunk boundaries,
 *    multiple events in one chunk, `event: token` parsing, comment
 *    frames.
 *  - Content-length bucketing for analytics (no raw content sent).
 */
import { describe, expect, it } from 'bun:test';
import {
  applyPipelineStepFrame,
  bucketContentLength,
  emptyPipelineStepMap,
  mapServerErrorToChatErrorKey,
  PIPELINE_STEP_ORDER,
  shouldComposerSubmit,
  splitForAnnouncement,
  type PipelineStepFrame,
} from '../src/pages/layer-chat-page-state';
import { parseSseFrames, type SseFrame } from '../src/lib/sse-fetch';

describe('shouldComposerSubmit', () => {
  it('submits on plain Enter', () => {
    expect(shouldComposerSubmit({ key: 'Enter', shiftKey: false })).toBe(true);
  });

  it('does not submit when Shift+Enter is pressed', () => {
    expect(shouldComposerSubmit({ key: 'Enter', shiftKey: true })).toBe(false);
  });

  it('does not submit on non-Enter keys', () => {
    expect(shouldComposerSubmit({ key: 'a', shiftKey: false })).toBe(false);
    expect(shouldComposerSubmit({ key: 'Tab', shiftKey: false })).toBe(false);
  });

  it('does not submit when Cmd+Enter or Ctrl+Enter is pressed (lets the IME / multiline shortcut win)', () => {
    expect(shouldComposerSubmit({ key: 'Enter', shiftKey: false, metaKey: true })).toBe(false);
    expect(shouldComposerSubmit({ key: 'Enter', shiftKey: false, ctrlKey: true })).toBe(false);
  });
});

describe('emptyPipelineStepMap', () => {
  it('seeds one pending entry per pipeline step in canonical order', () => {
    const map = emptyPipelineStepMap();
    expect(map.size).toBe(4);
    for (const kind of PIPELINE_STEP_ORDER) {
      expect(map.has(kind)).toBe(true);
      expect(map.get(kind)?.status).toBe('pending');
    }
  });
});

describe('applyPipelineStepFrame', () => {
  it('updates a single step without disturbing the others', () => {
    const seed = emptyPipelineStepMap();
    const frame: PipelineStepFrame = {
      stepKind: 'intent',
      status: 'running',
      attempt: 1,
    };
    const next = applyPipelineStepFrame(seed, frame);
    expect(next.get('intent')?.status).toBe('running');
    expect(next.get('entities')?.status).toBe('pending');
    expect(next.get('retrieval')?.status).toBe('pending');
    expect(next.get('answer')?.status).toBe('pending');
  });

  it('records duration and error code on a terminal step transition', () => {
    const seed = emptyPipelineStepMap();
    const next = applyPipelineStepFrame(seed, {
      stepKind: 'answer',
      status: 'failed',
      attempt: 2,
      errorCode: 'invalid_step_output',
      durationMs: 1234,
    });
    expect(next.get('answer')?.status).toBe('failed');
    expect(next.get('answer')?.errorCode).toBe('invalid_step_output');
    expect(next.get('answer')?.durationMs).toBe(1234);
    expect(next.get('answer')?.attempt).toBe(2);
  });

  it('returns a new map (no mutation of the input)', () => {
    const seed = emptyPipelineStepMap();
    const next = applyPipelineStepFrame(seed, {
      stepKind: 'intent',
      status: 'running',
      attempt: 1,
    });
    expect(next).not.toBe(seed);
    expect(seed.get('intent')?.status).toBe('pending');
  });
});

describe('mapServerErrorToChatErrorKey', () => {
  it('maps every key the 6.4 SSE route emits', () => {
    expect(mapServerErrorToChatErrorKey('errors.chat.streamAborted')).toBe(
      'chat.errors.streamAborted',
    );
    expect(mapServerErrorToChatErrorKey('errors.chat.upstream')).toBe('chat.errors.upstream');
    expect(mapServerErrorToChatErrorKey('errors.chat.badRequest')).toBe('chat.errors.validation');
    expect(mapServerErrorToChatErrorKey('errors.chat.notFound')).toBe('chat.errors.validation');
    expect(mapServerErrorToChatErrorKey('errors.layer.notVisible')).toBe(
      'chat.errors.layerNotVisible',
    );
    expect(mapServerErrorToChatErrorKey('errors.network')).toBe('chat.errors.network');
  });

  it('falls back to chat.errors.upstream for unknown keys', () => {
    expect(mapServerErrorToChatErrorKey('errors.something.unknown')).toBe('chat.errors.upstream');
    expect(mapServerErrorToChatErrorKey('')).toBe('chat.errors.upstream');
    expect(mapServerErrorToChatErrorKey(undefined)).toBe('chat.errors.upstream');
  });

  it('passes through keys already in the chat.errors.* namespace', () => {
    expect(mapServerErrorToChatErrorKey('chat.errors.intentInvalid')).toBe(
      'chat.errors.intentInvalid',
    );
  });
});

describe('splitForAnnouncement', () => {
  it('keeps everything pending while no sentence boundary is present', () => {
    expect(splitForAnnouncement('Hello world')).toEqual({
      announce: '',
      pending: 'Hello world',
    });
  });

  it('announces up to the last sentence boundary and keeps the tail pending', () => {
    const r = splitForAnnouncement('Hello world. This is a tail');
    expect(r.announce).toBe('Hello world. ');
    expect(r.pending).toBe('This is a tail');
  });

  it('treats ? and ! as sentence boundaries', () => {
    expect(splitForAnnouncement('Right? Yes!').announce).toBe('Right? Yes!');
    expect(splitForAnnouncement('Wait! And ').announce).toBe('Wait! ');
    expect(splitForAnnouncement('Wait! And ').pending).toBe('And ');
  });

  it('handles a single sentence terminated at end of string', () => {
    expect(splitForAnnouncement('Done.')).toEqual({ announce: 'Done.', pending: '' });
  });
});

describe('parseSseFrames (SSE-over-fetch parser)', () => {
  function streamOf(chunks: readonly string[]): ReadableStreamDefaultReader<Uint8Array> {
    const enc = new TextEncoder();
    const remaining = chunks.slice();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        const next = remaining.shift();
        if (next === undefined) {
          controller.close();
          return;
        }
        controller.enqueue(enc.encode(next));
      },
    });
    return stream.getReader();
  }

  async function collect(gen: AsyncGenerator<SseFrame, void, void>): Promise<readonly SseFrame[]> {
    const out: SseFrame[] = [];
    for await (const frame of gen) {
      out.push(frame);
    }
    return out;
  }

  it('parses a single step frame', async () => {
    const reader = streamOf(['event: step\ndata: {"stepKind":"intent","status":"running"}\n\n']);
    const frames = await collect(parseSseFrames(reader));
    expect(frames).toEqual([{ event: 'step', data: '{"stepKind":"intent","status":"running"}' }]);
  });

  it('parses multiple frames in one chunk', async () => {
    const reader = streamOf([
      'event: step\ndata: {"a":1}\n\nevent: token\ndata: {"delta":"hi"}\n\n',
    ]);
    const frames = await collect(parseSseFrames(reader));
    expect(frames).toEqual([
      { event: 'step', data: '{"a":1}' },
      { event: 'token', data: '{"delta":"hi"}' },
    ]);
  });

  it('buffers a frame split across two chunks', async () => {
    const reader = streamOf(['event: token\ndata: {"del', 'ta":"hello"}\n\n']);
    const frames = await collect(parseSseFrames(reader));
    expect(frames).toEqual([{ event: 'token', data: '{"delta":"hello"}' }]);
  });

  it('handles a frame boundary split across two chunks', async () => {
    const reader = streamOf(['event: done\ndata: {"ok":true}\n', '\n']);
    const frames = await collect(parseSseFrames(reader));
    expect(frames).toEqual([{ event: 'done', data: '{"ok":true}' }]);
  });

  it('joins multiple data: lines with newline (per spec)', async () => {
    const reader = streamOf(['event: foo\ndata: line1\ndata: line2\n\n']);
    const frames = await collect(parseSseFrames(reader));
    expect(frames).toEqual([{ event: 'foo', data: 'line1\nline2' }]);
  });

  it('skips comment frames starting with `:`', async () => {
    const reader = streamOf([': keep-alive\n\nevent: done\ndata: {}\n\n']);
    const frames = await collect(parseSseFrames(reader));
    expect(frames).toEqual([{ event: 'done', data: '{}' }]);
  });

  it('handles CRLF line endings', async () => {
    const reader = streamOf(['event: step\r\ndata: {"x":1}\r\n\r\n']);
    const frames = await collect(parseSseFrames(reader));
    expect(frames).toEqual([{ event: 'step', data: '{"x":1}' }]);
  });

  it('drops the leading space after the colon (per spec)', async () => {
    const reader = streamOf(['event:step\ndata:hello\n\n']);
    const frames = await collect(parseSseFrames(reader));
    expect(frames).toEqual([{ event: 'step', data: 'hello' }]);
  });
});

describe('bucketContentLength', () => {
  it('returns coarse buckets that do not leak raw lengths', () => {
    expect(bucketContentLength('')).toBe('xs');
    expect(bucketContentLength('x'.repeat(31))).toBe('xs');
    expect(bucketContentLength('x'.repeat(32))).toBe('sm');
    expect(bucketContentLength('x'.repeat(127))).toBe('sm');
    expect(bucketContentLength('x'.repeat(128))).toBe('md');
    expect(bucketContentLength('x'.repeat(511))).toBe('md');
    expect(bucketContentLength('x'.repeat(512))).toBe('lg');
    expect(bucketContentLength('x'.repeat(2047))).toBe('lg');
    expect(bucketContentLength('x'.repeat(2048))).toBe('xl');
  });
});
