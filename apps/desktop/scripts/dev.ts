/**
 * Bun-native dev orchestrator for the desktop wrapper.
 *
 * Starts three processes:
 *   1. Vite (`@bunny2/web`) on :5173 — the renderer.
 *   2. The Bun server (`@bunny2/server`) on its configured port — the API.
 *   3. Electron with BUNNY2_DEV=1 — loads Vite at :5173, talks to the server.
 *
 * We deliberately do not use `concurrently` or `npm-run-all`: the rules in
 * `AGENTS.md` (Bun-first, cross-platform, no shell tricks) make a small
 * Bun script the lower-friction choice. The script also handles graceful
 * shutdown on SIGINT/SIGTERM so closing the terminal does not orphan any
 * child process.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

// Per-child log files under `apps/server/.data/dev-logs/<name>.log`.
// `bun run --filter '@bunny2/desktop' dev` collapses interleaved
// stdout to the last ~10 lines, so anything more than a handful of
// log lines is gone from the terminal before you can read it.
// Writing the raw streams to disk gives a `tail -f`-able trace that
// survives the filter's compaction. Each restart truncates the file
// so the log reflects only the current process.
const logDir = path.join(repoRoot, 'apps', 'server', '.data', 'dev-logs');
fs.mkdirSync(logDir, { recursive: true });

interface Child {
  readonly name: string;
  readonly proc: ChildProcess;
}

const children: Child[] = [];
// Tracked separately so the source-watch loop can replace this child on
// restart without leaving stale entries in `children`. `stopAll` keys off
// `exitCode`/`signalCode` so a dead entry there is harmless, but the
// separate handle keeps the restart path obvious.
let serverChild: Child | null = null;

function start(
  name: string,
  cmd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  cwd: string = repoRoot,
): Child {
  const proc = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  // Open a fresh log file for this child. 'w' truncates on each
  // (re)spawn so the file shows only the current process — old runs
  // are gone, but `tail -f` survives the orchestrator restart loop.
  const logPath = path.join(logDir, `${name}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: 'w', encoding: 'utf8' });
  proc.stdout?.on('data', (chunk: string) => {
    process.stdout.write(`[${name}] ${chunk}`);
    logStream.write(chunk);
  });
  proc.stderr?.on('data', (chunk: string) => {
    process.stderr.write(`[${name}] ${chunk}`);
    logStream.write(chunk);
  });
  proc.on('exit', (code, signal) => {
    console.log(`[dev] ${name} exited code=${code ?? '<none>'} signal=${signal ?? '<none>'}`);
    logStream.end();
  });
  const child = { name, proc };
  children.push(child);
  return child;
}

async function stopAll(): Promise<void> {
  await Promise.all(
    children.map(
      ({ name, proc }) =>
        new Promise<void>((resolve) => {
          if (proc.exitCode !== null || proc.signalCode !== null) {
            resolve();
            return;
          }
          const killTimer = setTimeout(() => {
            try {
              proc.kill('SIGKILL');
            } catch {
              // already dead
            }
          }, 5_000);
          proc.once('exit', () => {
            clearTimeout(killTimer);
            console.log(`[dev] stopped ${name}`);
            resolve();
          });
          try {
            proc.kill('SIGTERM');
          } catch {
            clearTimeout(killTimer);
            resolve();
          }
        }),
    ),
  );
}

function installSignalHandlers(): void {
  let stopping = false;
  const handler = (sig: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    console.log(`[dev] received ${sig}, shutting down…`);
    void stopAll().finally(() => process.exit(0));
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  process.on('exit', () => {
    // Best-effort sync cleanup if exit was bypassed.
    for (const { proc } of children) {
      try {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  });
}

// Start order:
//   1. server first — Electron will try to spawn its own sidecar; in dev we
//      override that by setting BUNNY2_API_BASE on Electron's env to point
//      at this server instead. We also disable Electron's sidecar
//      auto-spawn via BUNNY2_SKIP_SIDECAR=1 (handled in main.ts? — no, the
//      simpler approach is just to let Electron spawn its sidecar too,
//      because in dev there's no bundled binary, so Electron's spawn will
//      fail. Instead we tell Electron to use this server and not to spawn.)
//
// To keep things simple for phase 1.6, dev mode here runs the server as a
// standalone process and the desktop app reuses the same one. We emit a
// clear log so the developer sees both startup messages interleaved.
/**
 * Spawn the server child and remember it as the active handle.
 *
 * We spawn `bun src/index.ts` directly with `cwd=apps/server` rather than
 * going through `bun run --filter '@bunny2/server' dev`. The filter form
 * creates an intermediate Bun process that owns the real server as a
 * grandchild; SIGTERM to that intermediate does not reliably propagate to
 * the grandchild, leaving port 4317 bound and causing EADDRINUSE on the
 * next restart. Spawning directly keeps the server as a single child the
 * orchestrator can stop cleanly. Workspace deps resolve through the
 * node_modules symlinks that `bun install` creates.
 */
