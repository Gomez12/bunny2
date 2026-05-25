# Todos

A **todo** is a layered task — title, description, status, priority,
optional due date, optional link to a contact or company, and free-
form tags. Todos live inside a layer and are shared via the layer.

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/entities.md` §4d (todos module).

---

## 1. What a todo is

A todo belongs to **one layer**. Anyone who can see the layer can
open the todo; anyone who can edit the layer can change it.

The status field uses a fixed enum: `open`, `in_progress`,
`blocked`, `done`, `cancelled`. The page can render the list as a
plain table (list view) or as a Kanban board grouped by status
(kanban view).

---

## 2. Creating a todo

1. Switch to the layer.
2. Open the **Todos** widget on the dashboard, or navigate to
   `/l/<your-layer-slug>/todos`.
3. Click **New todo** and fill in at least a title.

---

## 3. Deleting and restoring a todo

Click **Delete todo** on the detail page to soft-delete the row.
Soft-deleted todos are hidden from the default list and Kanban view
but stay in the database with `deleted_at` set so the audit trail
is intact.

### Restoring deleted todos

To bring a todo back:

1. Open **Todos** and click **Show deleted** in the top right. The
   list now includes soft-deleted rows with a "Deleted" badge next
   to the title; the URL gains `?includeDeleted=1` so the filtered
   view is share-/bookmark-able.
2. Click the todo you want to restore. The detail page shows a red
   banner at the top: **"This todo is deleted — Restore todo"**.
3. Click **Restore todo**, then confirm in the dialog. The todo
   becomes visible again to everyone who can see the layer.

Restore requires the same permission as Delete; the banner is
hidden for viewers who cannot edit the layer.

---

## 4. Related reading

- `docs/user/guides/working-with-layers.md` — how layers control
  who sees what.
- `docs/user/features/calendar.md` — todos with due dates appear as
  read-only projections on the calendar grid.
