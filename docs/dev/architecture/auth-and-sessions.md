# Auth and sessions

> Status: living document.
> Owners: phase-2.3 introduced this; 2.4–2.7 extend it.
> Source code: `apps/server/src/auth/`, `apps/server/src/http/middleware/`,
> `apps/server/src/http/routes/auth.ts`, `apps/server/src/repos/`.

This is the single-page tour of how authentication, sessions, and the
first-run admin bootstrap work in bunny2. Companion to
[`event-bus.md`](./event-bus.md), [`overview.md`](./overview.md), and
ADRs [`0007`](../decisions/0007-argon2-implementation.md) /
[`0008`](../decisions/0008-session-strategy.md).

---

## 0. Phase 2 surface map (cheat sheet)

The routes and middlewares introduced across phase 2 in one table. Read
this once; the sections below are the long form.

### Public (no session required)

| Method    | Path           | Owner phase | Notes                                               |
| --------- | -------------- | ----------- | --------------------------------------------------- |
| `GET`     | `/status`      | 1.5         | Health probe; reports `auth.{users,groups,…}`.      |
| `POST`    | `/auth/login`  | 2.3         | Entry door. Latency-equalised across failure paths. |
| `POST`    | `/auth/logout` | 2.3         | Exit door. Works with or without a live cookie.     |
| `OPTIONS` | any            | 1.5 / 2.2   | CORS preflight short-circuits before auth.          |

### Authenticated only (any logged-in user, no `mustChangePassword`)

| Method | Path       | Owner phase | Notes                                         |
| ------ | ---------- | ----------- | --------------------------------------------- |
| `GET`  | `/auth/me` | 2.3         | Current user + transitive groups + `isAdmin`. |
| `POST` | `/chat`    | 1.5 / 2.2   | Gated since 2.2; chat flow unchanged.         |

### Authenticated and able to rotate (bypass the `mustChangePassword` gate)

| Method | Path             | Owner phase | Notes                                                  |
| ------ | ---------------- | ----------- | ------------------------------------------------------ |
| `POST` | `/auth/password` | 2.3         | Self rotation. `currentPassword` optional when forced. |
| `POST` | `/auth/logout`   | 2.3         | The other exit door honoured by the gate.              |

Every other authenticated route returns `409 errors.auth.mustChangePassword`
while the gate is armed.

### Admin only (`requireAdmin` — transitively in the seeded `admin` group)

| Method   | Path                                  | Owner phase |
| -------- | ------------------------------------- | ----------- |
| `GET`    | `/admin/groups[?includeDeleted]`      | 2.4         |
| `POST`   | `/admin/groups`                       | 2.4         |
| `GET`    | `/admin/groups/:id`                   | 2.4         |
| `PATCH`  | `/admin/groups/:id`                   | 2.4         |
| `DELETE` | `/admin/groups/:id`                   | 2.4         |
| `POST`   | `/admin/groups/:id/members`           | 2.4         |
| `DELETE` | `/admin/groups/:id/members/:memberId` | 2.4         |
| `GET`    | `/admin/users[?includeDeleted]`       | 2.5         |
| `POST`   | `/admin/users`                        | 2.5         |
| `GET`    | `/admin/users/:id`                    | 2.5         |
| `PATCH`  | `/admin/users/:id`                    | 2.5         |
| `DELETE` | `/admin/users/:id`                    | 2.5         |
| `POST`   | `/admin/users/:id/reset-password`     | 2.5         |

### Middleware chain (request order)

```
CORS preflight short-circuit
  → createAuthMiddleware (2.2)        — session resolve (Bearer ∨ cookie)
    → requirePasswordCurrent (2.3)    — mustChangePassword gate
      → requireAdmin (2.4, /admin/*)  — transitive admin-group check
        → route handler
```

A route is public iff its `(method, path)` is in `DEFAULT_PUBLIC_PATHS`
(see §4). Everything else inherits the full chain in the order above.

---

## 1. Password hashing — argon2id

- Library: `@node-rs/argon2` (native N-API, prebuilt binaries for the
  three target OSes). See ADR 0007.
