import { describe, expect, it } from 'bun:test';
import { appName, appVersion } from '@bunny2/shared';

describe('shared metadata', () => {
  it('exposes a non-empty app name', () => {
    expect(appName).toBeTruthy();
    expect(typeof appName).toBe('string');
  });

  it('exposes a semver-like version string', () => {
    expect(appVersion).toMatch(/^\d+\.\d+\.\d+/);
  });
});
