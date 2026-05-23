# Follow-up — Web component tests with a DOM runtime

- Status: open
- Created: 2026-05-23
- Updated: 2026-05-23 (phase 3.5)
- Phases referencing it: 1.5 (origin), 2.6 (deferred again), 3.5 (extended scope)

## What remains

Wire `happy-dom` + `@testing-library/react` into `bun test` and add
component-level tests for the now-existing pages:

- `apps/web/tests/login-page.test.tsx` — empty state, submit happy
  path mocking `fetch`, error path renders the localized message,
  focus management (username on mount, error region on failure).
- `apps/web/tests/change-password-page.test.tsx` — forced mode hides
  the `currentPassword` input; mismatch shows the inline error;
  success closes the page (calls `onSuccess`).
- `apps/web/tests/admin-users-page.test.tsx` — lists users, opens
  create dialog, calls `POST /admin/users`, surfaces the generated
  password dialog, refreshes the list.
- `apps/web/tests/admin-groups-page.test.tsx` — admin-slug delete is
  disabled, edit dialog patches the right fields.
- `apps/web/tests/user-menu.test.tsx` — open/close keyboard +
  click-away, sign-out triggers `applyLogout`.
- `apps/web/tests/status-page.test.tsx` /
  `apps/web/tests/chat-page.test.tsx` — the original phase-1.5
  stretch goals (loading / success / error renders, Enter vs
  Shift+Enter, error key mapping).

Phase 3.5 added the layer UI; once the DOM runtime is present the
following also belong here (see plan §6):

- `apps/web/tests/layer-switcher.test.tsx` — keyboard nav
  (Arrow Down opens, Arrow keys move focus, Enter selects, Escape
  closes), `aria-current` on the matching row, navigates to
  `/l/<new>/<sub>`.
- `apps/web/tests/my-layers-page.test.tsx` — row click navigates to
  `/l/:slug/dashboard`; create-layer dialog focus trap.
- `apps/web/tests/layer-settings-page.test.tsx` — Members / Visibility
  / Locales / Attachments tabs render read-only for a non-owner and
  editable for an owner.
- `apps/web/tests/layer-dashboard-page.test.tsx` — empty state copy +
  `aria-disabled="true"` on the configure-widgets link when
  `canEdit === false`.

Phase 3.5 currently covers the pure helpers under
`apps/web/tests/layer-helpers.test.ts` (computeCanEdit,
subpathFromLocation, pickPersonalLayer, toast queue) — enough to
catch logic regressions, but not the rendering / a11y matrix.

Stretch: add an axe-core smoke check in test to catch a11y regressions.

## Why not done now

Both phase 1.5 and phase 2.6 deliberately deferred this. Wiring a DOM
runtime for `bun test` (`happy-dom` or `jsdom`) plus
`@testing-library/react` is a phase on its own — tsconfig changes, bun
test config, render helper, fetch mock helper, i18n test bootstrap, and
a decision about how to keep this from blowing up test runtime in CI.

Phase 2.6 fits the budget by leaning on:

- `scripts/i18n-check.ts` + `apps/web/tests/i18n-no-hardcoded-strings.test.ts`
  catching every regression in the no-hardcoded-strings discipline.
- `@axe-core/react` in `apps/web/src/main.tsx` surfacing a11y
  violations in the dev console.
- Server-side integration tests already covering the HTTP contract
  the UI talks to.
- A documented manual smoke against `bun run dev:web` after the
  initial admin login.

## Next step

Open a single PR after phase 2.6:

1. Add `happy-dom` (or `jsdom`) + `@testing-library/react` +
   `@testing-library/user-event` to `apps/web/devDependencies`.
2. Add a `tests/setup.ts` that boots i18n synchronously and registers
   the DOM globals; reference it from `bunfig.toml`'s `[test]
preload`.
3. Add a shared render helper + a small `mockFetch` utility under
   `apps/web/tests/helpers/`.
4. Bring along the six files listed under "What remains" above.
5. Mark this follow-up `done` and move it under `done/`.

## Related files / docs

- `apps/web/src/pages/LoginPage.tsx`
- `apps/web/src/pages/ChangePasswordPage.tsx`
- `apps/web/src/pages/admin/AdminUsersPage.tsx`
- `apps/web/src/pages/admin/AdminGroupsPage.tsx`
- `apps/web/src/pages/admin/GroupDetailPage.tsx`
- `apps/web/src/components/UserMenu.tsx`
- `apps/web/src/components/ui/dialog.tsx`
- `apps/web/src/lib/session.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/tests/i18n-no-hardcoded-strings.test.ts`
- `docs/dev/architecture/i18n.md`
- `docs/dev/architecture/auth-and-sessions.md` §11 (Web UI surface)
