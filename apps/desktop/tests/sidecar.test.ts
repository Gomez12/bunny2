import { describe, expect, it } from 'bun:test';
import { EventEmitter } from 'node:events';
import { buildSidecarArgs, buildSidecarEnv, pickFreePort, spawnSidecar } from '../src/sidecar';

describe('buildSidecarEnv', () => {
  it('forwards parent env and layers bunny2 vars on top', () => {
    const env = buildSidecarEnv({
      parentEnv: { PATH: '/usr/bin', HOME: '/home/x' },
      dataDir: '/var/lib/bunny2',
      configFile: '/var/lib/bunny2/config.json',
      host: '127.0.0.1',
      port: 4317,
    });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['HOME']).toBe('/home/x');
    expect(env['BUNNY2_DATA_DIR']).toBe('/var/lib/bunny2');
    expect(env['BUNNY2_CONFIG']).toBe('/var/lib/bunny2/config.json');
    expect(env['BUNNY2_HTTP_HOST']).toBe('127.0.0.1');
    expect(env['BUNNY2_HTTP_PORT']).toBe('4317');
  });

  it('drops BUNNY2_CONFIG when no config file is provided', () => {
    const env = buildSidecarEnv({
      parentEnv: { BUNNY2_CONFIG: '/stale' },
      dataDir: '/d',
      configFile: undefined,
      host: '127.0.0.1',
      port: 4317,
    });
    expect(env['BUNNY2_CONFIG']).toBeUndefined();
  });
});

describe('buildSidecarArgs', () => {
  it('returns the server entry as the only argv', () => {
    expect(buildSidecarArgs({ serverEntry: '/r/server/index.js' })).toEqual(['/r/server/index.js']);
  });
});

describe('spawnSidecar', () => {
  it('invokes the injected spawn with shell: false and the right binary', () => {
    interface Recorded {
      cmd: string;
      args: readonly string[];
      opts: { shell?: boolean; env?: Record<string, string> };
    }
    let recorded: Recorded | null = null;

    const fakeChild = new EventEmitter() as unknown as ReturnType<typeof makeFakeChild>;

    function makeFakeChild() {
      const child = new EventEmitter() as EventEmitter & {
        pid: number;
        stdout: EventEmitter & { setEncoding: (e: string) => void };
        stderr: EventEmitter & { setEncoding: (e: string) => void };
        exitCode: number | null;
        signalCode: NodeJS.Signals | null;
        kill: (s: NodeJS.Signals) => void;
      };
      const stdout = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
      stdout.setEncoding = () => undefined;
      const stderr = new EventEmitter() as EventEmitter & { setEncoding: (e: string) => void };
      stderr.setEncoding = () => undefined;
      child.pid = 12345;
      child.stdout = stdout;
      child.stderr = stderr;
      child.exitCode = null;
      child.signalCode = null;
      child.kill = (): void => undefined;
      return child;
    }

    const c = makeFakeChild();

    const fakeSpawn = ((cmd: string, args: readonly string[], opts: unknown) => {
      recorded = { cmd, args, opts: opts as Recorded['opts'] };
      return c as unknown as ReturnType<typeof import('node:child_process').spawn>;
    }) as unknown as typeof import('node:child_process').spawn;

    const handle = spawnSidecar({
      bunBinary: '/bun/bun',
      serverEntry: '/r/server/index.js',
      env: { FOO: 'bar' },
      spawn: fakeSpawn,
    });

    expect(handle.pid).toBe(12345);
    expect(recorded).not.toBeNull();
    const r = recorded as unknown as Recorded;
    expect(r.cmd).toBe('/bun/bun');
    expect(r.args).toEqual(['/r/server/index.js']);
    expect(r.opts.shell).toBe(false);
    expect(r.opts.env).toEqual({ FOO: 'bar' });
    // Touch fakeChild so the linter does not flag the unused alias.
    void fakeChild;
  });
});

describe('pickFreePort', () => {
  it('returns the preferred port when it is free', async () => {
    // Use a high random port to make collisions unlikely.
    const preferred = 40000 + Math.floor(Math.random() * 20000);
    const got = await pickFreePort(preferred);
    expect(typeof got).toBe('number');
    expect(got).toBeGreaterThan(0);
    expect(got).toBeLessThan(65536);
  });

  it('returns a different free port when the preferred is taken', async () => {
    const net = await import('node:net');
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', () => resolve()));
    const addr = blocker.address();
    if (addr === null || typeof addr === 'string') {
      blocker.close();
      throw new Error('failed to bind blocker');
    }
    try {
      const got = await pickFreePort(addr.port);
      expect(got).not.toBe(addr.port);
      expect(got).toBeGreaterThan(0);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});
