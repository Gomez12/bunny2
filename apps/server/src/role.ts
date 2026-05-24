/**
 * Phase 5.2 — process role split.
 *
 * The server can boot in one of three roles:
 *
 *  - `web`    — runs the HTTP server only. The durable bus is still
 *               started so HTTP-published events are persisted to the
 *               outbox and picked up by a worker process. Periodic
 *               runners (connector poll, entity enrichment, todo →
 *               calendar projection, LLM-call retention prune) and
 *               future scheduler ticks do NOT run.
 *  - `worker` — runs every periodic runner plus the durable bus
 *               consumer loop; does NOT bind a TCP port.
 *  - `all`    — current default behaviour: HTTP + runners + bus. Used
 *               by dev runs and by the Electron sidecar.
 *
 * Selection rules (see plan §4.3 decision #7):
 *
 *  1. `--role=<value>` CLI flag wins.
 *  2. `BUNNY2_ROLE` env var is consulted only when the flag is absent.
 *     This helps Docker / PM2-style deployments that inject the role
 *     via the environment instead of the argv. (Not documented in
 *     user-facing docs; phase 5.7 owns the deployment recipes.)
 *  3. Default: `all`.
 *
 * Anything else (typo, missing value) throws a clear startup error so
 * a misconfigured deployment fails fast instead of silently demoting
 * to the default. The parser is intentionally tiny and dependency-free
 * (per the task brief: no `yargs`/`commander`) so it can be unit-
 * tested without spawning a process.
 */

export type ProcessRole = 'web' | 'worker' | 'all';

export const PROCESS_ROLES: readonly ProcessRole[] = ['web', 'worker', 'all'];

export const DEFAULT_PROCESS_ROLE: ProcessRole = 'all';

/** Env var consulted only when the CLI flag is absent. */
export const ROLE_ENV_VAR = 'BUNNY2_ROLE';

function isProcessRole(value: string): value is ProcessRole {
  return (PROCESS_ROLES as readonly string[]).includes(value);
}

function findFlagValue(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === '--role') {
      const next = argv[i + 1];
      // `--role` with no value is a usage error; surface it instead
      // of silently falling through to the env / default.
      if (next === undefined) return '';
      return next;
    }
    if (arg.startsWith('--role=')) {
      return arg.slice('--role='.length);
    }
  }
  return undefined;
}

export interface ParseRoleInput {
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Pure parser — no `process.argv` / `process.env` reads inside, so the
 * unit test passes fixtures in directly.
 */
export function parseRole(input: ParseRoleInput = {}): ProcessRole {
  const argv = input.argv ?? [];
  const env = input.env ?? {};

  const fromFlag = findFlagValue(argv);
  if (fromFlag !== undefined) {
    if (fromFlag === '') {
      throw new Error(`--role requires a value (one of: ${PROCESS_ROLES.join(', ')})`);
    }
    if (!isProcessRole(fromFlag)) {
      throw new Error(
        `--role: unknown value "${fromFlag}" (expected one of: ${PROCESS_ROLES.join(', ')})`,
      );
    }
    return fromFlag;
  }

  const fromEnv = env[ROLE_ENV_VAR];
  if (fromEnv !== undefined && fromEnv.length > 0) {
    if (!isProcessRole(fromEnv)) {
      throw new Error(
        `${ROLE_ENV_VAR}: unknown value "${fromEnv}" (expected one of: ${PROCESS_ROLES.join(
          ', ',
        )})`,
      );
    }
    return fromEnv;
  }

  return DEFAULT_PROCESS_ROLE;
}
