import * as path from 'node:path';

/**
 * Pure resolvers for the desktop wrapper. No `process.*` reads happen
 * inside these functions — every input is passed in by the caller, which
 * is what makes the tests in `tests/paths.test.ts` runnable on any host
 * without mocking globals.
 */

export interface ResolveBunBinaryInput {
  /** `process.platform` */
  readonly platform: NodeJS.Platform;
  /** `process.arch` */
  readonly arch: string;
  /** `process.resourcesPath` in packaged builds, or the repo `apps/desktop` root in dev. */
  readonly resourcesPath: string;
  /** `true` when running inside an electron-builder bundle. */
  readonly isPackaged: boolean;
}

/**
 * Resolve the path to the Bun runtime executable for the current target.
 *
 * Packaged layout (electron-builder `extraResources`):
 *   <resourcesPath>/bun/<platform>-<arch>/bun(.exe)
 *
 * Dev layout (running `bun run dev` from the repo):
 *   <resourcesPath>/vendor/bun/<platform>-<arch>/bun(.exe)
 *
 * If a system `bun` is on PATH we still return the bundled path — the
 * caller decides whether to fall back. Keeping this function pure means
 * the test suite does not have to mock PATH lookups.
 */
export function resolveBunBinary(input: ResolveBunBinaryInput): string {
  const exe = input.platform === 'win32' ? 'bun.exe' : 'bun';
  const targetDir = `${platformTag(input.platform)}-${archTag(input.arch)}`;
  const root = input.isPackaged
    ? path.join(input.resourcesPath, 'bun')
    : path.join(input.resourcesPath, 'vendor', 'bun');
  return path.join(root, targetDir, exe);
}

export interface ResolveServerEntryInput {
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
}

/**
 * Resolve the path to the bundled server entry point (`index.js`).
 *
 * Packaged layout: `<resourcesPath>/server/index.js`.
 * Dev layout:      `<resourcesPath>/resources/server/index.js`.
 */
export function resolveServerEntry(input: ResolveServerEntryInput): string {
  const dir = input.isPackaged
    ? path.join(input.resourcesPath, 'server')
    : path.join(input.resourcesPath, 'resources', 'server');
  return path.join(dir, 'index.js');
}

export interface ResolveWebIndexInput {
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
}

/** Path to `index.html` of the built Vite renderer. */
export function resolveWebIndex(input: ResolveWebIndexInput): string {
  const dir = input.isPackaged
    ? path.join(input.resourcesPath, 'web')
    : path.join(input.resourcesPath, 'resources', 'web');
  return path.join(dir, 'index.html');
}

export interface ResolveSampleConfigInput {
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
}

/** Path to the shipped sample config that is copied into the user's data-dir on first run. */
export function resolveSampleConfig(input: ResolveSampleConfigInput): string {
  return input.isPackaged
    ? path.join(input.resourcesPath, 'config.sample.json')
    : path.join(input.resourcesPath, 'resources', 'config.sample.json');
}

/**
 * Tag the platform the way Bun's release artifacts do.
 * Bun publishes `darwin`, `linux`, `windows` (not `win32`).
 */
export function platformTag(platform: NodeJS.Platform): 'darwin' | 'linux' | 'windows' {
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  throw new Error(`unsupported platform: ${platform}`);
}

/** Tag the arch the way Bun's release artifacts do (`x64`, `aarch64`). */
export function archTag(arch: string): 'x64' | 'aarch64' {
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64' || arch === 'aarch64') return 'aarch64';
  throw new Error(`unsupported arch: ${arch}`);
}
