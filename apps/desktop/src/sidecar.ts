import * as net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Build the env object passed to the Bun sidecar. Pure for testability.
 *
 * The sidecar inherits the parent env (so PATH, locale, etc. survive),
 * then we layer the bunny2-specific bits on top. Anything explicitly
 * `undefined` is dropped — Node's `spawn` treats `{ KEY: undefined }`
 * inconsistently across platforms.
 */
export interface BuildSidecarEnvInput {
  readonly parentEnv: NodeJS.ProcessEnv;
  readonly dataDir: string;
  /** Path to the user's `config.json`. Skipped if absent — server falls back to defaults. */
  readonly configFile: string | undefined;
  readonly host: string;
  readonly port: number;
}

export function buildSidecarEnv(input: BuildSidecarEnvInput): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.parentEnv };
  env['BUNNY2_DATA_DIR'] = input.dataDir;
  env['BUNNY2_HTTP_HOST'] = input.host;
  env['BUNNY2_HTTP_PORT'] = String(input.port);
  if (input.configFile !== undefined && input.configFile.length > 0) {
    env['BUNNY2_CONFIG'] = input.configFile;
  } else {
    delete env['BUNNY2_CONFIG'];
  }
  return env;
}

/**
 * Build the argv passed to the Bun runtime. Today the only argument is
 * the path to the bundled server entry; kept as a separate pure function
 * to mirror env-building and to leave room for future flags
 * (e.g. `--smol`, `--bun`) without touching the spawn site.
 */
export function buildSidecarArgs(input: { readonly serverEntry: string }): readonly string[] {
  return [input.serverEntry];
}

/**
 * Find a free TCP port on the loopback interface. Asks the kernel for
 * one via `listen(0)` and returns whatever it hands back. Falls back
 * to the preferred port if it's free.
 *
 * The race window between closing the probe socket and the sidecar
 * binding is small enough on loopback that we accept it for phase 1;
 * a true atomic hand-off would require sending the file descriptor to
 * the child, which Bun does not expose yet.
 */
export async function pickFreePort(preferred = 4317, host = '127.0.0.1'): Promise<number> {
  // Try the preferred port first so the user sees a stable URL across
  // restarts when nothing else is on 4317.
  const preferredOk = await isPortFree(preferred, host);
  if (preferredOk) return preferred;
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        server.close();
        reject(new Error('failed to obtain a free port'));
        return;
      }
      const port = addr.port;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

function isPortFree(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once('error', () => {
      resolve(false);
    });
    server.once('listening', () => {
      server.close(() => {
        resolve(true);
      });
    });
    server.listen(port, host);
  });
}

/**
 * Spawn the Bun sidecar. The `spawn` dependency is injected so unit
 * tests can record the call without actually starting a process.
 */
export interface SpawnSidecarOptions {
  readonly bunBinary: string;
  readonly serverEntry: string;
  readonly env: NodeJS.ProcessEnv;
  readonly onStdout?: (chunk: string) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  /** Default uses `child_process.spawn`. Tests pass a stub. */
  readonly spawn?: typeof spawn;
}

export interface SidecarHandle {
  readonly pid: number | undefined;
  readonly child: ChildProcess;
  stop(timeoutMs?: number): Promise<void>;
}

export function spawnSidecar(opts: SpawnSidecarOptions): SidecarHandle {
  const spawner = opts.spawn ?? spawn;
  const child = spawner(opts.bunBinary, buildSidecarArgs({ serverEntry: opts.serverEntry }), {
    env: opts.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  if (opts.onStdout && child.stdout !== null) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', opts.onStdout);
  }
  if (opts.onStderr && child.stderr !== null) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', opts.onStderr);
  }
  if (opts.onExit) {
    child.on('exit', opts.onExit);
  }

  let stopped = false;
  const stop = async (timeoutMs = 5_000): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode !== null || child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const onExit = (): void => {
        clearTimeout(killTimer);
        resolve();
      };
      child.once('exit', onExit);
      try {
        child.kill('SIGTERM');
      } catch {
        // Already gone; resolve.
        resolve();
        return;
      }
      const killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already gone; fall through.
        }
      }, timeoutMs);
    });
  };

  return { pid: child.pid, child, stop };
}
