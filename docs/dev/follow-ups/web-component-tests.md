# Follow-up — Web component tests with a DOM runtime

- Status: open
- Created: 2026-05-23
- Phase: 1.5

## What remains

Add component-level tests for `apps/web/src/pages/StatusPage.tsx` and
`apps/web/src/pages/ChatPage.tsx` that render against a mock `fetch`
and assert:

- Loading, success, and error states render the expected i18n keys.
- The chat form posts the right body and surfaces server-emitted error
  keys (`errors.chat.upstream`, `errors.chat.badRequest`).
- Pressing Enter inside the chat textarea submits; Shift+Enter inserts
  a newline.

Stretch: add an axe-core smoke check in test to catch a11y regressions.

## Why not done now

Phase 1.5 deliberately scoped this as optional. Wiring up a DOM runtime
for `bun test` (`happy-dom` or `jsdom`) plus `@testing-library/react`
balloons the diff and forces decisions about test setup that touch
every web test added later. The phase-1.5 spec explicitly allowed
deferring it because the critical paths are already covered:

- `apps/server/tests/http-chat.test.ts` exercises the chat round-trip
  end-to-end against the real bus, event log, and telemetry wrapper.
- `apps/web/tests/i18n-no-hardcoded-strings.test.ts` enforces the
  no-hardcoded-strings discipline.

## Next step

When the next phase introduces UI that has non-trivial branching (likely
phase 2 — auth screens), set up `happy-dom` + `@testing-library/react`
in one PR and bring this set of tests along.

## Related files / docs

- `apps/web/src/pages/StatusPage.tsx`
- `apps/web/src/pages/ChatPage.tsx`
- `apps/web/tests/i18n-no-hardcoded-strings.test.ts`
- `docs/dev/architecture/i18n.md`
- `docs/dev/plans/done/phase-01-system-foundation.md` §4.2 row 1.5 (option F)
