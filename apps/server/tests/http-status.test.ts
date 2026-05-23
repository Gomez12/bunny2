import { describe, expect, it } from 'bun:test';
import { InMemoryMessageBus } from '@bunny2/bus';
import { createApp } from '../src/http/router';
import type { StatusBody } from '../src/http/router';
import { createLlmClient } from '../src/llm/client';

describe('GET /status', () => {
  it('returns the injected status body shape with the auth section', async () => {
    const bus = new InMemoryMessageBus();
    const llmClient = createLlmClient({
      endpoint: 'mock://echo',
      apiKey: '',
      defaultModel: 'mock-default',
    });
    const body: StatusBody = {
      app: 'bunny2',
      version: '0.0.0',
      phase: '2.1',
      ok: true,
      dataDir: '/tmp/example',
      configFile: null,
      sqlite: { schemaVersion: '0002_users_groups' },
      lancedb: { ready: true, tables: [] },
      bus: { adapter: 'in-memory', events: 0 },
      llm: { endpoint: 'mock://echo', defaultModel: 'mock-default', calls: 0 },
      auth: { sessions: 0, users: 0, groups: 0 },
    };

    const app = createApp({ bus, llmClient, status: () => body });
    const res = await app.fetch(new Request('http://localhost/status'));
    expect(res.status).toBe(200);
    const json = (await res.json()) as StatusBody;
    expect(json).toEqual(body);
    expect(json.phase).toBe('2.1');
    expect(json.auth).toEqual({ sessions: 0, users: 0, groups: 0 });
  });
});