- Parameters (OWASP 2024 baseline, recorded in
  `apps/server/src/auth/password.ts`):
  - `algorithm: argon2id`
  - `memoryCost: 19456 KiB` (≈19 MiB)
  - `timeCost: 2`
  - `parallelism: 1`
- The encoded hash carries the parameters with it, so old hashes keep
  verifying when these knobs change.
- `verifyPassword(plain, hash)` returns `false` for malformed hashes or
  verification errors — it never throws.
- `dummyVerify()` is a constant-time stand-in: a precomputed dummy
  hash against which the login route runs `verify` when the supplied
  username does not exist. This equalises response latency across
  "username unknown" and "wrong password" so an attacker cannot probe
  for valid usernames by timing.

### Password policy (shared helper, phase 2.5)

`apps/server/src/auth/password-policy.ts` exports
`validateNewPassword(password)` which both `POST /auth/password` and
`POST /admin/users/:id/reset-password` call. Rules:

- Length ≥ 12 characters.
- At least one non-letter character.

These two rules cover the OWASP "minimum-acceptable" bar for a
single-factor portable tool. Rejection returns 400 with the i18n key
`errors.auth.weakPassword`. The structural minimum in the shared zod
schemas (`ChangePasswordRequestSchema.newPassword.min(8)`,
`CreateUserRequestSchema.initialPassword.min(8)`,
`ResetPasswordRequestSchema.newPassword.min(8)`) is a permissive
structural check; the policy is enforced in the route handlers so
admin-set initial passwords and admin-driven resets share the bar
with self-rotated passwords without tightening the cross-package
schema for everyone.

---

## 2. Sessions — opaque tokens

- Storage: `sessions` table (`apps/server/src/storage/migrations/0002_users_groups.sql`).
- Plaintext token: 32 random bytes (≈256 bits) encoded base64url.
  Generated in `apps/server/src/auth/session-token.ts`.
- At rest we store **only** `SHA-256(token)` as hex in `token_hash`.
  A leaked database snapshot therefore cannot be used for replay —
  the attacker would need the plaintext, which never lands on disk.
- Lifetimes (from `AuthConfigSchema`, configurable):
  - `sessionTtlMinutes`: absolute lifetime, default **14 days**.
  - `sessionIdleMinutes`: inactivity window, default **24 hours**.
- The repo filter (`findSessionByTokenHash(token, now)`) excludes
  rows that are revoked or past `expires_at`. The session service
  layer additionally checks the idle window via `last_seen_at` and
  refuses tokens whose owning user has been soft-deleted (plan
  §11.5).
- Revocation: `revokeSession(id, now)` sets `revoked_at` on a single
  row; `revokeAllForUser(userId, now, { reason })` does the same for
  every row owned by `userId` and publishes one `session.expired`
  event per revoked row carrying the supplied `reason`. The four
  legal reasons today are `'logout'`, `'self_password_change'`,
  `'admin_password_reset'`, and `'user_deleted'`. Logout uses the
  per-row variant (the route knows the single session id). The
  change-password route iterates the user's active sessions and calls
  the per-row variant on every one except the rotating session
  itself — this keeps the current session alive without a "revoke
  then un-revoke" round trip, and emits
  `session.expired { reason: 'self_password_change' }` per revoked
  sibling. The row-skip is observable in
  `apps/server/src/http/routes/auth.ts`. See §6.

ADR [`0008`](../decisions/0008-session-strategy.md) records why we
chose opaque tokens over JWT: cheap server-side invalidation is
worth more than statelessness for an internal portable tool.

---

## 3. Cookie + Bearer transport

The same plaintext token rides on:

- the `bunny2_session` cookie (HttpOnly, SameSite=Lax, Path=/,
  Max-Age=`sessionTtlMinutes*60`, Secure in production); and
- `Authorization: Bearer <token>` for non-browser clients (tests,
  CLI tools).

The auth middleware (`apps/server/src/http/middleware/auth.ts`) tries
`Authorization` first, falls back to the cookie. Both paths run
through the same `SessionService.resolveSession`.

### Why the JSON body does NOT carry the token