function startServer(): void {
  serverChild = start('server', 'bun', ['src/index.ts'], {}, path.join(repoRoot, 'apps', 'server'));
}

/**
 * Stop the current server child gracefully (SIGTERM, then SIGKILL after a
 * short grace period) and resolve once it has actually exited.
 */
async function stopServer(): Promise<void> {
  const current = serverChild;
  if (current === null) return;
  const { proc } = current;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const killTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already dead
      }
    }, 3_000);
    proc.once('exit', () => {
      clearTimeout(killTimer);
      resolve();
    });
    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(killTimer);
      resolve();
    }
  });
}

/**
 * Watch server-side TypeScript sources and restart the server child when
 * they change. Renderer changes are not handled here — Vite already has
 * its own watcher.
 *
 * Design:
 *   - Recursive `fs.watch` on `apps/server/src` and each `packages/*\/src`.
 *     Bun and Node 20+ both support `{ recursive: true }` on macOS,
 *     Windows, and Linux. We wrap each watch in try/catch so a single
 *     platform regression logs a clear message instead of crashing.
 *   - Filter callbacks to `.ts`/`.tsx`/`.json` files outside `node_modules`
 *     and `dist` segments.
 *   - 250ms debounce: dev edits land in bursts.
 *   - Single-flight: a `restarting` flag plus a `pendingRestart` boolean
 *     means at most one restart runs at a time, and at most one
 *     follow-up restart is queued no matter how many events arrive
 *     during the in-flight one.
 */
function installSourceWatcher(): void {
  const watchTargets: string[] = [];
  const serverSrc = path.join(repoRoot, 'apps', 'server', 'src');
  if (fs.existsSync(serverSrc)) watchTargets.push(serverSrc);

  const packagesDir = path.join(repoRoot, 'packages');
  if (fs.existsSync(packagesDir)) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgSrc = path.join(packagesDir, entry.name, 'src');
      if (fs.existsSync(pkgSrc)) watchTargets.push(pkgSrc);
    }
  }

  const allowedExt = new Set(['.ts', '.tsx', '.json']);
  const ignoredSegments = ['node_modules', 'dist', '.turbo', '.cache'];

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let restarting = false;
  let pendingRestart = false;

  const restartServer = async (): Promise<void> => {
    if (restarting) {
      pendingRestart = true;
      return;
    }
    restarting = true;
    const startedAt = Date.now();
    console.log('[dev] server source changed, restarting…');
    try {
      await stopServer();
      startServer();
    } finally {
      const elapsed = Date.now() - startedAt;
      console.log(`[dev] server restarted in ${elapsed}ms`);
      restarting = false;
      if (pendingRestart) {
        pendingRestart = false;
        // Schedule next restart on the next tick so callers see the
        // current one complete first.
        setTimeout(() => void restartServer(), 0);
      }
    }
  };

  const trigger = (): void => {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void restartServer();
    }, 250);
  };

  for (const target of watchTargets) {
    try {
      const watcher = fs.watch(target, { recursive: true }, (_event, filename) => {
        if (filename === null) return;
        const rel = typeof filename === 'string' ? filename : String(filename);
        if (ignoredSegments.some((seg) => rel.split(path.sep).includes(seg))) return;
        const ext = path.extname(rel);
        if (!allowedExt.has(ext)) return;
        trigger();
      });
      watcher.on('error', (err) => {
        console.warn(`[dev] watcher error on ${target}: ${(err as Error).message}`);
      });
      console.log(`[dev] watching ${path.relative(repoRoot, target)} for restarts`);
    } catch (err) {
      console.warn(
        `[dev] could not watch ${target}: ${(err as Error).message}. Server auto-restart disabled for this path.`,
      );
    }
  }
}

installSignalHandlers();

start('web', 'bun', ['run', '--filter', '@bunny2/web', 'dev']);
startServer();
installSourceWatcher();

// Give Vite and the server a moment to begin listening so Electron's
// first load doesn't race them; the renderer would just retry, but the
// console output is cleaner this way.
await new Promise((resolve) => setTimeout(resolve, 1_500));

// `BUNNY2_API_BASE` deliberately uses `localhost`, not `127.0.0.1`:
// Vite serves the renderer from `http://localhost:5173`, and the
// session cookie is `SameSite=Lax`. Chromium treats `localhost` and
// `127.0.0.1` as different sites, so a Lax cookie set by the server
// would not be sent back on subsequent fetches from the renderer. Both
// hostnames resolve to the same `127.0.0.1` interface the server binds
// to (`apps/server/src/config/schema.ts`), so connectivity is identical
// — only the SameSite computation changes.
start('electron', 'bun', ['run', '--filter', '@bunny2/desktop', 'electron:dev'], {
  BUNNY2_DEV: '1',
  BUNNY2_DEV_URL: 'http://localhost:5173',
  BUNNY2_SKIP_SIDECAR: '1',
  BUNNY2_API_BASE: 'http://localhost:4317',
});
