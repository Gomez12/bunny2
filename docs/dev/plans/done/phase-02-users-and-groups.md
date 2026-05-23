# Phase 2 — Users & Groups

> Parent: [`overall.md`](./overall.md) §8 Phase 2.
> Scope of this document: **detailed plan for phase 2 only**.
> All decisions inherit from `overall.md` §4 (`Auth: argon2id +
group-based`), §5 (event-sourced core, soft-delete, versioned
> entities), §10.

---

## 1. Goal

From phase 2 onward, **everything is auth-gated**. Multiple users can
log in, get sessions, and only see what their group(s) allow. An
admin can manage users and groups. The phase-1 foundation (bus,
event log, LLM client, telemetry) is unchanged — phase 2 sits on
top.

A developer who installs the portable build for the first time
should:

1. Boot the server.
2. Find a printed initial admin password on stdout.
3. Log in via the UI, be forced to change the password.
4. Create a second user in a non-admin group.
5. Verify the second user can log in but cannot reach admin pages.

---

## 2. Scope

In scope:

- `users`, `groups`, `user_group_memberships`,
  `group_group_memberships`, `sessions` tables (UUIDs,
  soft-delete, versioned per `overall.md` §5.5/§5.6).
- Argon2id password hashing.
- Opaque session ids stored in SQLite, transported as HttpOnly
  cookies **and** as `Authorization: Bearer` for non-browser
  clients. Configurable absolute TTL and idle timeout.
- HTTP middleware that auth-gates every route by default, with an
  explicit `public: true` whitelist for `POST /auth/login`,
  `POST /auth/logout`, `GET /status`.
- Endpoints: `POST /auth/login`, `POST /auth/logout`,
  `GET /auth/me`, `POST /auth/password`, plus `/admin/users/*` and
  `/admin/groups/*` CRUD.
- Event types persisted by the existing event log: `user.created`,
  `user.updated`, `user.password_changed`, `user.deleted`,
  `user.login.succeeded`, `user.login.failed`, `session.created`,
  `session.expired`, `group.created`, `group.updated`,
  `group.deleted`, `group.member_added`, `group.member_removed`.
- Group-of-groups: a group can hold other groups as members.
  Membership resolves transitively (admin → engineering → backend
  also contains everyone in backend). No cycles allowed.
- Seeded `admin` group + `admin` user on a fresh data-dir, with
  `must_change_password = true`; first login forces a new password
  before any other request succeeds.
- Web UI: login screen, change-password screen, account chip with
  logout, admin pages for users and groups.
- i18n: namespaces `auth.*`, `admin.users.*`, `admin.groups.*`,
  `errors.auth.*`, `errors.admin.*`.
- Smoke test extended to cover login → protected route → logout →
  401 cycle.

Out of scope (deferred):

- OAuth / SSO / passkeys.
- Per-route permissions finer than "signed in" + "is in group X".
  Layer-level scoping is phase 3.
- Rate limiting / lockout on login (events captured, enforcement is
  a follow-up).
- Password reset by email (no mail infra in v1; admin reset is
  enough).
- 2FA.
- API tokens / service accounts.

---

## 3. Non-Goals (phase 2)

- No rotating refresh tokens, no device list — opaque session id is
  enough.
- No "remember me" UI separate from the configured TTL.
- No bespoke audit UI; events live in the `events` table and replay
  covers it.

---

## 4. Approach

### 4.1 Sub-phases (delivery order, one tasklist row each)

**2.1 — Schema + password hashing + repos**
Migration `0002_users_groups.sql` adds `users`, `groups`,
`user_group_memberships`, `group_group_memberships`, `sessions`.
Argon2id wrapper in `apps/server/src/auth/password.ts`. ADR `0007`
picks the implementation (default: `@node-rs/argon2` with prebuilt
binaries, fall back to `oslo`/`@oslojs/crypto` if a platform
blocks). Typed repositories `users-repo.ts`, `groups-repo.ts`,
`sessions-repo.ts`. No HTTP yet.

