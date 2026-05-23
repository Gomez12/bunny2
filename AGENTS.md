# AGENTS.md

## Big Rules

- Use Bun.
- Use TypeScript.
- Use English for technical work.
- Use i18n for user-facing text.
- Keep docs true.
- Keep tests green.
- Keep UI consistent.
- Keep changes small.
- Track all work in `docs/dev/tasklist.md`.

---

## Before Work

Agent must:

1. Read `docs/dev/tasklist.md`.
2. Check if task exists.
3. Add task if missing.
4. Read relevant docs.
5. Read relevant code.
6. Understand impact.
7. Then change code.

No task in tasklist = no work starts.

---

## Tasklist

Tasklist lives here:

```txt
docs/dev/tasklist.md
```

Archive lives here:

```txt
docs/dev/tasklistarchive.md
```

Each task needs:

- Status
- Related document
- Estimate
- Very short description

Use this format:

```md
| Status | Related document          | Estimated work | Description |
| ------ | ------------------------- | -------------: | ----------- |
| open   | docs/dev/plans/example.md |             4h | Add feature |
```

Allowed statuses:

```txt
open
in-progress
needs-testing
deferred
paused
rejected
done
```

Meaning:

| Status          | Meaning                     |
| --------------- | --------------------------- |
| `open`          | Known. Not started.         |
| `in-progress`   | Work happening.             |
| `needs-testing` | Code done. Checks not done. |
| `deferred`      | Later. Not now.             |
| `paused`        | Started. Blocked.           |
| `rejected`      | Will not do.                |
| `done`          | Finished and checked.       |

Keep max 50 `done` tasks in `docs/dev/tasklist.md`.

More than 50 `done` tasks? Move oldest done tasks to:

```txt
docs/dev/tasklistarchive.md
```

Do not delete task history.

---

## Docs

Docs matter.

Update docs when change affects:

- Behavior
- Architecture
- API
- Setup
- Build
- Tests
- UI patterns
- i18n
- Accessibility
- Security
- User workflow
- Troubleshooting

No stale docs.

Code and docs disagree? Code is current. Fix docs.

Missing docs? Create docs.

Confusing docs? Improve docs.

---

## Docs Structure

Use this shape:

```txt
docs/
  dev/
    tasklist.md
    tasklistarchive.md
    architecture/
    setup/
    testing/
    api/
    components/
    styleguide/
    decisions/
    plans/
      done/
    risks/
    follow-ups/
      done/
    troubleshooting/
    agents/
  user/
    guides/
    features/
    faq/
    troubleshooting/
    release-notes/
```

Developer docs explain how system works.

User docs explain how product is used.

Do not mix them.

---

## Plans

Big work needs plan.

Active plans go here:

```txt
docs/dev/plans/
```

Done plans go here:

```txt
docs/dev/plans/done/
```

Keep only active or unresolved plans in `docs/dev/plans/`.

Move a plan to `docs/dev/plans/done/` when the related task is `done`.

When moving a plan, update the tasklist `Related document` path.

Plan should say:

- Goal
- Scope
- Non-goals
- Approach
- Affected modules
- Tests
- Docs impact
- i18n impact
- Accessibility impact
- Risks
- Open questions

Plan exists? Tasklist item must exist.

Plan-backed task starts? Split into phases first.

---

## Risks

Risks go here:

```txt
docs/dev/risks/
```

Risk should say:

- Description
- Impact
- Likelihood
- Mitigation
- Owner or area
- Status

Risk gone? Update docs.

No stale risks.

---

## Follow-Ups

Active follow-ups go here:

```txt
docs/dev/follow-ups/
```

Done follow-ups go here:

```txt
docs/dev/follow-ups/done/
```

Keep only active or unresolved follow-ups in `docs/dev/follow-ups/`.

Move a follow-up to `docs/dev/follow-ups/done/` when the remaining work is finished.

When moving a follow-up, update related tasklist or docs references.

Follow-up should say:

- What remains
- Why not done now
- Next step
- Related files or docs
- Status

