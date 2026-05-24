/**
 * Phase 6.3 — unit tests for the pipeline step helpers.
 *
 * Pins:
 *  - `extractJsonObject` strips a `json` fence and survives a
 *    surrounding-prose preamble (defensive: real models sometimes
 *    leak prose even after a "JSON only" system prompt).
 *  - `InvalidStepOutputError` carries the `error_code` the
 *    orchestrator writes to `chat_pipeline_steps.error_code`.
 *  - Each step's zod schema rejects malformed shapes.
 */

import { describe, expect, it } from 'bun:test';
import { extractJsonObject, InvalidStepOutputError } from '../../src/chat/pipeline/step-utils';
import {
  IntentOutputSchema,
  EntitiesOutputSchema,
  RetrievalOutputSchema,
  AnswerOutputSchema,
} from '../../src/chat/pipeline/types';

describe('extractJsonObject', () => {
  it('parses plain JSON', () => {
    expect(extractJsonObject('{"a":1}')).toEqual({ a: 1 });
  });

  it('strips a ```json fenced block', () => {
    const raw = '```json\n{"intent":"smalltalk"}\n```';
    expect(extractJsonObject(raw)).toEqual({ intent: 'smalltalk' });
  });

  it('strips a bare ``` fenced block', () => {
    const raw = '```\n{"intent":"smalltalk"}\n```';
    expect(extractJsonObject(raw)).toEqual({ intent: 'smalltalk' });
  });

  it('falls back to the first balanced {...} on surrounding prose', () => {
    const raw = 'Sure! Here you go: {"intent":"smalltalk"} — done.';
    expect(extractJsonObject(raw)).toEqual({ intent: 'smalltalk' });
  });

  it('returns null on empty input', () => {
    expect(extractJsonObject('')).toBeNull();
    expect(extractJsonObject('   ')).toBeNull();
  });

  it('returns null when nothing parses', () => {
    expect(extractJsonObject('totally not json')).toBeNull();
  });
});

describe('InvalidStepOutputError', () => {
  it('carries the stable error code the orchestrator persists', () => {
    const err = new InvalidStepOutputError('intent', 'bad shape');
    expect(err.errorCode).toBe('invalid_step_output');
    expect(err.stepKind).toBe('intent');
    expect(err.message).toContain('intent');
    expect(err.message).toContain('bad shape');
  });
});

describe('step output zod schemas', () => {
  it('IntentOutputSchema rejects an unknown intent', () => {
    const r = IntentOutputSchema.safeParse({ intent: 'gibberish' });
    expect(r.success).toBe(false);
  });

  it('IntentOutputSchema accepts a clean payload', () => {
    const r = IntentOutputSchema.safeParse({
      intent: 'question.entity_lookup',
      confidence: 0.7,
    });
    expect(r.success).toBe(true);
  });

  it('EntitiesOutputSchema rejects an unknown kind', () => {
    const r = EntitiesOutputSchema.safeParse({
      kinds: ['mystery'],
      queryHints: [],
    });
    expect(r.success).toBe(false);
  });

  it('EntitiesOutputSchema rejects empty queryHints terms', () => {
    const r = EntitiesOutputSchema.safeParse({
      kinds: ['company'],
      queryHints: [{ term: '' }],
    });
    expect(r.success).toBe(false);
  });

  it('RetrievalOutputSchema caps `text` at 400 chars', () => {
    const longText = 'x'.repeat(401);
    const r = RetrievalOutputSchema.safeParse({
      hits: [
        {
          id: '1',
          kind: 'company',
          layerId: 'L',
          slug: 's',
          title: 't',
          text: longText,
        },
      ],
      skipped: false,
    });
    expect(r.success).toBe(false);
  });

  it('AnswerOutputSchema requires non-negative token counts', () => {
    const r = AnswerOutputSchema.safeParse({
      content: 'hi',
      tokensIn: -1,
      tokensOut: 0,
      model: 'm',
      skipped: false,
    });
    expect(r.success).toBe(false);
  });
});
