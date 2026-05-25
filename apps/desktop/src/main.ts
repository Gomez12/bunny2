import * as fs from 'node:fs';
import * as path from 'node:path';
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron';
import {
  resolveBunBinary,
  resolveServerEntry,
  resolveWebIndex,
  resolveSampleConfig,
} from './paths';
import { buildSidecarEnv, pickFreePort, spawnSidecar, type SidecarHandle } from './sidecar';
import { installContextMenu } from './context-menu';

const PRODUCT_NAME = 'bunny2';
// Force Electron to use a clean product name for `userData` resolution.
// Without this, `app.getPath('userData')` derives from `package.json#name`
// (`@bunny2/desktop`) which is an awkward scoped path on disk. Must be
// called BEFORE `app.whenReady()` for the change to apply.
app.setName(PRODUCT_NAME);

const isDev = process.env['BUNNY2_DEV'] === '1';
/**
 * Set by `apps/desktop/scripts/dev.ts` when the dev orchestrator already
 * runs the server itself. In that case Electron should not spawn its own
 * sidecar; the renderer reuses the standalone dev server via the
 * `BUNNY2_API_BASE` env that the dev script also sets.
 */
const skipSidecar = process.env['BUNNY2_SKIP_SIDECAR'] === '1';

/**
 * Resolve where the renderer should load its assets from. When the app
 * is packaged, electron-builder copies our `extraResources` into
 * `process.resourcesPath`; in dev we want the repo's `apps/desktop`
 * directory so resolvers find `resources/` and `vendor/`.
 */
function resolveResourcesRoot(): { resourcesPath: string; isPackaged: boolean } {
  if (app.isPackaged) {
    return { resourcesPath: process.resourcesPath, isPackaged: true };
  }
  // In dev, __dirname is .../apps/desktop/dist; the resource root is one up.
  return {
    resourcesPath: path.resolve(__dirname, '..'),
    isPackaged: false,
  };
}

/**
 * Ensure the per-user data-dir exists and contains a `config.json`. The
 * sample config ships inside the app bundle; we copy it on first run so
 * the user can edit it without having to know where the bundle lives.
 *
 * Returns the path to the config file, or `undefined` if the sample
 * could not be located (in which case the server falls back to schema
 * defaults).
 */
function ensureUserDataDir(opts: { dataDir: string; sampleConfig: string }): string | undefined {
  fs.mkdirSync(opts.dataDir, { recursive: true });
  const target = path.join(opts.dataDir, 'config.json');
  if (fs.existsSync(target)) return target;
  if (!fs.existsSync(opts.sampleConfig)) {
    console.warn(
      `[${PRODUCT_NAME}] sample config not found at ${opts.sampleConfig}; using defaults`,
    );
    return undefined;
  }
  fs.copyFileSync(opts.sampleConfig, target);
  console.log(`[${PRODUCT_NAME}] seeded ${target} from sample`);
  return target;
}

/**
 * Ensure the bundled Bun binary is executable. electron-builder copies
 * `extraResources` but does not preserve the executable bit reliably
 * across the zip → extract round-trip on macOS and Linux. Skipped on
 * Windows where the `.exe` extension carries permission.
 */
function ensureBunExecutable(bunPath: string): void {
  if (process.platform === 'win32') return;
  if (!fs.existsSync(bunPath)) return;
  try {
    fs.chmodSync(bunPath, 0o755);
  } catch (err) {
    console.warn(`[${PRODUCT_NAME}] could not chmod ${bunPath}:`, err);
  }
}

interface AppRuntime {
  sidecar: SidecarHandle | null;
  apiBase: string;
}

const runtime: AppRuntime = { sidecar: null, apiBase: 'http://127.0.0.1:4317' };

type ThemePref = 'light' | 'dark' | 'system';

function isThemePref(v: unknown): v is ThemePref {
  return v === 'light' || v === 'dark' || v === 'system';
}

/**
 * Wire the `set-theme` IPC channel so the renderer can keep
 * `nativeTheme.themeSource` in sync with the in-app theme choice. This
 * is what makes the macOS traffic-light buttons and the Windows title
 * bar follow Light / Dark / System without the user touching OS
 * settings. See `docs/dev/follow-ups/done/dark-light-mode.md`.
 */