**2.2 — Sessions + auth middleware**
`createSession(userId)` produces an opaque 32-byte base64url token
and inserts a row in `sessions`. Cookie helpers (`setSessionCookie`,
`clearSessionCookie`) read/write an HttpOnly cookie. Hono middleware
`requireAuth` reads `Authorization: Bearer` or the cookie,
validates against `sessions`, attaches `c.var.session` and
`c.var.user`. A public-route whitelist is declared via route
metadata. Idle timeout via `last_seen_at` updates on each request.
ADR `0008` records the opaque-vs-JWT decision.

**2.3 — Login / logout / me / password + admin seed**
Endpoints:

- `POST /auth/login { username, password }` — verify hash, create
  session, set cookie, return `{ user, mustChangePassword }`.
- `POST /auth/logout` — invalidate session, clear cookie.
- `GET /auth/me` — return current user + group memberships
  (transitive, including derived `isAdmin`).
- `POST /auth/password { currentPassword?, newPassword }` — change
  own password. `currentPassword` only required when
  `mustChangePassword` is `false`.

Startup seed: idempotent. On a fresh data-dir, create the `admin`
group, the `admin` user with a random password, mark the user
`must_change_password = true`, mark the seed complete in `kv_meta`,
and print the initial password to stdout exactly once. Bus events
are emitted via the existing log.

**2.4 — Group CRUD + memberships**
Endpoints under `/admin/groups`:

- `GET /admin/groups`, `POST /admin/groups`,
  `PATCH /admin/groups/:id`, `DELETE /admin/groups/:id` (soft).
- `POST /admin/groups/:id/members { userId | groupId }`,
  `DELETE /admin/groups/:id/members/:memberId`.

`isUserInGroup(userId, groupId)` resolves transitively via a
recursive CTE. Cycle detection on `group.member_added`. An
in-memory cache of transitive expansion is invalidated by a bus
subscriber on `group.*` events.

**2.5 — User CRUD + forced password-change flow**
Endpoints under `/admin/users`:

- `GET /admin/users`,
  `POST /admin/users { username, displayName, initialPassword?, groupIds? }`,
  `PATCH /admin/users/:id`, `DELETE /admin/users/:id` (soft),
  `POST /admin/users/:id/reset-password` (admin sets new password +
  `must_change_password = true`).

Middleware behavior: when the signed-in user has
`mustChangePassword = true`, every route except `POST /auth/password`
and `POST /auth/logout` returns
`409 { error: 'errors.auth.mustChangePassword' }`.

**2.6 — Web UI**

- `LoginPage`: username + password, error region, accessible
  labels, autocomplete attributes (`username`,
  `current-password`).
- `ChangePasswordPage`: shown when `mustChangePassword`. Old + new
  - confirm, with `autocomplete="new-password"`.
- App shell: signed-in user chip in header with logout button.
- `AdminUsersPage`: table of users, row action `reset password`,
  dialog for "new user" with optional initial password and group
  selection.
- `AdminGroupsPage`: table of groups, group detail showing user
  members and sub-group members.
- Admin navigation is hidden unless the user is transitively in
  the `admin` group.
- Every string from i18n. `isAdmin` comes from `/auth/me`.

**2.7 — Docs + ADRs + extended smoke**
ADR `0007` (argon2 implementation), ADR `0008` (session strategy).
`docs/dev/architecture/auth-and-sessions.md`. Update
`architecture/overview.md` (auth layer in the spine diagram) and
`architecture/event-bus.md` (new event types). New user-facing doc
`docs/user/guides/admin-managing-users.md`. Smoke test extended to
cover the login → protected → logout → 401 cycle plus the
`mustChangePassword` gate.

---

## 5. Affected Modules

