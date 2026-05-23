# Follow-up — Rate limiting + lockout on `/auth/login`

- Status: open
- Created: 2026-05-23 (phase 2.7 close-out — referenced since 2.3)
- Phases referencing it: 2.1 (risk row), 2.3 (event capture only),
  2.7 (gap acknowledged at phase-2 close-out)

## What remains

Phase 2 captures every login outcome on the bus
(`user.login.succeeded`, `user.login.failed { reason }`) and equalises
the response latency across the three failure branches
(`unknown_user`, `soft_deleted`, `wrong_password`) so a network
observer cannot disambiguate them by timing. What it **does not** do
is throttle:

- No per-IP / per-username request rate limit.
- No exponential backoff after N consecutive failures.
- No account-lockout window after a threshold (with admin unlock or
  time-based recovery).

The events are in the log so an admin could grep them, but enforcement
is purely manual.

Concrete next pieces of work:

1. Decide the policy: per-IP, per-username, or both (recommend both
   with the tighter of the two). Capture in an ADR or amend
   `auth-and-sessions.md` §1.
2. Pick the algorithm. Plain fixed-window counters in `kv_meta` would
   work for a portable single-process build; sliding-window is a
   small refinement. Token bucket is overkill for an internal tool.
3. Add columns or a `login_attempts` table — keyed by
   `(username_or_ip, started_at)`. Decide retention (5 minutes?
   1 hour?) and prune via the existing retention machinery.
4. Wire the check into `apps/server/src/http/routes/auth.ts` before
   the dummy-verify branch so an attacker cannot consume CPU by
   forcing argon2 verify on every probe.
5. Surface the lockout state in `/auth/login` 429 / 423 responses
   with i18n keys (`errors.auth.tooManyAttempts`,
   `errors.auth.accountLocked`) and an HTTP `Retry-After` header.
6. Add tests: cap exceeded → 429, cap resets after the window, lock
   set after threshold → 423.

## Why not done now

Phase 2 prioritised the happy path (login, gate, session, group +
user CRUD, UI) and capturing the audit signal needed to drive the
eventual policy. The phase-2 plan §10 lists this risk explicitly,
and §2 (Out of scope) calls out "Rate limiting / lockout on login —
events captured, enforcement is a follow-up." Picking a policy that
holds up across an Electron renderer, the smoke harness, and a
potential CLI/MCP client is not free; punting until a real attack
surface justifies the policy is the right call for v1.

## Next step

Pick a phase to schedule this (phase 3 is the next that touches the
auth surface — convenient slot), open a tasklist row with this
follow-up as the `Related document`, and start with step 1 above
(policy ADR).

## Related files / docs

- `apps/server/src/http/routes/auth.ts` — login route + event
  emission.
- `apps/server/src/auth/password.ts` — `dummyVerify()` for timing
  equalisation (rate limiting layers on top of, not in place of,
  this).
- `docs/dev/architecture/auth-and-sessions.md` §1 (login timing
  equalisation) + §12 (Open extensions).
- `docs/dev/plans/done/phase-02-users-and-groups.md` §2 (Out of
  scope), §10 (Risks), §14 (Close-out).
