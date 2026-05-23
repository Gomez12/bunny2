import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import { hashPassword } from './password';
import { createGroupsRepo } from '../repos/groups-repo';
import { createUsersRepo } from '../repos/users-repo';
import { getMeta, setMeta } from '../storage/kv-meta';

/**
 * One-shot admin bootstrap. Runs on every server start; the first call on
 * a fresh data-dir creates the `admin` group + `admin` user, prints the
 * initial password to stdout exactly once, and records the marker in
 * `kv_meta.admin_seed_done`. Subsequent calls are a no-op.
 *
 * Phase-02 plan §11.4 settled the strategy: stdout print on first-fresh
 * data-dir; the alternative `BUNNY2_ADMIN_BOOTSTRAP_TOKEN` env was
 * rejected for v1 in favour of a simpler portable experience.
 *
 * Security guarantees:
 *
 *  - The plaintext password is generated server-side via
 *    `crypto.getRandomValues`, never returned from this function, never
 *    written to any bus event, and never logged outside the explicit
 *    stdout print.
 *  - The seeded user is created with `mustChangePassword = true` so the
 *    very first login forces a rotation before any other route succeeds
 *    (enforced by the `requirePasswordCurrent` gate in 2.3).
 *  - The marker key is `admin_seed_done = 'true'`. We never re-emit the
 *    print, never re-create the rows, even if the marker is the only
 *    remaining trace.
 */

export const ADMIN_SEED_DONE_KEY = 'admin_seed_done';
export const ADMIN_GROUP_ID_KEY = 'admin_group_id';
export const ADMIN_USER_ID_KEY = 'admin_user_id';

const ADMIN_GROUP_SLUG = 'admin';
const ADMIN_GROUP_NAME = 'Administrators';
const ADMIN_GROUP_DESCRIPTION = 'Top-level administrators with full access.';
const ADMIN_USERNAME = 'admin';
const ADMIN_DISPLAY_NAME = 'Administrator';

const PASSWORD_BYTES = 18; // base64url of 18 bytes is 24 chars (no padding).

export interface SeedAdminDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  /**
   * Sink for the one-time stdout print of the initial admin credentials.
   * Production wires `console.info`; tests capture the line via an array
   * push so they can assert exactly-once behaviour. NEVER reuse this for
   * the bus or any other telemetry — it carries the plaintext password.
   */
  readonly log?: (line: string) => void;
  readonly now?: Date;
}

export interface SeedAdminResult {
  readonly seeded: boolean;
  readonly adminUserId: string;
  readonly adminGroupId: string;
}

/**
 * Idempotent admin seed. Returns whether the seed actually ran (`seeded`)
 * plus the admin ids, which `index.ts` can stash in memory for later
 * `/auth/me` admin checks (alternative: read `kv_meta` on each request).
 */
export async function seedAdminIfNeeded(deps: SeedAdminDeps): Promise<SeedAdminResult> {
  const log = deps.log ?? ((line: string) => console.info(line));
  const now = deps.now ?? new Date();
  const nowIso = now.toISOString();

  const done = getMeta(deps.db, ADMIN_SEED_DONE_KEY);
  if (done === 'true') {
    const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY) ?? '';
    const adminUserId = getMeta(deps.db, ADMIN_USER_ID_KEY) ?? '';
    return { seeded: false, adminUserId, adminGroupId };
  }

  const groupsRepo = createGroupsRepo(deps.db);
  const usersRepo = createUsersRepo(deps.db);

  const adminGroupId = crypto.randomUUID();
  const adminUserId = crypto.randomUUID();
  const password = generateAdminPassword();
  const passwordHash = await hashPassword(password);

  // 1. Group.
  groupsRepo.createGroup({
    id: adminGroupId,
    slug: ADMIN_GROUP_SLUG,
    name: ADMIN_GROUP_NAME,
    description: ADMIN_GROUP_DESCRIPTION,
    now: nowIso,
  });
  await deps.bus.publish({
    type: 'group.created',
    payload: {
      groupId: adminGroupId,
      slug: ADMIN_GROUP_SLUG,
      name: ADMIN_GROUP_NAME,
      seeded: true,
    },
    correlationId: crypto.randomUUID(),
  });

  // 2. User. Payload deliberately carries no password material.
  usersRepo.createUser({
    id: adminUserId,
    username: ADMIN_USERNAME,
    displayName: ADMIN_DISPLAY_NAME,
    passwordHash,
    mustChangePassword: true,
    now: nowIso,
  });
  await deps.bus.publish({
    type: 'user.created',
    payload: {
      userId: adminUserId,
      username: ADMIN_USERNAME,
      seeded: true,
    },
    correlationId: crypto.randomUUID(),
  });

  // 3. Membership.
  groupsRepo.addUserToGroup(adminUserId, adminGroupId, nowIso);
  await deps.bus.publish({
    type: 'group.member_added',
    payload: {
      groupId: adminGroupId,
      userId: adminUserId,
      seeded: true,
    },
    correlationId: crypto.randomUUID(),
  });

  // 4. Marker rows. The `admin_seed_done` marker is what makes the whole
  //    procedure idempotent on subsequent boots.
  setMeta(deps.db, ADMIN_GROUP_ID_KEY, adminGroupId, nowIso);
  setMeta(deps.db, ADMIN_USER_ID_KEY, adminUserId, nowIso);
  setMeta(deps.db, ADMIN_SEED_DONE_KEY, 'true', nowIso);

  // 5. Print exactly once. Use a clearly framed block so it is hard to
  //    miss in a busy stdout. The framing is ASCII-only so it renders the
  //    same on every terminal (PowerShell included).
  const line = '═'.repeat(60);
  log(line);
  log(' bunny2 initial admin credentials (this is the only time');
  log(' you will see this — write it down)');
  log('');
  log(`   username: ${ADMIN_USERNAME}`);
  log(`   password: ${password}`);
  log('');
  log(' Log in to the UI and change the password immediately.');
  log(line);

  return { seeded: true, adminUserId, adminGroupId };
}

/**
 * 24 url-safe characters of CSPRNG entropy. 18 bytes → 144 bits, which is
 * comfortably above the password-strength bar for a one-shot bootstrap
 * credential that the user must rotate on first login.
 */
function generateAdminPassword(): string {
  const buf = new Uint8Array(PASSWORD_BYTES);
  crypto.getRandomValues(buf);
  return Buffer.from(buf)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