`POST /auth/login` returns `{ user, mustChangePassword, sessionExpiresAt }`
— the token is in the `Set-Cookie` response header only.

Rationale:

- The web UI does not need the token in JS: it relies on the
  browser sending the HttpOnly cookie automatically. HttpOnly is
  the strongest mitigation we have against renderer XSS reading
  the session.
- A JSON-bound token is observable by any code with `fetch`
  monkey-patches or response interceptors — including malicious
  browser extensions. JSON exfiltration of session tokens has a
  long incident history; we do not need to opt into it.
- Non-browser clients (the smoke test, CLI tools) can read the
  cookie out of `Set-Cookie` and re-send it as either a `Cookie`
  header or as `Authorization: Bearer` — the middleware accepts
  both. The contract stays symmetric.

---

## 4. Public-path whitelist

Every route is auth-gated by default. The whitelist
(`DEFAULT_PUBLIC_PATHS` in
`apps/server/src/http/middleware/auth.ts`):

| Method | Path           | Why public                                           |
| ------ | -------------- | ---------------------------------------------------- |
| `GET`  | `/status`      | Health probe; must work before any user exists.      |
| `POST` | `/auth/login`  | Entry door — there is no session to present yet.     |
| `POST` | `/auth/logout` | Exit door — works whether or not the cookie is live. |

CORS `OPTIONS` preflights short-circuit even earlier in the same
middleware.

Any route not in this set requires a resolvable session.

---

## 5. Login timing equalisation

`POST /auth/login` has three failure branches and one success
branch. The failure branches all return the same `401 +
{ error: 'errors.auth.invalidCredentials' }` shape so an attacker
cannot distinguish "unknown user" from "wrong password" from
"soft-deleted user" by reading the response. To prevent timing-based
disambiguation:

- **unknown user** → `dummyVerify()` runs a real argon2 verify
  against a precomputed dummy hash before responding.
- **soft-deleted user** → `dummyVerify()` likewise (the row exists
  but we will not actually call `verify` against its real hash).
- **wrong password** → `verifyPassword()` runs naturally.

All three paths spend argon2 CPU; the response latency is
indistinguishable to a network observer.

Each branch publishes `user.login.failed` with a typed `reason`
field (`unknown_user` / `soft_deleted` / `wrong_password`) for
forensic analysis — the events are visible only to administrators
reading the `events` table, not to the failing client.

---

## 6. `mustChangePassword` gate

The seeded admin user is created with `mustChangePassword = true`.
The same flag is settable on any user by an admin (2.5 deliverable).

`apps/server/src/http/middleware/password-gate.ts` runs AFTER the
auth middleware. If `c.var.user.mustChangePassword` is `true` and
the route is neither `POST /auth/password` nor `POST /auth/logout`,
the gate returns `409 { error: 'errors.auth.mustChangePassword' }`.

Exit doors:

- `POST /auth/password` — rotate. When `mustChangePassword` is
  true, the `currentPassword` field is optional (the valid session
  is the proof-of-presence). When it is false, `currentPassword`
  is required and verified.
- `POST /auth/logout` — bail.

After a successful rotation the route revokes all OTHER active
sessions for the user (defence against a compromised cookie that
reached a second device) and keeps the rotating session alive so
the user does not bounce back to the login screen.

---

## 7. Admin seed

`apps/server/src/auth/seed.ts` runs **once per data-dir**, before
`Bun.serve` starts accepting connections (see
`apps/server/src/index.ts`).

Algorithm:

1. Read `kv_meta.admin_seed_done`. If `'true'` → return; no print,
   no events, no DB writes.
2. Otherwise:
   - Create the `admin` group (`slug = 'admin'`, name `Administrators`).
     Publish `group.created`.
   - Generate a random 24-char (base64url of 18 bytes ≈ 144 bits of
     entropy) admin password via `crypto.getRandomValues`. Hash it.
     Create the `admin` user with `mustChangePassword = true`.
     Publish `user.created` with `{ userId, username, seeded: true }`.
     **The plaintext password is never put on the bus.**
   - Add the admin user to the admin group. Publish
     `group.member_added`.
   - Stamp `admin_group_id`, `admin_user_id`, and finally
     `admin_seed_done = 'true'` in `kv_meta`.
   - Print a clearly framed credential block to the `log` sink
     (default `console.info`). The block contains the username and
     password and instructs the operator to log in and rotate.
