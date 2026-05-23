import { describe, expect, it } from 'bun:test';
import { InMemoryMessageBus } from '@bunny2/bus';
import { createApp } from '../src/http/router';
import type { StatusBody } from '../src/http/router';
import { createLlmClient } from '../src/llm/client';

describe('GET /status', () => {
  it('returns the injected status body shape with phase 1.7', async () => {
    const bus = new InMemoryMessageBus();
    const llmClient = createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    });
    const body: StatusBody = {
      app: 'bunny2',
      version: '0.0.0',
      phase: '1.7',
      ok: true,
      dataDir: '/tmp/example',
      configFile: null,
      sqlite: { schemaVersion: '0001_init' },
      lancedb: { ready: true, tables: [] },
      bus: { adapter: 'in-memory', events: 0 },
      llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
    };

    const app = createApp({ bus, llmClient, status: () => body });
    const res = await app.fetch(new Request('http://localhost/status'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as StatusBody;
    expect(json).toEqual(body);
    expect(json.phase).toBe('1.7');
  });
});