| Module                           | What changes                                                                  |
| -------------------------------- | ----------------------------------------------------------------------------- |
| `apps/server/src/storage/`       | New migration `0002_users_groups.sql`                                         |
| `apps/server/src/auth/`          | New: `password.ts`, `sessions.ts`, `middleware.ts`, `seed.ts`                 |
| `apps/server/src/repos/`         | New: `users-repo.ts`, `groups-repo.ts`, `sessions-repo.ts`                    |
| `apps/server/src/http/routes/`   | New: `auth.ts`, `admin-users.ts`, `admin-groups.ts`                           |
| `apps/server/src/http/router.ts` | Auth middleware enabled by default; public-route whitelist                    |
| `apps/server/src/index.ts`       | Seed call + `/status.auth` block (`sessions`, `users`, `groups`)              |
| `apps/web/src/pages/`            | `LoginPage`, `ChangePasswordPage`, `AdminUsersPage`, `AdminGroupsPage`        |
| `apps/web/src/components/`       | `UserMenu`, admin table primitives                                            |
| `apps/web/src/lib/api.ts`        | `login`, `logout`, `me`, `changePassword`, admin endpoints (with credentials) |
| `apps/web/src/i18n/locales/`     | New `auth.*`, `admin.*`, `errors.auth.*`, `errors.admin.*` keys               |
| `packages/shared/`               | Zod schemas for `User`, `Group`, `Session`, login/admin payloads              |
| `docs/dev/`                      | `architecture/auth-and-sessions.md`, ADRs 0007 + 0008, follow-ups as needed   |
| `docs/dev/tasklist.md`           | Sub-phase rows 2.1–2.7                                                        |

---

## 6. Tests

- **Unit:** argon2 hash + verify round-trip; session creation,
  expiry, idle-timeout update; transitive group membership
  (diamond inheritance, self-reference rejected, cycle rejected);
  zod schemas reject malformed payloads.
- **Integration:** seed creates exactly one admin user + group and
  is idempotent across restarts; `mustChangePassword` flow blocks
  every route except logout + password change; concurrent
  login/logout correctly invalidates the right session.
- **HTTP:** login happy + invalid-password paths; cookie set and
  accepted on next request; protected route returns 401 without a
  cookie; admin route returns 403 for a non-admin user; failed
  login latency equalized so timing attacks don't leak username
  existence.
- **Component (web):** login form keyboard nav and label
  association; focus shifts to error region on failure; the
  `mustChangePassword` redirect kicks in; admin nav hidden for
  non-admin.
- **i18n:** every new string flows through `t()`; the i18n scan
  stays green.
- **Smoke (e2e):** extended round-trip per §4.1 sub-phase 2.7.

---

## 7. Docs Impact

New docs:

- `docs/dev/architecture/auth-and-sessions.md`
- `docs/dev/decisions/0007-argon2-implementation.md`
- `docs/dev/decisions/0008-session-strategy.md`
- `docs/user/guides/admin-managing-users.md`

Updated docs:

- `docs/dev/architecture/overview.md` — auth layer in the spine
  diagram and prose.
- `docs/dev/architecture/event-bus.md` — new `user.*`, `group.*`,
  `session.*` event types.
- `docs/dev/setup/running.md` — where the initial admin password
  appears on stdout.
- `docs/user/guides/getting-started.md` — first login + change
  password.
- `docs/dev/tasklist.md` — rows 2.1–2.7.

---

## 8. i18n Impact

- New namespaces: `auth.login.*`, `auth.changePassword.*`,
  `auth.logout.*`, `admin.users.*`, `admin.groups.*`,
  `errors.auth.*`, `errors.admin.*`.
- `en` stays base + fallback. `nl` gets at least the login +
  change-password keys translated as a showcase; remaining new
  keys are warn-only.
- `i18n:check` continues unchanged.

---

## 9. Accessibility Impact

- Login form: `<form>` with labelled inputs, autocomplete
  attributes (`username`, `current-password`, `new-password`),
  error region linked via `aria-describedby`.
- Admin tables: semantic `<table>`, sortable headers with
  `aria-sort` when wired, row actions as real `<button>`.
- Dialogs: focus trap, focus restored on close, ESC dismisses
  (shadcn dialog already covers this).
- Visible focus rings everywhere.
- axe-core stays green on every new page.

---

## 10. Risks