3. On every subsequent boot, step 1 short-circuits.

`GET /status.auth.adminSeeded` reflects the `kv_meta` flag so an
operator can confirm the seed has run without grepping logs.

The seed-password strategy was settled in plan §11.4: stdout print
on first-fresh data-dir. The alternative `BUNNY2_ADMIN_BOOTSTRAP_TOKEN`
env was rejected for v1 in favour of a simpler portable experience.

---

## 8. Bus events emitted (phases 2.3 – 2.5)

| Event                   | Producer                                            | Payload                                                                                                                |
| ----------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `user.created`          | seed; `POST /admin/users` (2.5)                     | `{ userId, username, seeded: boolean, createdBy?: actingAdminId }` (`createdBy` present on 2.5 admin path)             |
| `user.updated`          | `PATCH /admin/users/:id` (2.5)                      | `{ userId, patch: { displayName?, groupIds? }, updatedBy: actingAdminId }`                                             |
| `user.deleted`          | `DELETE /admin/users/:id` (2.5)                     | `{ userId, deletedBy: actingAdminId }`                                                                                 |
| `user.password_changed` | `/auth/password`; `/admin/users/:id/reset-password` | `{ userId, by: actingAdminId \| userId, forced: boolean }` (`forced: true` for admin reset; `false` for self rotation) |
| `user.login.succeeded`  | `/auth/login` success                               | `{ userId, sessionId }`                                                                                                |
| `user.login.failed`     | `/auth/login` failures                              | `{ userId? \| username, reason: 'unknown_user' \| 'soft_deleted' \| 'wrong_password' }`                                |
| `session.created`       | `/auth/login` success                               | `{ sessionId, userId, expiresAt }`                                                                                     |
| `session.expired`       | `/auth/logout`; self rotation; admin reset; delete  | `{ sessionId, userId, reason: 'logout' \| 'self_password_change' \| 'admin_password_reset' \| 'user_deleted' }`        |
| `group.created`         | seed; 2.4 admin CRUD                                | `{ groupId, slug, name, seeded? }`                                                                                     |
| `group.updated`         | 2.4 admin CRUD                                      | `{ groupId, patch: { name?, description? } }`                                                                          |
| `group.deleted`         | 2.4 admin CRUD                                      | `{ groupId, slug }`                                                                                                    |
| `group.member_added`    | seed; admin CRUD (2.4); user CRUD (2.5)             | `{ groupId, kind: 'user' \| 'group', userId? \| childGroupId?, seeded? }`                                              |
| `group.member_removed`  | admin CRUD (2.4); user CRUD (2.5)                   | `{ groupId, kind: 'user' \| 'group', userId? \| childGroupId? }`                                                       |

`session.expired` will gain a `reason: 'idle'` / `'absolute'` producer
when the prune job lands as a subscriber (post-phase-2).

---

## 9. Group resolution (phase 2.4)

`apps/server/src/auth/group-resolver.ts` is the single source of truth
for "is this user transitively in this group?". The admin gate
(`requireAdmin`) and `/auth/me.isAdmin` both call it; future per-layer
auth (phase 3) will too.

### 9.1 Recursive CTE shapes

Edges in `group_group_memberships` point from `parent_group_id`
**downward** to `child_group_id`. A parent group transitively contains
every user that any of its descendant groups directly contains.

Two reusable CTEs:

```sql
-- 1. user → containing groups (upward walk)
WITH RECURSIVE ancestors(group_id) AS (
  SELECT group_id FROM user_group_memberships WHERE user_id = ?
  UNION
  SELECT ggm.parent_group_id
    FROM group_group_memberships ggm
    JOIN ancestors a ON ggm.child_group_id = a.group_id
)
SELECT group_id FROM ancestors;

-- 2. group → descendant group set (downward walk)
WITH RECURSIVE descendants(group_id) AS (
  SELECT ?
  UNION
  SELECT ggm.child_group_id
    FROM group_group_memberships ggm
    JOIN descendants d ON ggm.parent_group_id = d.group_id
)
SELECT group_id FROM descendants;
```

