import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDatabase } from '../src/storage/sqlite';
import { createSqliteLlmCallLog } from '../src/llm/call-log';
import { createLlmClient } from '../src/llm/client';
import { withTelemetry } from '../src/llm/telemetry';
import { redact } from '../src/llm/redaction';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-llmtel-'));
}

interface Row {
  id: string;
  started_at: string;
  ended_at: string | null;
  model: string;
  endpoint: string;
  request: string;
  response: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  cost_usd: number | null;
  latency_ms: number | null;
  correlation_id: string | null;
  flow_id: string | null;
  layer_id: string | null;
  user_id: string | null;
  error: string | null;
}

describe('LLM telemetry wrapper', () => {
  it('writes one row per successful call with cost and metadata promoted', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const log = createSqliteLlmCallLog(db);
      const raw = createLlmClient({
        endpoint: 'mock://echo',
        apiKey: '',
        defaultModel: 'mock-default',
      });
      const client = withTelemetry(raw, {
        log,
        pricing: { 'mock-default': { inputPerMTokens: 2, outputPerMTokens: 4 } },
      });

      const res = await client.chat({
        messages: [{ role: 'user', content: 'hello' }],
        metadata: {
          correlationId: 'corr-1',
          flowId: 'flow-1',
          layerId: 'layer-1',
          userId: 'user-1',
        },
      });

      expect(res.content).toBe('echo: hello');
      const rows = db.query<Row, []>('SELECT * FROM llm_calls').all();
      expect(rows).toHaveLength(1);
      const row = rows[0];
      if (!row) throw new Error('expected one row');
      expect(row.model).toBe('mock-default');
      expect(row.endpoint).toBe('mock://echo');
      expect(row.error).toBeNull();
      expect(row.response).not.toBeNull();
      expect(row.tokens_in).toBe(res.tokensIn);
      expect(row.tokens_out).toBe(res.tokensOut);
      expect(row.cost_usd).not.toBeNull();
      // 1 in-token * 2/1M + 2 out-tokens * 4/1M = 2e-6 + 8e-6 = 1e-5
      expect(row.cost_usd).toBeCloseTo(
        (res.tokensIn * 2) / 1_000_000 + (res.tokensOut * 4) / 1_000_000,
        12,
      );
      expect(row.correlation_id).toBe('corr-1');
      expect(row.flow_id).toBe('flow-1');
      expect(row.layer_id).toBe('layer-1');
      expect(row.user_id).toBe('user-1');
      expect(row.latency_ms).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it('stores cost_usd as NULL when the model is unknown to pricing', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const log = createSqliteLlmCallLog(db);
      const client = withTelemetry(
        createLlmClient({ endpoint: 'mock://echo', apiKey: '', defaultModel: 'unpriced' }),
        { log },
      );
      await client.chat({ messages: [{ role: 'user', content: 'x' }] });
      const row = db.query<Row, []>('SELECT * FROM llm_calls').get();
      expect(row).not.toBeNull();
      expect(row?.cost_usd).toBeNull();
    } finally {
      db.close();
    }
  });

  it('redacts secrets in the logged request payload', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const log = createSqliteLlmCallLog(db);
      const client = withTelemetry(
        createLlmClient({ endpoint: 'mock://echo', apiKey: '', defaultModel: 'm' }),
        { log },
      );
      await client.chat({
        messages: [
          {
            role: 'user',
            content: 'my key is sk-abcdefghij0123456789 please dont log it',
          },
        ],
        metadata: {
          // Nested object to confirm recursive walk.
          extra: { apiKey: 'top-secret', nested: { secret: 'shh' } },
        },
      });

      const row = db.query<Row, []>('SELECT * FROM llm_calls').get();
      expect(row).not.toBeNull();
      const body = row?.request ?? '';
      expect(body).not.toContain('top-secret');
      expect(body).not.toContain('sk-abcdefghij0123456789');
      expect(body).not.toContain('shh');
      expect(body).toContain('[REDACTED]');
    } finally {
      db.close();
    }
  });

  it('writes a row and re-throws on provider error', async () => {
    const dir = mkTmp();
    const db = openDatabase(dir);
    try {
      const log = createSqliteLlmCallLog(db);
      const client = withTelemetry(
        createLlmClient({ endpoint: 'mock://error', apiKey: '', defaultModel: 'm' }),
        { log },
      );
      await expect(client.chat({ messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(
        /always error/,
      );

      const row = db.query<Row, []>('SELECT * FROM llm_calls').get();
      expect(row).not.toBeNull();
      expect(row?.response).toBeNull();
      expect(row?.error).toMatch(/always error/);
      expect(row?.ended_at).not.toBeNull();
      expect(row?.latency_ms).not.toBeNull();
    } finally {
      db.close();
    }
  });
});

describe('redaction primitive', () => {
  it('masks exact-named secret keys regardless of case', () => {
    const out = redact({
      apiKey: 'a',
      API_KEY: 'b',
      Authorization: 'c',
      bearer: 'd',
      password: 'e',
      secret: 'f',
      token: 'g',
      tokenizer: 'kept',
      secretSanta: 'kept',
    });
    const obj = out as Record<string, unknown>;
    expect(obj.apiKey).toBe('[REDACTED]');
    expect(obj.API_KEY).toBe('[REDACTED]');
    expect(obj.Authorization).toBe('[REDACTED]');
    expect(obj.bearer).toBe('[REDACTED]');
    expect(obj.password).toBe('[REDACTED]');
    expect(obj.secret).toBe('[REDACTED]');
    expect(obj.token).toBe('[REDACTED]');
    expect(obj.tokenizer).toBe('kept');
    expect(obj.secretSanta).toBe('kept');
  });

  it('masks value-pattern secrets anywhere in the tree', () => {
    const out = redact({
      messages: [{ role: 'user', content: 'paste: sk-abcdef0123456789xyz tail' }],
      header: 'Bearer abcdefghij0123456789',
      anthropic: 'sk-ant-aaaaaaaaaaaaaaaa11',
      benign: 'no-secret-here',
    });
    const obj = out as Record<string, unknown>;
    const messages = obj.messages as Array<{ content: string }>;
    expect(messages[0]?.content).not.toContain('sk-abcdef');
    expect(messages[0]?.content).toContain('[REDACTED]');
    expect(obj.header).not.toContain('abcdefghij0123456789');
    expect(obj.anthropic).toBe('[REDACTED]');
    expect(obj.benign).toBe('no-secret-here');
  });
});
