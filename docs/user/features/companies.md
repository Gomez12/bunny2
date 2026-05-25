# Companies

A **company** is a layered record for an organisation you work with —
a customer, a supplier, a partner. Companies live inside a layer and
are shared via the layer (same model as every other bunny2 entity).

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/entities.md` §4a (companies module) and the
> §4.0 generic entity router covers the CRUD surface.

---

## 1. What a company is

A company belongs to **one layer**. Anyone who can see the layer can
open the company; anyone who can edit the layer can change it.

A company has a name, optional KvK number (Netherlands chamber-of-
commerce id), website, contact details, an address, and a free-form
description. The description is filled in automatically by the AI
enrichment job when a KvK link or sufficient context exists — you
can edit it manually any time.

---

## 2. Creating a company

1. Switch to the layer where the company should live (use the layer
   switcher in the app header).
2. Open the **Companies** widget on the layer dashboard, or navigate
   to `/l/<your-layer-slug>/companies`.
3. Click **Create company** and fill in at least a name. The form
   surfaces all the fields the AI enrichment job uses as
   provenance — KvK number, website, address, contact details.

The new company shows up in the list view for everyone who can see
the layer.

---

## 3. Linking a KvK number

Open the company detail page, scroll to **External links**, type an
8-digit KvK number, and click **Link KvK**. The server queues an
enrichment job that pulls the trade name, legal form, registered
address, and a description from the public KvK extract. The link's
status badge transitions from `Idle` → `Syncing…` → `Idle` (or
`Sync failed` if the upstream API rejected the lookup); a Refresh
status button re-polls without a full page reload.

---

## 4. Deleting and restoring a company

Click **Delete company** on the detail page to soft-delete the row.
Soft-deleted companies are hidden from the default list (they stay
in the database with `deleted_at` set so the audit trail is intact).

### Restoring deleted companies

To bring a company back:

1. Open **Companies** and click **Show deleted** in the top right.
   The list now includes soft-deleted rows with a "Deleted" badge
   next to the name; the URL gains `?includeDeleted=1` so the
   filtered view is share-/bookmark-able.
2. Click the company you want to restore. The detail page shows a
   red banner at the top: **"This company is deleted — Restore
   company"**.
3. Click **Restore company**, then confirm in the dialog. The
   company becomes visible again to everyone who can see the layer.

Restore requires the same permission as Delete; the banner is
hidden for viewers who cannot edit the layer.

---

## 5. Related reading

- `docs/user/guides/working-with-layers.md` — how layers control
  who sees what.
- `docs/user/features/contacts.md` — contacts and the company-link
  picker.
