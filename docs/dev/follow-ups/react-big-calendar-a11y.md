# Follow-up — `react-big-calendar` accessibility audit + bespoke wrapper triage

- Status: open
- Created: 2026-05-24 (phase 4c.5 close-out)
- Phases referencing it: 4c.5

## What remains

`react-big-calendar` ships with passable but incomplete keyboard
support:

- Event chips render as `<button role="button">` inside the cell grid;
  Tab moves between them in DOM order.
- Toolbar buttons (`Back / Today / Next`, view-switcher) are real
  `<button>`s and inherit the shared `<Button>` focus ring via the
  library's own focus visibility CSS.
- `aria-label`s on event chips fall back to the event title — they
  read correctly in NVDA + VoiceOver smoke tests.

What is **NOT** ideal:

- Day-cell focus model is mouse-driven. There is no `arrow-key`
  movement between empty day cells; a screen-reader user landing on
  the grid has to Tab through every event in DOM order to reach the
  next week.
- The all-day band and the timed events use different roles
  (`button` for events vs no explicit role for the band), which
  confuses some screen readers when the user is reviewing the layout.
- The library renders `aria-live="polite"` on the toolbar's title
  region but does not announce view switches; the user can change
  view but the reader stays silent.

## Why not done now

The phase-4 plan §12 explicitly carved this audit out: "if its
day-cell focus model is insufficient, file a follow-up rather than
build a bespoke wrapper". For 4c.5 the library's a11y is sufficient
for sighted-keyboard users plus a screen-reader audit of event chip
labels. Building a custom keyboard-navigation layer or replacing the
grid entirely is out of scope for the web-UI sub-phase.

## Next step

Triage the gaps when the first a11y-failing audit hits CI or a user
report:

1. **Arrow-key cell navigation** — likely fixable by attaching a
   `onKeyDown` handler at the grid root and synthesising a focus move
   to the next `[role="gridcell"]`. Library exposes the cells via the
   `slotPropGetter` extension point.
2. **View-switch announcement** — wrap the view-switcher buttons in a
   region that updates a `role="status"` text node ("Switched to
   week view") on every `onView` callback.
3. **Bespoke wrapper escape hatch** — if (1) and (2) get nowhere,
   replace `<Calendar />` with a thin internal `<CalendarGrid />` that
   composes `dateFnsLocalizer` + a hand-written cell renderer. Last
   resort; the surface area is large.

## Findings summary (4c.5 verdict)

For v1 the library passes the AGENTS.md §Accessibility floor (semantic
HTML, keyboard navigation, visible focus, labels). The gaps above are
real but do not block the sub-phase per the §12 carve-out. Filed as
follow-up rather than fixing in 4c.5.

## Related files / docs

- `apps/web/src/pages/CalendarPage.tsx`
- `docs/dev/plans/phase-04-first-entities.md` §4c.5 close-out + §12
