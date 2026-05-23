import { describe, expect, it } from 'bun:test';
import { createLlmClient } from '../src/llm/client';

interface CapturedRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: unknown;
}

interface ServerHandle {
  port: number;
  stop: () => void;
  captured: CapturedRequest[];
}

function startMockOpenAi(response: unknown, status = 200): ServerHandle {
  const captured: CapturedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req): Promise<Response> {
      const body: unknown = await req.json();
      captured.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.get('authorization'),
        contentType: req.headers.get('content-type'),
        body,
      });
      return new Response(JSON.stringify(response), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const port = server.port;
  if (typeof port !== 'number') {
    server.stop(true);
    throw new Error('Bun.serve did not return a numeric port');
  }
  return {
    port,
    stop: () => server.stop(true),
    captured,
  };
}

describe('OpenAI-compatible LLM provider', () => {
  it('posts the documented chat-completions shape with bearer auth', async () => {
    const server = startMockOpenAi({
      id: 'cmpl-1',
      model: 'gpt-test',
      choices: [{ message: { role: 'assistant', content: 'hello world' } }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    });
    try {
      const client = createLlmClient({
        endpoint: `http://localhost:${server.port}`,
        apiKey: 'sk-testsecret-1234567890ab',
        defaultModel: 'gpt-test',
      });
      const res = await client.chat({
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.2,
        maxTokens: 16,
      });

      expect(res.id).toBe('cmpl-1');
      expect(res.model).toBe('gpt-test');
      expect(res.content).toBe('hello world');
      expect(res.tokensIn).toBe(7);
      expect(res.tokensOut).toBe(3);

      expect(server.captured).toHaveLength(1);
      const req = server.captured[0];
      if (!req) throw new Error('expected captured request');
      expect(req.method).toBe('POST');
      expect(req.url).toBe(`http://localhost:${server.port}/chat/completions`);
      expect(req.authorization).toBe('Bearer sk-testsecret-1234567890ab');
      expect(req.contentType).toBe('application/json');
      expect(req.body).toEqual({
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        temperature: 0.2,
        max_tokens: 16,
      });
    } finally {
      server.stop();
    }
  });

  it('throws on non-2xx responses including status and body text', async () => {
    const server = startMockOpenAi({ error: 'nope' }, 500);
    try {
      const client = createLlmClient({
        endpoint: `http://localhost:${server.port}`,
        apiKey: 'k',
        defaultModel: 'm',
      });
      await expect(client.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
        /LLM HTTP 500/,
      );
    } finally {
      server.stop();
    }
  });

  it('reports zero tokens when usage is missing', async () => {
    const server = startMockOpenAi({
      id: 'cmpl-2',
      model: 'm',
      choices: [{ message: { role: 'assistant', content: 'ok' } }],
    });
    try {
      const client = createLlmClient({
        endpoint: `http://localhost:${server.port}`,
        apiKey: 'k',
        defaultModel: 'm',
      });
      const res = await client.chat({ messages: [{ role: 'user', content: 'x' }] });
      expect(res.tokensIn).toBe(0);
      expect(res.tokensOut).toBe(0);
    } finally {
      server.stop();
    }
  });
});
