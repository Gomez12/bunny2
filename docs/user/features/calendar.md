# Calendar

The **calendar** view shows the layer's events on a month / week /
day grid, plus a read-only projection of any todos that have a due
date (see "Todo projection" below).

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/entities.md` §4c (calendar module) and ADR
> 0017 for the todo → calendar projection.

---

## 1. What a calendar event is

An event belongs to **one layer**. Anyone who can see the layer can
open the event; anyone who can edit the layer can change it.

Events carry a title, start/end (or all-day), location, attendees,
optional conference URL, and a free-form description. Imported
Google Calendar events additionally carry an `externalCalendarId`
and a recurrence rule (read-only on the form — recurrence is owned
by the upstream calendar).

---

## 2. Creating an event

1. Switch to the layer.
2. Open the **Calendar** widget on the dashboard, or navigate to
   `/l/<your-layer-slug>/calendar`.
3. Click **New event** and fill in the form.

---

## 3. Syncing with Google Calendar

If the layer has a Google Calendar attachment configured, click
**Sync Google now** to pull the latest events. The toast reports
how many events were created vs updated; existing events are
matched by `externalCalendarId`.

---

## 4. Deleting and restoring an event

Click **Delete event** on the detail page to soft-delete the row.
Soft-deleted events disappear from the calendar grid but stay in
the database with `deleted_at` set so the audit trail is intact.

### Restoring deleted events

To bring an event back:

1. Open the calendar and click **Show deleted** in the top right.
   The grid now includes soft-deleted events, prefixed with the
   `[Deleted]` badge in their title; the URL gains
   `?includeDeleted=1` so the filtered view is share-/bookmark-able.
2. Click the event you want to restore. The detail page shows a red
   banner at the top: **"This event is deleted — Restore event"**.
3. Click **Restore event**, then confirm in the dialog. The event
   becomes visible again on the calendar for everyone who can see
   the layer.

Restore requires the same permission as Delete; the banner is
hidden for viewers who cannot edit the layer.

---

## 5. Todo projection

When a todo in the same layer has a due date, the calendar shows it
as a read-only entry prefixed with the localized "Todo" label. You
cannot edit the projection inline — click through to the todo
detail to change the due date or status.

---

## 6. Related reading

- `docs/user/guides/working-with-layers.md` — how layers control
  who sees what.
- `docs/user/features/todos.md` — todos that surface here as
  projections.
