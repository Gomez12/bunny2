import { contextBridge, ipcRenderer } from 'electron';

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
 *
 * The one IPC channel we DO expose, `setTheme`, lets the renderer keep
 * Electron's `nativeTheme.themeSource` in sync so the title bar / window
 * chrome (especially on Windows) follows the in-app theme. See
 * `docs/dev/follow-ups/done/dark-light-mode.md`.
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

type ThemePref = 'light' | 'dark' | 'system';

function isThemePref(v: unknown): v is ThemePref {
  return v === 'light' || v === 'dark' || v === 'system';
}

contextBridge.exposeInMainWorld('bunny2', {
  apiBase,
  /**
   * Forward the renderer's theme choice to the main process. Validates
   * here too so a bad value never reaches IPC. Fire-and-forget: the
   * renderer doesn't need a response — the visual flip happens locally
   * via the `.dark` class on `<html>` regardless of the bridge.
   */
  setTheme(pref: unknown): void {
    if (!isThemePref(pref)) return;
    void ipcRenderer.invoke('set-theme', pref).catch(() => {
      /* main-side handler logs; renderer keeps going either way */
    });
  },
});
