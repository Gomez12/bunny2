import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AppConfigSchema, loadConfig } from '../src/config';

function mkTmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bunny2-cfg-'));
}

function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const prev = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
}

describe('loadConfig', () => {
  it('returns defaults when no config file is present', () => {
    const cwd = mkTmp();
    const result = withEnv('BUNNY2_DATA_DIR', undefined, () =>
      withEnv('BUNNY2_CONFIG', undefined, () => loadConfig({ cwd })),
    );

    expect(result.configFile).toBeNull();
    expect(result.config.http.port).toBe(4317);
    expect(result.config.http.host).toBe('127.0.0.1');
    expect(result.dataDir.startsWith(cwd)).toBe(true);
    expect(fs.existsSync(result.dataDir)).toBe(true);
  });

  it('loads config.json from cwd when present', () => {
    const cwd = mkTmp();
    fs.writeFileSync(path.join(cwd, 'config.json'), JSON.stringify({ http: { port: 5050 } }));

    const result = withEnv('BUNNY2_DATA_DIR', undefined, () =>
      withEnv('BUNNY2_CONFIG', undefined, () => loadConfig({ cwd })),
    );

    expect(result.configFile).not.toBeNull();
    expect(result.config.http.port).toBe(5050);
  });

  it('honors BUNNY2_DATA_DIR env override', () => {
    const cwd = mkTmp();
    const otherDir = mkTmp();
    const result = withEnv('BUNNY2_DATA_DIR', otherDir, () =>
      withEnv('BUNNY2_CONFIG', undefined, () => loadConfig({ cwd })),
    );
    expect(result.dataDir).toBe(otherDir);
  });
});

describe('AppConfigSchema', () => {
  it('rejects a non-positive port', () => {
    expect(() => AppConfigSchema.parse({ http: { port: 0 } })).toThrow();
  });

  it('rejects a port above 65535', () => {
    expect(() => AppConfigSchema.parse({ http: { port: 70000 } })).toThrow();
  });

  it('accepts an empty object and fills defaults', () => {
    const parsed = AppConfigSchema.parse({});
    expect(parsed.http.port).toBe(4317);
    expect(parsed.dataDir).toBe('./.data');
  });

  it('fills auth defaults expected by phase 2.2', () => {
    const parsed = AppConfigSchema.parse({});
    expect(parsed.auth.sessionTtlMinutes).toBe(60 * 24 * 14);
    expect(parsed.auth.sessionIdleMinutes).toBe(60 * 24);
  });
});
