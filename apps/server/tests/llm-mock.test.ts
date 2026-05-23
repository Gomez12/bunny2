import { describe, expect, it } from 'bun:test';
import { createLlmClient } from '../src/llm/client';

describe('mock LLM provider', () => {
  it('echoes the last user message back as content', async () => {
    const client = createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    });
    const res = await client.chat({
      messages: [
        { role: 'system', content: 'you are a test' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'second turn' },
      ],
    });
    expect(res.content).toBe('echo: second turn');
    expect(res.model).toBe('mock-default');
    expect(res.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('honours per-call model override', async () => {
    const client = createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    });
    const res = await client.chat({
      model: 'gpt-foo',
      messages: [{ role: 'user', content: 'q' }],
    });
    expect(res.model).toBe('gpt-foo');
  });

  it('reports token counts as a 4-chars-per-token approximation', async () => {
    const client = createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'm',
    });
    const res = await client.chat({
      // 8 chars in -> 2 tokens, "echo: 12345678" = 14 chars out -> 3 tokens
      messages: [{ role: 'user', content: '12345678' }],
    });
    expect(res.tokensIn).toBe(2);
    expect(res.tokensOut).toBe(3);
  });

  it('throws when the endpoint is mock://error', async () => {
    const client = createLlmClient({
      endpoint: 'mock://error',
      apiKey: '',
      defaultModel: 'm',
    });
    await expect(client.chat({ messages: [{ role: 'user', content: 'q' }] })).rejects.toThrow(
      /mock provider configured to always error/,
    );
  });

  it('rejects unknown mock endpoints at construction', () => {
    expect(() =>
      createLlmClient({
        endpoint: 'mock://nope',
        apiKey: '',
        defaultModel: 'm',
      }),
    ).toThrow(/unknown mock endpoint/);
  });
});
