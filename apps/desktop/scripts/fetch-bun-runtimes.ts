/**
 * Download the official Bun runtime artifacts for one or more targets
 * into `apps/desktop/vendor/bun/<platform>-<arch>/`. The desktop wrapper
 * spawns this binary as a sidecar (see `apps/desktop/src/sidecar.ts`).
 *
 * Cache by version + platform: skip download if the binary is already
 * present. Hash verification is not implemented — Bun does not publish
 * stable checksum manifests next to releases. Tracked in
 * `docs/dev/follow-ups/bun-runtime-hashes.md`.
 *
 * Usage:
 *   bun run apps/desktop/scripts/fetch-bun-runtimes.ts            # current host only
 *   bun run apps/desktop/scripts/fetch-bun-runtimes.ts --all      # every supported target
 *   bun run apps/desktop/scripts/fetch-bun-runtimes.ts --version=1.3.13
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { platformTag, archTag } from '../src/paths';

// Anchor the vendor dir at this file's location so the script works
// regardless of `cwd`. From this file: ../vendor/bun → apps/desktop/vendor/bun.
const vendorRoot = path.resolve(__dirname, '..', 'vendor', 'bun');

interface Target {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}

const ALL_TARGETS: readonly Target[] = [
  { platform: 'darwin', arch: 'x64' },
  { platform: 'darwin', arch: 'arm64' },
  { platform: 'linux', arch: 'x64' },
  { platform: 'linux', arch: 'arm64' },
  { platform: 'win32', arch: 'x64' },
];

function parseArgs(argv: readonly string[]): { all: boolean; version: string | null } {
  let all = false;
  let version: string | null = null;
  for (const arg of argv) {
    if (arg === '--all') all = true;
    else if (arg.startsWith('--version=')) version = arg.slice('--version='.length);
  }
  return { all, version };
}

function resolveBunVersion(override: string | null): string {
  if (override !== null && override.length > 0) return override;
  // Prefer the host's bun if available and satisfies engines >=1.3.0; the
  // exact pin is documented in the ADR and in `package.json#engines.bun`.
  const result = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (result.status === 0 && typeof result.stdout === 'string') {
    const v = result.stdout.trim();
    if (/^\d+\.\d+\.\d+/.test(v)) return v;
  }
  // Fallback: a pinned-known-good version. Bump this when the package.json
  // engines floor moves.
  return '1.3.13';
}

function bunArtifactName(target: Target): string {
  // Bun releases use these tags. Profile builds are skipped — we want the
  // smallest release-quality binary.
  const plat = platformTag(target.platform);
  const arch = archTag(target.arch);
  return `bun-${plat}-${arch}.zip`;
}

function bunArtifactUrl(version: string, target: Target): string {
  return `https://github.com/oven-sh/bun/releases/download/bun-v${version}/${bunArtifactName(target)}`;
}

function targetDir(target: Target): string {
  return path.join(vendorRoot, `${platformTag(target.platform)}-${archTag(target.arch)}`);
}

function targetBinaryPath(target: Target): string {
  const dir = targetDir(target);
  return path.join(dir, target.platform === 'win32' ? 'bun.exe' : 'bun');
}

async function downloadBinary(version: string, target: Target): Promise<void> {
  const outDir = targetDir(target);
  const outBin = targetBinaryPath(target);
  if (fs.existsSync(outBin)) {
    console.log(`[fetch-bun] cached: ${outBin}`);
    return;
  }
  fs.mkdirSync(outDir, { recursive: true });

  const url = bunArtifactUrl(version, target);
  console.log(`[fetch-bun] fetching ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const tmpZip = path.join(outDir, '.bun.zip.partial');
  fs.writeFileSync(tmpZip, buf);

  // Extract using the platform's available unzip:
  //   macOS/Linux: `unzip` is present on every dev box; on CI we use the
  //                same.
  //   Windows:     `tar -xf` accepts zip and ships with Windows 10+.
  // We pick by the *host* platform (this script runs on the developer's
  // machine), not by the target platform.
  if (process.platform === 'win32') {
    const r = spawnSync('tar', ['-xf', tmpZip, '-C', outDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`tar -xf failed for ${tmpZip}`);
  } else {
    const r = spawnSync('unzip', ['-q', '-o', tmpZip, '-d', outDir], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`unzip failed for ${tmpZip}`);
  }
  fs.unlinkSync(tmpZip);

  // Bun's zip contains a single folder like `bun-<platform>-<arch>/bun`.
  // Move the binary up one level so the resolver in `paths.ts` finds it.
  const inner = fs
    .readdirSync(outDir, { withFileTypes: true })
    .find((d) => d.isDirectory() && d.name.startsWith('bun-'));
  if (inner) {
    const innerDir = path.join(outDir, inner.name);
    const innerBin = path.join(innerDir, target.platform === 'win32' ? 'bun.exe' : 'bun');
    if (fs.existsSync(innerBin)) {
      fs.renameSync(innerBin, outBin);
      fs.rmSync(innerDir, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(outBin)) {
    throw new Error(`expected ${outBin} after extracting ${url}`);
  }
  if (target.platform !== 'win32') {
    fs.chmodSync(outBin, 0o755);
  }
  console.log(`[fetch-bun] installed: ${outBin}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const version = resolveBunVersion(args.version);
  console.log(`[fetch-bun] using Bun v${version}`);

  const targets: readonly Target[] = args.all
    ? ALL_TARGETS
    : [{ platform: process.platform as NodeJS.Platform, arch: os.arch() }];

  for (const t of targets) {
    try {
      await downloadBinary(version, t);
    } catch (err) {
      console.error(
        `[fetch-bun] target ${platformTag(t.platform)}-${archTag(t.arch)} failed:`,
        err,
      );
      process.exitCode = 1;
    }
  }
}

await main();