Follow-up needs future work? Add tasklist item.

Do not mention follow-up in final answer unless it is documented.

---

## Language

Use English for:

- Code
- Comments
- Tests
- Commits
- PRs
- Technical docs
- Developer docs
- API names
- Error codes
- Config
- CLI output keys

Localized content allowed for:

- UI text
- Labels
- Help text
- Validation messages
- User guides for a locale
- Support conversations
- Localized examples

User-facing text must use i18n.

No hardcoded user-facing strings.

---

## i18n

Translation keys must be stable and clear.

Good:

```txt
auth.login.title
auth.login.submit
auth.login.error.invalidCredentials
```

Bad:

```txt
title
button1
errorMessage
text
```

English is primary fallback language.

Missing translations must fail checks.

---

## Bun

Use Bun unless project says otherwise.

Prefer:

```bash
bun install
bun run dev
bun run build
bun test
bun run lint
bun run typecheck
bun run format
```

Avoid:

- npm
- yarn
- pnpm
- Node-only tooling

Use other tooling only with documented reason.

---

## Platforms

Project must work on:

- macOS
- Linux
- Windows

Avoid:

- Bash-only scripts
- OS-specific paths
- Hardcoded absolute paths
- Platform-specific env syntax
- Shell tricks that break on Windows

Prefer:

- Bun scripts
- TypeScript scripts
- `path.join`
- `path.resolve`
- `Bun.env`
- Explicit platform handling

---

## Code

Code must be:

- Simple
- Typed
- Readable
- Testable
- Maintainable
- Explicit about errors
- Consistent with architecture

Avoid:

- `any`
- Unsafe casts
- Hidden side effects
- Global mutable state
- Duplicated logic
- Magic values
- Silent failures
- Huge files
- Mixed UI and business logic
- Hardcoded user-facing strings

---

## Errors

Errors must be intentional.

Expected production error needs:

- Stable code
- Developer explanation
- Localized user message when shown to user
- Test
- Docs when useful

Never show users:

- Stack traces
- Secrets
- Tokens
- Internal details

User error message must be:

- Clear
- Useful
- Localized
- Consistent

---

## Tests

Production behavior needs tests.

Use right test level:

- Unit
- Integration
- Component
- End-to-end
- Regression
- Accessibility
- i18n
- Error tests

Bug from user? Do red-green:

1. Write failing test.
2. See it fail.
3. Fix bug.
4. See it pass.
5. Add edge cases if useful.
6. Document if useful.

Do not delete tests to pass build.

Do not ignore failing tests.

Exception? Document why.

---

## Test Names

Test names use English.

Good:

```ts
it("shows a localized validation message when the email address is invalid", () => {});
```

Bad:

```ts
it("test error", () => {});
```

---

## UI

Use:

- Tailwind
- shadcn/ui
- Shared components
- Design tokens
- Consistent spacing
- Consistent typography
- Consistent colors
- Consistent icons
- Consistent states

Avoid:

- One-off styles
- Inline styles without reason
- Hardcoded colors
- Duplicate variants
- Random spacing
- Random buttons
- New components when old component works

Before new component:

1. Check existing components.
2. Reuse or extend if possible.
3. Follow shadcn/ui.
4. Keep small.
5. Separate presentation and logic.
6. Add tests.
7. Add docs when reusable pattern changes.

---

## Styleguide

Styleguide lives here:

```txt
docs/dev/styleguide/
```

Update it when reusable UI pattern changes.

Styleguide should cover:

- Colors
- Typography
- Spacing
- Icons
- Buttons
- Forms
- Tables
- Cards
- Dialogs
- Navigation
- Loading states
- Empty states
- Error states
- Responsive behavior
- Accessibility
- Examples

---

## Accessibility

UI must be accessible.

Need:

- Semantic HTML
- Keyboard navigation
- Visible focus
- Labels
- Good contrast
- Screen-reader friendly errors
- Accessible dialogs
- Accessible menus
- Accessible popovers

