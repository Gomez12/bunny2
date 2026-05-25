/**
 * Build all the things the Electron app expects under
 * `apps/desktop/resources/` and `apps/desktop/vendor/`. Run before
 * `electron-builder` so the artifact has everything it needs to run.
 *
 * Steps (cross-platform; no shell tricks):
 *   1. Build the web bundle (`apps/web/dist`) and copy it to
 *      `apps/desktop/resources/web`.
 *   2. Bundle the server (`apps/server`) with `bun build --target=bun`
 *      into `apps/desktop/resources/server/`. LanceDB's native asset is
 *      emitted alongside automatically.
 *   3. Copy the SQLite migrations next to the bundle so the runtime
 *      resolver in `apps/server/src/storage/sqlite.ts` finds them via
 *      `import.meta.url`.
 *   4. Fetch the Bun runtime for the current host (or for `--all` when
 *      cross-target builds are intended).
 *
 * This script never reads `process.cwd()`. Every path is anchored on
 * `__dirname` so it works whether the script is invoked from the repo
 * root or from inside `apps/desktop`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const here = __dirname;
const desktopRoot = path.resolve(here, '..');
const repoRoot = path.resolve(desktopRoot, '..', '..');
const resourcesDir = path.join(desktopRoot, 'resources');

function run(name: string, cmd: string, args: string[], cwd: string): void {
  console.log(`[prepare] ${name}: ${cmd} ${args.join(' ')} (cwd=${cwd})`);
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) {
    throw new Error(`${name} failed (exit ${r.status ?? '<none>'})`);
  }
}

function cleanDir(p: string): void {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
  fs.mkdirSync(p, { recursive: true });
}

function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  fs.cpSync(src, dst, { recursive: true });
}

function buildWeb(): void {
  console.log('[prepare] building web bundle');
  run('web build', 'bun', ['run', '--filter', '@bunny2/web', 'build'], repoRoot);
  const src = path.join(repoRoot, 'apps', 'web', 'dist');
  const dst = path.join(resourcesDir, 'web');
  cleanDir(dst);
  copyDir(src, dst);
  console.log(`[prepare] web -> ${dst}`);
}

function buildServer(): void {
  console.log('[prepare] bundling server');
  const dst = path.join(resourcesDir, 'server');
  cleanDir(dst);
  const entry = path.join(repoRoot, 'apps', 'server', 'src', 'index.ts');
  run('server bundle', 'bun', ['build', entry, '--target=bun', `--outdir=${dst}`], repoRoot);
  // Copy migrations next to the bundle. The bundled `sqlite.ts` resolves
  // the migrations dir from `import.meta.url`, which becomes the bundle's
  // own directory at runtime.
  const migrationsSrc = path.join(repoRoot, 'apps', 'server', 'src', 'storage', 'migrations');
  const migrationsDst = path.join(dst, 'migrations');
  copyDir(migrationsSrc, migrationsDst);
  console.log(`[prepare] server -> ${dst}`);
}

function copyLocales(): void {
  // Mirror the renderer's locale JSON so Electron main can resolve
  // user-facing labels (e.g. right-click menu, see
  // `apps/desktop/src/context-menu.ts`) without bundling i18next or
  // growing the preload IPC surface.
  const src = path.join(repoRoot, 'apps', 'web', 'src', 'i18n', 'locales');
  const dst = path.join(resourcesDir, 'locales');
  cleanDir(dst);
  copyDir(src, dst);
  console.log(`[prepare] locales -> ${dst}`);
}

function fetchBun(args: readonly string[]): void {
  console.log('[prepare] fetching Bun runtime');
  const script = path.join(desktopRoot, 'scripts', 'fetch-bun-runtimes.ts');
  run('fetch-bun', 'bun', ['run', script, ...args], repoRoot);
}

function buildDesktopTs(): void {
  console.log('[prepare] compiling Electron main + preload');
  run('desktop tsc', 'bun', ['run', '--filter', '@bunny2/desktop', 'build'], repoRoot);
}

function main(): void {
  const all = process.argv.includes('--all');
  const skipFetch = process.argv.includes('--skip-fetch');

  fs.mkdirSync(resourcesDir, { recursive: true });

  buildWeb();
  buildServer();
  copyLocales();
  buildDesktopTs();
  if (!skipFetch) {
    fetchBun(all ? ['--all'] : []);
  }
  console.log('[prepare] done');
}

main();
