import { describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import {
  archTag,
  platformTag,
  resolveBunBinary,
  resolveSampleConfig,
  resolveServerEntry,
  resolveWebIndex,
} from '../src/paths';

describe('platformTag', () => {
  it('maps Node platform names to Bun release tags', () => {
    expect(platformTag('darwin')).toBe('darwin');
    expect(platformTag('linux')).toBe('linux');
    expect(platformTag('win32')).toBe('windows');
  });

  it('throws on an unsupported platform', () => {
    expect(() => platformTag('aix' as NodeJS.Platform)).toThrow();
  });
});

describe('archTag', () => {
  it('maps Node arch names to Bun release tags', () => {
    expect(archTag('x64')).toBe('x64');
    expect(archTag('arm64')).toBe('aarch64');
    expect(archTag('aarch64')).toBe('aarch64');
  });

  it('throws on an unsupported arch', () => {
    expect(() => archTag('s390x')).toThrow();
  });
});

describe('resolveBunBinary', () => {
  it('produces the packaged path on macOS arm64', () => {
    const p = resolveBunBinary({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: '/Applications/bunny2.app/Contents/Resources',
      isPackaged: true,
    });
    expect(p).toBe(
      path.join('/Applications/bunny2.app/Contents/Resources', 'bun', 'darwin-aarch64', 'bun'),
    );
  });

  it('produces the packaged path on Linux x64', () => {
    const p = resolveBunBinary({
      platform: 'linux',
      arch: 'x64',
      resourcesPath: '/opt/bunny2/resources',
      isPackaged: true,
    });
    expect(p).toBe(path.join('/opt/bunny2/resources', 'bun', 'linux-x64', 'bun'));
  });

  it('produces a `.exe` path on Windows', () => {
    const p = resolveBunBinary({
      platform: 'win32',
      arch: 'x64',
      resourcesPath: 'C:\\bunny2\\resources',
      isPackaged: true,
    });
    expect(p.endsWith('bun.exe')).toBe(true);
    expect(p).toContain(`bun${path.sep}windows-x64${path.sep}bun.exe`);
  });

  it('uses the dev `vendor/bun` layout when not packaged', () => {
    const p = resolveBunBinary({
      platform: 'darwin',
      arch: 'arm64',
      resourcesPath: '/repo/apps/desktop',
      isPackaged: false,
    });
    expect(p).toBe(path.join('/repo/apps/desktop', 'vendor', 'bun', 'darwin-aarch64', 'bun'));
  });
});

describe('resolveServerEntry / resolveWebIndex / resolveSampleConfig', () => {
  it('returns paths next to the resources root when packaged', () => {
    const args = { resourcesPath: '/r', isPackaged: true } as const;
    expect(resolveServerEntry(args)).toBe(path.join('/r', 'server', 'index.js'));
    expect(resolveWebIndex(args)).toBe(path.join('/r', 'web', 'index.html'));
    expect(resolveSampleConfig(args)).toBe(path.join('/r', 'config.sample.json'));
  });

  it('returns paths under `resources/` when in dev', () => {
    const args = { resourcesPath: '/repo/apps/desktop', isPackaged: false } as const;
    expect(resolveServerEntry(args)).toBe(
      path.join('/repo/apps/desktop', 'resources', 'server', 'index.js'),
    );
    expect(resolveWebIndex(args)).toBe(
      path.join('/repo/apps/desktop', 'resources', 'web', 'index.html'),
    );
    expect(resolveSampleConfig(args)).toBe(
      path.join('/repo/apps/desktop', 'resources', 'config.sample.json'),
    );
  });
});