Do not make mouse-only UI.

New interactive component needs accessibility check.

---

## Performance

Think performance.

Prefer:

- Small bundles
- Lazy loading
- Fewer re-renders
- Efficient data fetching
- Clear loading states
- Measured optimization

Do not add heavy dependency without reason.

Document big performance decisions.

---

## Security

Validate:

- User input
- API responses
- Env vars
- File paths
- URLs
- Auth state
- Authorization

Avoid:

- Logging secrets
- Exposing tokens
- Client-only security
- Unsafe HTML
- Unsafe redirects
- Leaking internals

Security behavior needs tests.

---

## Dependencies

Before dependency:

1. Check existing solution.
2. Prefer small package.
3. Check maintenance.
4. Check Bun support.
5. Check browser/server support.
6. Check bundle size.
7. Document reason.

No dependency for trivial work.

---

## Git

Commits use English.

Prefer conventional commits:

```txt
feat: add localized onboarding flow
fix: handle invalid product import files
test: add regression test for upload validation
docs: update developer testing guide
refactor: simplify translation loading
```

One commit = one focused change.

Do not mix unrelated work.

---

## Pull Requests

PR should say what applies:

- What changed
- Why changed
- Tests
- Docs
- Tasklist item
- Task status
- Estimate review
- Plans
- Risks
- Follow-ups
- Archive maintenance
- Screenshots for UI
- i18n impact
- Accessibility impact
- Known limits
- Migration notes

Before ready PR, run checks.

Recommended:

```bash
bun install
bun run format:check
bun run lint
bun run typecheck
bun test
bun run build
bun run docs:check
bun run i18n:check
```

`bun run docs:check` enforces:

- Every active plan in `docs/dev/plans/`, excluding `docs/dev/plans/done/`, is referenced from `docs/dev/tasklist.md`.
- No `done` plan remains in `docs/dev/plans/`; move it to `docs/dev/plans/done/`.
- No completed follow-up remains in `docs/dev/follow-ups/`; move it to `docs/dev/follow-ups/done/`.
- `docs/dev/tasklist.md` keeps at most 50 `done` rows.
- Every `job.kind` registered via the per-domain `register…Handler`
  helpers wired in `src/server/index.ts` appears in the
  `docs/dev/architecture/job-inventory.md` table. Same diff also runs
  from `tests/docs/job-inventory.test.ts`.

Use real project scripts if different.

---

## Done Means Done

Task is done only when applicable items are true:

- Task exists in `docs/dev/tasklist.md`
- Status is correct
- Related doc exists
- Estimate exists
- Short description exists
- Code complete
- Tests added or updated
- Bug has regression test
- Error states tested
- i18n used
- UI follows styleguide
- Accessibility checked
- Developer docs updated
- User docs updated
- Plans updated
- Done plans moved to `docs/dev/plans/done/`
- Risks updated
- Follow-ups updated
- Done follow-ups moved to `docs/dev/follow-ups/done/`
- Format passes
- Lint passes
- Typecheck passes
- Tests pass
- Build passes
- Archive done if more than 50 done tasks
- No unrelated changes

---

## Agent Must

- Read tasklist first.
- Track work.
- Read docs.
- Read code.
- Make small change.
- Test change.
- Update docs.
- Update task status.
- Keep i18n.
- Keep UI consistent.
- Keep accessibility.
- Keep security.
- Keep build green.
- Explain assumptions.
- Mention only documented risks and follow-ups.

---

## Agent Must Not

- Start untracked work.
- Ignore failing tests.
- Remove tests to pass.
- Bypass i18n.
- Hardcode user text.
- Add visual one-off without reason.
- Silently change public behavior.
- Skip docs for user-visible change.
- Leave stale plans.
- Leave done plans in `docs/dev/plans/`.
- Leave stale risks.
- Leave stale follow-ups.
- Leave completed follow-ups in `docs/dev/follow-ups/`.
- Leave stale tasklist entries.
- Delete completed task history.
- Keep more than 50 done tasks in active tasklist.
