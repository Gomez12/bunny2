# Follow-up — Excalidraw embed accessibility audit

- Status: open
- Created: 2026-05-25 (phase 11.6 close-out)
- Phases referencing it: 11.5, 11.6

## What remains

`@excalidraw/excalidraw@0.18.1` ships with partial keyboard / a11y
support, sufficient for the v1 wrapper but with documented upstream
gaps. Per ADR 0029 ("excalidraw embedding policy") the wrapper does
not patch upstream — gaps land here as follow-ups instead.

The audit looked at four areas called out in the phase-11 plan §11.6:

### 1. Keyboard focus on canvas entry

Status: partial. The Excalidraw root container does NOT expose an
explicit `role="application"` or a single canvas-level focus stop.
A keyboard user tabbing into the embed lands on the first toolbar
button (`ToolButton` instances carry `aria-label` + `aria-keyshortcuts`
per the upstream types), which is the expected entry point.

Gap: there is no documented "skip canvas → escape to wrapper" key.
The wrapper mitigates by wrapping the canvas in a `tabIndex={-1}`
container with a labelled escape-to-list anchor above the toolbar
(see `apps/web/src/pages/WhiteboardDetailPage.tsx`). The mitigation
is wrapper-level; the underlying canvas remains a tab trap target.

### 2. Focus trap behavior

Status: partial. Excalidraw's library-import popovers, dropdowns, and
the contextual radial menus manage their own focus internally. The
upstream `DropdownMenu` components carry standard ARIA semantics
(`role="menu"` / `role="menuitem"`) per the type definitions in
`dist/types/excalidraw/components/dropdownMenu/`.

Gap: there is no documented escape route from a modal dialog (e.g.
the library browser) back to the wrapper. The wrapper disables the
library-import affordance in v1 (`UIOptions.libraryReturnUrl = false`
equivalent — see plan §7 Security) which sidesteps the worst case,
but other internal dialogs remain.

### 3. Tooltip contrast

Status: not verified at audit time. The upstream `ToolButton` exposes
`showAriaLabel` to render the label inline (instead of as a tooltip),
which the wrapper does NOT enable. Tooltip styling comes from
Excalidraw's own CSS bundle; the wrapper does not override it. A
WCAG-AA contrast check against the active theme tokens (light + dark)
is left as part of this follow-up.

### 4. Screen-reader landmark naming for the toolbar

Status: partial. Tool buttons carry `aria-label`s sourced from the
upstream i18n bundle (selected via the `langCode` prop the wrapper
threads through from the app's i18n context). There is NO explicit
`<nav>` or `role="toolbar"` landmark around the tool button group; a
screen-reader user discovers buttons via Tab order, not via a
landmark jump.

The wrapper does NOT add a wrapper-level landmark either — adding one
risks duplicating the tool-button labels into an unannounced parent.

## Why not done now

Per ADR 0029 ("excalidraw embedding policy"), Excalidraw upstream is
treated as a closed dependency. Patching focus traps, tooltip CSS, or
landmark naming would require either a fork (rejected) or layering
DOM shimming on top of the embed (fragile, breaks on minor upgrades).

The v1 wrapper covers what wrapper-level code can cover:

- `role="status" aria-live="polite"` on the lock + save indicators.
- `role="alert"` on the save-error banner.
- `tabIndex={-1}` container around the canvas with a labelled
  back-to-list anchor.
- `aria-expanded` / `aria-haspopup="menu"` on the export menu.

Wrapper coverage meets the AGENTS.md §Accessibility floor for the
sub-phase. The four upstream gaps above are tracked here for a
future audit pass.

## Next step

Triage when the first a11y-failing audit hits CI or a user report:

1. **Canvas focus trap escape** — add a wrapper keyboard handler that
   intercepts `Escape` outside of an Excalidraw dialog and shifts
   focus to the back-to-list anchor. Risk: stomps on Excalidraw's own
   escape-to-cancel-selection handler. Validate with a feature flag
   before shipping broadly.
2. **Tooltip contrast** — run an axe-core or Pa11y pass against
   `/l/<slug>/whiteboards/<id>` in both themes; if any contrast
   failure is on a tooltip, file an upstream issue at
   `excalidraw/excalidraw` and switch the wrapper to `showAriaLabel`
   while the upstream fix lands.
3. **Toolbar landmark** — wait for upstream guidance; the GitHub
   issue tracker has open discussions about adding `role="toolbar"`
   but no committed direction as of v0.18.1.

## Upstream tracking

No upstream issue found at audit time. If a follow-up audit confirms
the gaps still exist in a later major, open one at
`https://github.com/excalidraw/excalidraw/issues` and link it here.

## Related files / docs

- `apps/web/src/pages/WhiteboardDetailPage.tsx` (wrapper a11y attributes)
- `docs/dev/decisions/0029-excalidraw-embedding-policy.md`
- `docs/dev/plans/phase-11-whiteboards-excalidraw.md` §11.5, §11.6
- `node_modules/@excalidraw/excalidraw@0.18.1/README.md` (no a11y notes)
- `docs/dev/follow-ups/react-big-calendar-a11y.md` (precedent)
