/**
 * Phase 5.2 — `parseRole` unit tests. The parser is the only path
 * `apps/server/src/index.ts` uses to derive its role, so every branch
 * matters: CLI flag (with and without `=`), env-var fallback, default,
 * unknown-value rejection.
 *
 * Pure-fixture tests — no temp dir, no `process.argv` / `process.env`
 * mutation, no subprocess. The parser is dependency-free by design so
 * the test fixture is just two array / record arguments.
 */
import { describe, expect, it } from 'bun:test';
import {
  DEFAULT_PROCESS_ROLE,
  PROCESS_ROLES,
  ROLE_ENV_VAR,
  parseRole,
  type ProcessRole,
} from '../src/role';

describe('parseRole', () => {
  it('defaults to `all` when neither flag nor env is set', () => {
    expect(parseRole()).toBe('all');
    expect(parseRole({ argv: [], env: {} })).toBe('all');
    expect(DEFAULT_PROCESS_ROLE).toBe('all');
  });

  it('accepts every valid role via --role=<value>', () => {
    for (const role of PROCESS_ROLES) {
      expect(parseRole({ argv: [`--role=${role}`] })).toBe(role);
    }
  });

  it('accepts every valid role via two-arg --role <value>', () => {
    for (const role of PROCESS_ROLES) {
      expect(parseRole({ argv: ['--role', role] })).toBe(role);
    }
  });

  it('rejects an unknown --role value with a helpful message', () => {
    expect(() => parseRole({ argv: ['--role=admin'] })).toThrow(/--role: unknown value "admin"/);
    expect(() => parseRole({ argv: ['--role', 'admin'] })).toThrow(/--role: unknown value "admin"/);
  });

  it('rejects an empty --role value', () => {
    // Both shapes ("--role" with no following arg AND "--role=" with
    // empty value after the `=`) collapse to the same "no value
    // supplied" error so the failure mode is consistent.
    expect(() => parseRole({ argv: ['--role'] })).toThrow(/--role requires a value/);
    expect(() => parseRole({ argv: ['--role='] })).toThrow(/--role requires a value/);
  });

  it('falls back to BUNNY2_ROLE when the flag is absent', () => {
    for (const role of PROCESS_ROLES) {
      expect(parseRole({ argv: [], env: { [ROLE_ENV_VAR]: role } })).toBe(role);
    }
  });

  it('lets the flag win over BUNNY2_ROLE', () => {
    const argv = ['--role=worker'];
    const env: Record<string, string> = { [ROLE_ENV_VAR]: 'web' };
    expect(parseRole({ argv, env })).toBe('worker');
  });

  it('ignores an empty BUNNY2_ROLE and uses the default', () => {
    expect(parseRole({ argv: [], env: { [ROLE_ENV_VAR]: '' } })).toBe('all');
  });

  it('rejects an unknown BUNNY2_ROLE value', () => {
    expect(() => parseRole({ argv: [], env: { [ROLE_ENV_VAR]: 'admin' } })).toThrow(
      /BUNNY2_ROLE: unknown value "admin"/,
    );
  });

  it('ignores unrelated argv entries', () => {
    const argv = ['some', '--unrelated=true', '--role=worker', '--also=ignored'];
    const result: ProcessRole = parseRole({ argv });
    expect(result).toBe('worker');
  });
});