function registerThemeIpc(): void {
  ipcMain.handle('set-theme', (_event, pref: unknown) => {
    if (!isThemePref(pref)) {
      console.warn(`[${PRODUCT_NAME}] set-theme: ignoring invalid value`);
      return false;
    }
    nativeTheme.themeSource = pref;
    return true;
  });
}

async function startSidecar(): Promise<void> {
  const { resourcesPath, isPackaged } = resolveResourcesRoot();
  const dataDir = app.getPath('userData');
  const sampleConfig = resolveSampleConfig({ resourcesPath, isPackaged });
  const configFile = ensureUserDataDir({ dataDir, sampleConfig });

  const bunBinary = resolveBunBinary({
    platform: process.platform,
    arch: process.arch,
    resourcesPath,
    isPackaged,
  });
  ensureBunExecutable(bunBinary);

  const serverEntry = resolveServerEntry({ resourcesPath, isPackaged });
  const host = '127.0.0.1';
  const port = await pickFreePort(4317, host);
  runtime.apiBase = `http://${host}:${port}`;

  const env = buildSidecarEnv({
    parentEnv: process.env,
    dataDir,
    configFile,
    host,
    port,
  });
  // The preload reads the API base from its argv (see `preload.ts`).
  // Electron's sandboxed preload does NOT expose `process.env`, so we
  // pass the value via `webPreferences.additionalArguments` instead;
  // see `createWindow` below.

  console.log(`[${PRODUCT_NAME}] bun:    ${bunBinary}`);
  console.log(`[${PRODUCT_NAME}] server: ${serverEntry}`);
  console.log(`[${PRODUCT_NAME}] data:   ${dataDir}`);
  console.log(`[${PRODUCT_NAME}] api:    ${runtime.apiBase}`);

  if (!fs.existsSync(bunBinary)) {
    throw new Error(
      `Bun runtime not found at ${bunBinary}. Run \`bun run scripts/fetch-bun-runtimes.ts\` to download it.`,
    );
  }
  if (!fs.existsSync(serverEntry)) {
    throw new Error(`Server bundle not found at ${serverEntry}. Run \`bun run package\` first.`);
  }

  runtime.sidecar = spawnSidecar({
    bunBinary,
    serverEntry,
    env,
    onStdout: (chunk) => process.stdout.write(`[server] ${chunk}`),
    onStderr: (chunk) => process.stderr.write(`[server] ${chunk}`),
    onExit: (code, signal) => {
      console.log(
        `[${PRODUCT_NAME}] sidecar exited code=${code ?? '<none>'} signal=${signal ?? '<none>'}`,
      );
    },
  });
}

function createWindow(): BrowserWindow {
  const { resourcesPath, isPackaged } = resolveResourcesRoot();
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js'),
      // Sandboxed preloads do NOT see `process.env`. Pass the API base
      // through extra argv instead; `preload.ts` parses
      // `--bunny2-api-base=<url>`. See ADR 0004 §5.
      additionalArguments: [`--bunny2-api-base=${runtime.apiBase}`],
    },
  });
  win.once('ready-to-show', () => win.show());

  installContextMenu(win, { isDev, resourcesPath, isPackaged });

  if (isDev) {
    void win.loadURL(process.env['BUNNY2_DEV_URL'] ?? 'http://localhost:5173');
  } else {
    void win.loadFile(resolveWebIndex({ resourcesPath, isPackaged }));
  }
  return win;
}

async function stopSidecar(): Promise<void> {
  if (runtime.sidecar === null) return;
  await runtime.sidecar.stop();
  runtime.sidecar = null;
}

void app.whenReady().then(async () => {
  registerThemeIpc();
  if (skipSidecar) {
    runtime.apiBase = process.env['BUNNY2_API_BASE'] ?? runtime.apiBase;
    process.env['BUNNY2_API_BASE'] = runtime.apiBase;
    console.log(`[${PRODUCT_NAME}] sidecar skipped (dev); api: ${runtime.apiBase}`);
  } else {
    try {
      await startSidecar();
    } catch (err) {
      console.error(`[${PRODUCT_NAME}] failed to start sidecar:`, err);
      app.quit();
      return;
    }
  }
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void stopSidecar().finally(() => app.quit());
  }
});

app.on('before-quit', (event) => {
  if (runtime.sidecar === null) return;
  event.preventDefault();
  void stopSidecar().finally(() => app.exit(0));
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    void stopSidecar().finally(() => app.exit(0));
  });
}