| Risk                                     | Likelihood | Impact | Mitigation                                                                                                                     |
| ---------------------------------------- | ---------- | -----: | ------------------------------------------------------------------------------------------------------------------------------ |
| Brute-force on `/auth/login`             | Med        |   High | Capture `user.login.failed` events now; enforcement (rate-limit + lockout) tracked in `docs/dev/follow-ups/auth-rate-limit.md` |
| argon2 native dep fails on Windows       | Low        |    Med | Prefer `@node-rs/argon2` with prebuilts; fall back to `oslo` (pure WASM). CI matrix catches breakage                           |
| Session fixation via cookie              | Med        |    Med | Rotate session id on privilege changes (post-mustChangePassword, group changes); HttpOnly + Secure flags                       |
| Group cycle in `group_group_memberships` | Low        |   High | Cycle detection on insert (recursive CTE); tests cover diamond + self-reference                                                |
| Seeded admin password leaks via logs     | Med        |    Med | Print only on first-fresh data-dir, then never; gate behind a one-shot `kv_meta` flag; documented                              |
| Password leak via the event log          | Med        |   High | Login route never publishes the raw password; auth events carry only `userId` + outcome                                        |

---

## 11. Open Questions (phase 2)

1. **Argon2 library**: `@node-rs/argon2` (native, prebuilds) vs
   `oslo`/`@oslojs/crypto` (pure WASM). Default plan:
   `@node-rs/argon2` if prebuilts cover macOS, Linux, Windows on
   the targeted architectures; otherwise `oslo`. Decided in 2.1,
   ADR `0007`.
2. **Session storage**: opaque token in SQLite (default) vs signed
   JWT. JWT is stateless but cannot be invalidated cheaply on
   logout. We pick opaque. ADR `0008`.
3. **Cookie + Bearer**: support both. Cookie for the browser/UI,
   Bearer for smoke tests + non-browser clients.
4. **Seed admin password**: print to stdout on first-fresh
   data-dir. Alternative `BUNNY2_ADMIN_BOOTSTRAP_TOKEN` env is not
   adopted for v1 — simpler portable-first experience.
5. **Soft-deleted users**: open sessions are invalidated
   immediately on soft delete.
6. **Group-of-groups**: DAG only. No meta-roles. Cycles rejected
   at insert time.

---

## 12. Definition of Done (phase 2)

Per `AGENTS.md` §Done Means Done, plus phase-specific:

- All sub-phase tasklist rows 2.1–2.7 are `done`.
- On a fresh `bun run dev:server`, the initial admin password is
  printed exactly once; first login forces a password change.
- Every route except `GET /status`, `POST /auth/login`,
  `POST /auth/logout` returns 401 without a session.
- Admin can create at least one extra group and one extra user via
  the UI; that user can log in and is denied access to the admin
  pages.
- Extended smoke test covers the login → protected → logout → 401
  cycle plus the `mustChangePassword` gate.
- All CI matrix checks green on macOS, Linux, Windows.
- ADRs `0007` and `0008` exist.
- `overall.md` and this plan stay accurate; reality wins, fix
  docs.

---

## 13. Concrete Next Step

Add sub-phase rows 2.1–2.7 to `docs/dev/tasklist.md` as `open`,
then start sub-phase **2.1 — Schema + password hashing + repos**.

---

## 14. Phase 2 close-out (authored 2026-05-23 at the end of 2.7)

Walkthrough of §12 Definition of Done. Tracked here so a reader does
not have to chase the tasklist + git history to know what is done
and what is gated. Mirrors the close-out shape of
[`phase-01-system-foundation.md`](./phase-01-system-foundation.md)
§14.

