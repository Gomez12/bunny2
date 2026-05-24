# Follow-up — Calendar v1 timezone behaviour + per-layer / per-user preference

- Status: open
- Created: 2026-05-24 (phase 4c.5 close-out)
- Phases referencing it: 4c.5

## What remains

The 4c.5 web UI treats every event as **local to the user's browser
timezone**:

- `<input type="datetime-local">` returns the user's local-time string.
- `buildCreateCalendarEventRequest` serialises that string to UTC ISO
  via `new Date(value).toISOString()`.
- `draftFromCalendarEvent` converts the stored UTC back to local for
  the input control.
- `react-big-calendar` is built with `dateFnsLocalizer` and the
  browser's default zone.

That is **wrong** when:

- A user collaborates across timezones in the same layer (a meeting
  "at 09:00 in Amsterdam" should render as 09:00 in Amsterdam for
  every viewer, not 03:00 EST for an East-Coast viewer).
- A Google-Calendar-imported event carries a non-UTC offset the
  connector currently normalises away.

## Why not done now

The §4c.1 schema already stores ISO-8601 timestamps (UTC for timed
events, date-only for all-day) — the server is timezone-correct. The
v1 UI choice is to render in the local zone so the first user sees
something sensible. A proper fix needs:

- A `defaultTimezone` per layer (or per user) — schema change + UI
  picker.
- A localizer swap in `CalendarPage.tsx` (the library supports moment
  or `Temporal` localizers).
- Migration of any existing local-stored values when the preference
  flips.

None of that fits in 4c.5's "no foundation tweaks" envelope.

## Next step

Land alongside the first user who reports the cross-timezone surprise
(very likely 4c.6 smoke or a 4d cross-entity test). The minimum
change is:

1. Add `LayerLocale`-adjacent `LayerTimezone` row.
2. Surface a per-user override on the account page.
3. Swap `dateFnsLocalizer` for a TZ-aware variant; pass the layer/user
   zone in as the localizer arg.
4. Update `serializeTimestamp` / `toInputFormat` to round-trip through
   the configured zone instead of the host zone.

## Related files / docs

- `apps/web/src/pages/calendar-page-state.ts` (`serializeTimestamp`,
  `toInputFormat`)
- `apps/web/src/pages/CalendarPage.tsx` (`dateFnsLocalizer`)
- `docs/dev/plans/done/phase-04-first-entities.md` §4c.5 close-out
