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
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..', '..');

interface Child {
  readonly name: string;
  readonly proc: ChildProcess;
}

const children: Child[] = [];

function start(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = {}): Child {
  const proc = spawn(cmd, args, {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  proc.stdout?.setEncoding('utf8');
  proc.stderr?.setEncoding('utf8');
  proc.stdout?.on('data', (chunk: string) => process.stdout.write(`[${name}] ${chunk}`));
  proc.stderr?.on('data', (chunk: string) => process.stderr.write(`[${name}] ${chunk}`));
  proc.on('exit', (code, signal) => {
    console.log(`[dev] ${name} exited code=${code ?? '<none>'} signal=${signal ?? '<none>'}`);
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
installSignalHandlers();

start('web', 'bun', ['run', '--filter', '@bunny2/web', 'dev']);
start('server', 'bun', ['run', '--filter', '@bunny2/server', 'dev']);

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