| §12 line                                                                                                          | State   | Evidence / notes                                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| All sub-phase tasklist rows 2.1–2.7 are `done`                                                                    | done    | 2.1–2.6 flipped at the end of each sub-phase; 2.7 flips at the end of this commit.                                                                                                                                                                                       |
| On a fresh `bun run dev:server`, the initial admin password is printed exactly once; first login forces rotation. | done    | `apps/server/src/auth/seed.ts` is idempotent against `kv_meta.admin_seed_done`; the seed and the gate are exercised end-to-end in `apps/server/tests/smoke.test.ts`. Manual run against a fresh `./.data` reproduces the printed block.                                  |
| Every route except `GET /status`, `POST /auth/login`, `POST /auth/logout` returns 401 without a session.          | done    | `createAuthMiddleware` enforces this against `DEFAULT_PUBLIC_PATHS`; smoke asserts the pre-login `/chat` 401 leg (step 6-pre).                                                                                                                                           |
| Admin can create at least one extra group + one extra user via the UI; that user is denied admin pages.           | partial | Server-side covered by `apps/server/tests/http-admin-users.test.ts` + `http-admin-groups.test.ts` + `http-auth-me.test.ts`. UI click-through is a manual smoke against `bun run dev:web` until DOM tests land — tracked in `docs/dev/follow-ups/web-component-tests.md`. |
| Extended smoke covers login → protected → logout → 401 + the `mustChangePassword` gate.                           | done    | `apps/server/tests/smoke.test.ts` — see the invariants header for the asserted chain (pre-login 401, login, gate fires, rotate, protected works, logout, post-logout 401, plus admin-group flow).                                                                        |
| All CI matrix checks green on macOS, Linux, Windows.                                                              | gated   | `.github/workflows/ci.yml` runs `format:check + lint + typecheck + test + build + docs:check + i18n:check` on all three OSes. This commit has not been pushed yet — the matrix runs when the user pushes. Phase-1 close-out used the same `gated` wording.               |
| ADRs `0007` and `0008` exist.                                                                                     | done    | `docs/dev/decisions/0007-argon2-implementation.md` (status: accepted, dated 2026-05-23) and `0008-session-strategy.md` (status: accepted, dated 2026-05-23) — both follow the house ADR shape (Context, Decision, Consequences, Alternatives, Status).                   |
| `overall.md` and this plan stay accurate; reality wins, fix docs.                                                 | done    | `overall.md` §8 phase-2 status flipped to `done` in this commit; this §14 captures the divergence between the plan as written and reality at close-out (UI manual leg, gated CI).                                                                                        |

### Release-matrix verification

`bun install && bun run format:check && bun run lint && bun run typecheck && bun test && bun run i18n:check && bun run docs:check && bun run build`
all green on the macOS host at close-out. The Linux + Windows legs are
**gated** on the user pushing this commit — `.github/workflows/ci.yml`
runs the same recipe on all three OSes; flip the gated row above to
`done` once the matrix lands green.

### Test count at close-out

`bun test` reports **221 pass / 0 fail / 681 expect() calls** across
40 files. The single smoke run (`bun run smoke`) reports **1 pass /
0 fail / 52 expect() calls** with the extended phase-2 invariants
asserted (see file-level docstring).

### Follow-ups created / referenced during phase 2

- `docs/dev/follow-ups/auth-rate-limit.md` — stub for the
  rate-limit + lockout policy. Captured in 2.1, kept open at
  close-out (out of phase-2 scope per §2). Risk row in §10 cites it.
- `docs/dev/follow-ups/web-component-tests.md` — DOM-runtime
  component tests for `LoginPage`, `ChangePasswordPage`, admin
  pages, `UserMenu`. Inherited from 1.5, re-deferred by 2.6 since
  wiring `happy-dom` + `@testing-library/react` is a phase on its
  own. Stays open; tracked next to phase 3.

No phase-2 follow-up moved to `done/` at close-out: every active
follow-up either pre-dates phase 2 (desktop / packaging) or is the
two above. The `argon2-bundler-asset.md` follow-up never needed to
be created — the smoke test runs argon2 against the production
wrapper on every CI leg, which is the empirical proof the bundler
asset is fine.

### Phase-2 surface map

For the at-a-glance route + middleware inventory of every endpoint
introduced in phase 2, see
[`auth-and-sessions.md`](../architecture/auth-and-sessions.md) §0
("Phase 2 surface map"). The map covers public / authenticated /
`mustChangePassword`-gated / admin-only and the middleware chain
order.

### What flips after this commit lands

- Tasklist row 2.7 → `done`.
- This plan moves from `docs/dev/plans/` to
  `docs/dev/plans/done/` (every 2.x sub-phase row is `done`).
- Every doc that referenced `docs/dev/plans/phase-02-users-and-groups.md`
  is updated to point at the `done/` path.
- `overall.md` §8 phase-2 status flips from "open" to "done" with a
  close-out date pointer to this §14.