`UNION` (not `UNION ALL`) makes every step deduplicate, which both
prunes the work and defends against stray cycle rows (we block cycles
on insert but defence in depth keeps the CTE bounded if a row ever
slips through).

### 9.2 Cycle detection

Adding edge `parent → child` would close a loop iff `parent` is already
reachable from `child` via existing edges. `wouldCreateCycle(parent,
child)`:

1. If `parent === child` → return `true`.
2. Otherwise walk DOWNWARD from `child` (CTE #2) and check if `parent`
   appears in the descendant set.

Routes check `wouldCreateCycle` before calling
`groupsRepo.addGroupToGroup` so the error surface is friendly
(`409 errors.admin.groupCycle`) instead of an FK violation.

### 9.3 In-memory cache

The resolver keeps three caches:

- `isUserInGroup(userId, groupId)` → boolean.
- `expandUserGroups(userId)` → `Set<groupId>`.
- `expandGroupMembers(groupId)` → `{ userIds, groupIds }`.

Each map is a tiny LRU with a 5000-entry cap (DoS defence against a
hostile request stream probing arbitrary pairs) and a 60-second
defensive TTL on top of the event-driven invalidation.

Invalidation: the resolver subscribes to seven event types on the
shared bus — `group.created`, `group.updated`, `group.deleted`,
`group.member_added`, `group.member_removed`, `user.created`,
`user.deleted`. Any of them clears all three maps. The set is
intentionally coarse: a single membership flip can change answers for
any user via diamond inheritance, and a partial-invalidation strategy
would have to walk the same CTEs we are caching.

### 9.4 Immutable `admin` slug

The seeded `admin` group is permanent. `DELETE /admin/groups/:id`
returns `404 errors.admin.groupNotFound` if `slug === 'admin'` (we
mask existence rather than 403 because leaking "exists but protected"
gives no useful info). The slug itself is also immutable — `PATCH
/admin/groups/:id` accepts `name` and `description` only.

### 9.5 `requireAdmin` middleware

`apps/server/src/http/middleware/admin.ts` sits on the `/admin/*`
prefix, after `requireAuth` and after `requirePasswordCurrent`. It
reads `admin_group_id` from `kv_meta` once at factory construction:

- If the seed has not run → every admin route returns
  `503 errors.admin.notSeeded` and the factory logs once.
- Otherwise → `resolver.isUserInGroup(user.id, adminGroupId)`. `true`
  → `next()`; `false` → `403 errors.admin.forbidden`.

`/auth/me.isAdmin` uses the same resolver call, so the answer is
consistent across the gate and the client-facing flag.

---

## 10. Admin user CRUD (phase 2.5)

`apps/server/src/http/routes/admin-users.ts` mounts the following
routes under `/admin/users/*` (inheriting `requireAuth`, the password
gate, and `requireAdmin`):

| Method   | Path                                 | Purpose                                                                              |
| -------- | ------------------------------------ | ------------------------------------------------------------------------------------ |
| `GET`    | `/admin/users[?includeDeleted=true]` | List users (each row carries `directGroupIds`).                                      |
| `GET`    | `/admin/users/:id`                   | Detail: `{ user, directGroups }`. 404 if absent or (soft-deleted without the query). |
| `POST`   | `/admin/users`                       | Create. Body: `{ username, displayName, initialPassword?, groupIds? }`.              |
| `PATCH`  | `/admin/users/:id`                   | Update. Body: `{ displayName?, groupIds? }` (groupIds is a full replace).            |
| `DELETE` | `/admin/users/:id`                   | Soft delete + revoke every active session for the target user.                       |
| `POST`   | `/admin/users/:id/reset-password`    | Set a new password + force rotation on next login + revoke target's sessions.        |

Behaviour rules:

- `username` matches `^[a-zA-Z0-9._-]{3,32}$`; the route lowercase-
  normalizes on the way to the repo (the column uses `COLLATE NOCASE`
  so uniqueness is case-insensitive regardless).
- `displayName` is 1..100 characters.
- `initialPassword` and `reset-password.newPassword` are validated via
  `validateNewPassword` so they share the §1 policy floor with self
  rotation. When the field is omitted, the server generates a 24-char
  base64url CSPRNG token and returns it in the response body
  **exactly once** (the cleartext is never put on the bus). Document
  this clearly in the admin guide.
- Admin-created users always start with `must_change_password = true`.
- `groupIds` references must exist; unknown ids are rejected with
  `400 errors.admin.userUnknownGroup`. A duplicate username is
  rejected with `409 errors.admin.userUsernameTaken`. A schema
  rejection surfaces as `400 errors.admin.badRequest`.

### 10.1 "Last admin" guard

Every PATCH that replaces `groupIds` and every DELETE runs the same
pure-arithmetic guard before mutating state. Users sit at the leaves
of the membership DAG, so flipping U's direct memberships only
changes U's own transitive admin status — no other user is affected.

Inputs: the resolver's expansion of the admin group
(`expandGroupMembers(adminGroupId)`), the target user id, and the
caller-proposed new direct memberships (`new Set()` for DELETE):

```
adminUsers     = expansion.userIds
adminGroupSet  = expansion.groupIds
wasAdmin       = adminUsers.has(targetUserId) ? 1 : 0
willBeAdmin    = newGroupIds.some(g => adminGroupSet.has(g)) ? 1 : 0
postCount      = adminUsers.size - wasAdmin + willBeAdmin
ok             = postCount >= 1
```

Failure → `409 errors.admin.lastAdmin`. The check is exported from
`admin-users.ts` as `lastAdminGuard` so tests can hammer it without
spinning an HTTP fixture.

### 10.2 Seeded-admin protection

`DELETE /admin/users/:id` returns `404 errors.admin.userNotFound`
when `id === kv_meta.admin_user_id`. Same masking pattern as the
seeded admin group's slug. The "last admin" rule could not save the
seeded admin alone anyway (it is the same identity), but the
explicit 404 keeps the rule self-evident in code review.

### 10.3 Self-reset prohibition

`POST /admin/users/:id/reset-password` returns
`404 errors.admin.cannotResetOwnPassword` when `id === c.var.user.id`.
Admins rotate their own password through `POST /auth/password`,
which requires the current password as proof-of-presence. This is
a deliberate guard against a privilege-escalation footgun where an
admin who lost their credentials could silently re-grant access
without re-authenticating. Note this is `c.var.user.id`, not the
seeded admin id — other admins are allowed to reset the seeded
admin (only the seeded admin themselves is blocked by it through
this rule).

### 10.4 Sessions on user mutation

- `DELETE /admin/users/:id` calls
  `sessions.revokeAllForUser(id, now, { reason: 'user_deleted' })`
  which emits a `session.expired` event per revoked row. The
  group-resolver cache also clears via the existing `user.deleted`
  subscriber.
- `POST /admin/users/:id/reset-password` calls
  `sessions.revokeAllForUser(id, now, { reason: 'admin_password_reset' })`.
  The next login for the target lands with `mustChangePassword = true`
  and the §6 gate fires on every protected route until they rotate.

---

## 11. Web UI surface (phase 2.6)

The web app at `apps/web/` consumes the endpoints above. Phase 2.6
introduces a routing-less top-level state machine in
`apps/web/src/App.tsx` driven by `apps/web/src/lib/session.ts`:

```text
            ┌─ unknown ──────────┐
bootstrap ──▶ loading            │
            │   │  401 /auth/me  │
            │   ├───────────────▶│  guest ──login──▶ authenticated
            │   │                │     ▲                    │
            │   │  200 /auth/me  │     │                    │
            │   └───────────────▶│   logout                 │
            │                    │     │                    ▼
            └────────────────────┘     └──── mustChangePassword?
                                                │           │
                                              true        false
                                                │           │
                                                ▼           ▼
                                     ChangePasswordPage  AppShell
                                          (forced)      (tabs + UserMenu)
```

Pages (`apps/web/src/pages/` and `…/pages/admin/`):

| Page                 | Visible when                             | Purpose                                                   |
| -------------------- | ---------------------------------------- | --------------------------------------------------------- |
| `LoginPage`          | `status === 'guest'`                     | Username + password form, accessible error region         |
| `ChangePasswordPage` | `mustChangePassword === true` (forced)   | New password + confirm; reads policy hint                 |
| `ChangePasswordPage` | User menu → "Change password" (optional) | Current + new + confirm                                   |
| `StatusPage`         | Any authenticated user                   | Existing phase-1.5 surface                                |
| `ChatPage`           | Any authenticated user                   | Existing phase-1.5 surface                                |
| `AdminUsersPage`     | `isAdmin === true`                       | List, create, edit, delete, reset password (generated PW) |
| `AdminGroupsPage`    | `isAdmin === true`                       | List, create, edit, delete (admin slug blocked)           |
| `GroupDetailPage`    | Click "Open" on a row in AdminGroupsPage | Direct users / sub-groups / parents; add/remove pickers   |

### Session store

`apps/web/src/lib/session.ts` exposes a minimal `EventTarget`-backed
store plus a `useSession()` hook built on
`useSyncExternalStore`. Transitions: `bootstrapSession()`,
`applyLogin(response)`, `applyLogout()`. The bootstrap call distinguishes
401 (→ guest) from other errors (→ guest with a console warning) by
branching on `res.status` rather than throwing.

### API client

`apps/web/src/lib/api.ts` wraps every fetch with `credentials: 'include'`
so the HttpOnly session cookie flows. Server errors arrive in the shape
`{ error: 'errors.<key>' }`; the client surfaces them via `t(error)` with
`errors.network` as the universal fallback (see `lib/errors.ts`). The
admin endpoints are typed against the hand-written interfaces in
`lib/api-types.ts` (kept dependency-light rather than importing the
shared zod schemas into the web bundle).

### Dialogs & menus

Phase 2.6 picks the native `<dialog>` element via
`apps/web/src/components/ui/dialog.tsx`. The browser handles focus trap,
ESC dismissal, and `::backdrop` for free; we only add click-on-backdrop
close and an explicit close button. The UserMenu is hand-rolled —
`role="menu"` with `<button role="menuitem">` items, ESC closes,
click-away closes, focus restored to the trigger.

### Admin navigation gating

Admin tabs are only rendered when `session.isAdmin === true`. A
useEffect in `App.tsx` defensively snaps the active tab back to `status`
if the user loses admin (e.g. groups change mid-session). The
`/admin/*` routes also enforce `requireAdmin` server-side — the tab gate
is UX only.

### i18n surface added in 2.6

New namespaces: `nav.*`, `auth.login.*`, `auth.changePassword.*`,
`auth.userMenu.*`, `admin.users.*`, `admin.groups.*`, plus a handful of
common verbs/labels under `common.*` (`cancel`, `save`, `delete`,
`edit`, `confirm`, `close`, `copy`, `copied`, `required`, `optional`).
The Dutch locale ships login + change-password + nav + common as a
showcase; the rest stay warn-only per the
`scripts/i18n-check.ts` discipline.

### Generated passwords

`POST /admin/users` (no `initialPassword`) and
`POST /admin/users/:id/reset-password` return `generatedPassword` in the
response body exactly once. The web UI surfaces it in a read-only input
with a "Copy" button (loud i18n'd warning) and never keeps it in any
list cache or component state outside the dialog.

---

## 12. Open extensions (post-2.5)

- **Rate limiting on `/auth/login`** — captured but not enforced;
  follow-up tracked in `docs/dev/follow-ups/auth-rate-limit.md`.
- **Session-fixation rotation** — rotate session id on
  `mustChangePassword` flip. Currently we revoke siblings but keep
  the same session id for the rotator; tracked alongside group-
  change events in phase 3+.
- **2FA / passkeys / SSO** — explicitly out of phase 2 (`overall.md`
  §10).
