# Contacts

A **contact** is a layered record for a person — name, emails,
phones, optional company link, notes, birthday. Contacts live inside
a layer and are shared via the layer.

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/entities.md` §4b (contacts module).

---

## 1. What a contact is

A contact belongs to **one layer**. Anyone who can see the layer can
open the contact; anyone who can edit the layer can change it.

A contact carries arrays of emails and phone numbers with primary-
flag handling — bunny2 uses the primary email/phone as the row's
subtitle in the list view. The optional company link is the bridge
to the Companies kind so a contact can appear on a company detail
page (and vice versa).

---

## 2. Creating a contact

1. Switch to the layer.
2. Open the **Contacts** widget on the dashboard, or navigate to
   `/l/<your-layer-slug>/contacts`.
3. Click **Create contact** or **Import vCard** — the latter accepts
   a standard `.vcf` file exported from your address book.

---

## 3. Deleting and restoring a contact

Click **Delete contact** on the detail page to soft-delete the row.
Soft-deleted contacts are hidden from the default list but stay in
the database with `deleted_at` set so the audit trail is intact.

### Restoring deleted contacts

To bring a contact back:

1. Open **Contacts** and click **Show deleted** in the top right.
   The list now includes soft-deleted rows with a "Deleted" badge
   next to the name; the URL gains `?includeDeleted=1` so the
   filtered view is share-/bookmark-able.
2. Click the contact you want to restore. The detail page shows a
   red banner at the top: **"This contact is deleted — Restore
   contact"**.
3. Click **Restore contact**, then confirm in the dialog. The
   contact becomes visible again to everyone who can see the layer.

Restore requires the same permission as Delete; the banner is
hidden for viewers who cannot edit the layer.

---

## 4. Adding external links

The contact detail page shows an **External links** card under the
form. vCard imports automatically populate this list with rows
labelled `vcard · <id>` so you can trace which import created the
contact. You can also add a link manually:

1. Type the connector name (for example `crm`, `salesforce`, or a
   free-form label like `intranet`) in the **Connector** field.
2. Type the matching external id (the row id in that connector's
   system) in the **External id** field.
3. Click **Add external link**. The link appears in the list with a
   sync-state badge (`Idle` / `Syncing…` / `Sync failed` — the badge
   only moves when a connector actually claims the row).

To remove a link, click **Remove link** on the row. The action does
not delete the upstream record; it only removes the bunny2-side
association.

---

## 5. Related reading

- `docs/user/guides/working-with-layers.md` — how layers control
  who sees what.
- `docs/user/features/companies.md` — the company link picker on the
  contact form pulls from this list.
