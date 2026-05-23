import { contextBridge } from 'electron';

/**
 * The only thing the renderer can read from the host: where to send HTTP
 * requests. The base URL is passed to this preload via
 * `BrowserWindow.webPreferences.additionalArguments` (rendered as extra
 * argv on the sandboxed preload). We use `additionalArguments` rather
 * than `process.env` because Electron's sandboxed preload exposes a
 * stripped-down `process` object that does NOT include `env` — see
 * Electron docs / sandbox.md.
 *
 * The web app reads this through `window.bunny2.apiBase` and falls back
 * to `import.meta.env.VITE_API_BASE` then the schema default. Keeping
 * the surface this small means we never grow accidental IPC channels;
 * ADR 0004 commits us to "renderer talks HTTP only".
 */

const FLAG = '--bunny2-api-base=';

function readApiBaseFromArgv(): string | null {
  for (const arg of process.argv) {
    if (typeof arg === 'string' && arg.startsWith(FLAG)) {
      const v = arg.slice(FLAG.length);
      if (v.length > 0) return v;
    }
  }
  return null;
}

const apiBase = readApiBaseFromArgv() ?? 'http://127.0.0.1:4317';

contextBridge.exposeInMainWorld('bunny2', { apiBase });
