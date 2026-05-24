# Follow-up — Manual contact creation is too thin to be useful

- Status: open
- Created: 2026-05-24 (user request: "ik wil de entiteit contacts ook
  handmatig kunnen toevoegen")
- Phases referencing it: 4b.2 (vCard ingest landed), 4b.5 (list page
  and create dialog landed in the current minimal form)

## What remains

A "Create contact" dialog already exists on the contacts list page
(`apps/web/src/pages/ContactsListPage.tsx` — `CreateContactDialog`).
Today it only collects four fields:

- `title` (the displayed name)
- `slug` (auto-derived from title, editable)
- `givenName`
- `familyName`

Everything that makes a contact useful — emails, phone numbers,
company link, job title, notes — has to be added _afterwards_ via the
detail page. That's discoverable for power users, but to a first-time
user it looks as if "create contact" is broken: they enter a name,
land on a near-empty detail page, and have to figure out the edit
flow before any real data is in.

The server side is already in place — `apps/server/src/entities/contacts/module.ts`
accepts the full payload (emails, phones, jobTitle, organization,
companyEntityId, notes) on `POST /l/:slug/contact`. So this is a UI
gap, not a backend one.

## Proposed approach

Two viable shapes. Pick before starting; both are smaller than half a
day.

### Option A — Enrich the create dialog inline (recommended)

Expand `CreateContactDialog` so the same form that the detail page
shows in edit mode is available at creation time. Reuse the
sub-editors (`EmailEditor`, `PhoneEditor`, the company picker, the
notes textarea) already defined in `ContactDetailPage.tsx`.

Pros: one motion to enter a complete contact; mirrors how a typical
address-book app behaves.
Cons: the dialog grows tall. Use a scrollable body inside the
native `<dialog>` and keep the fold above the sub-editors so the
required `title` is always visible.

Concrete steps:

1. Lift the sub-editor components from
   `apps/web/src/pages/ContactDetailPage.tsx` into a shared module
   under `apps/web/src/components/contacts/` (`EmailListEditor`,
   `PhoneListEditor`, `CompanyPicker`). The detail page imports
   them from there too — no behaviour change for existing edits.
2. Extend `ContactFormDraft` (`contacts-page-state.ts`) so the
   create form holds the same shape as the edit form. `validateContactForm`
   and `buildCreateContactRequest` get a few more branches; existing
   tests stay green and new test rows cover the additional fields.
3. Update `CreateContactDialog` to render the editors and persist
   their drafts into the same `buildCreateContactRequest` call.
4. New i18n keys are already covered — every label exists for the
   detail page; reuse them in the dialog with the same keys.

### Option B — Two-step "create then edit"

Keep the dialog minimal, then immediately route to the detail page
in edit mode after successful creation (instead of read mode).
Smaller change, but it surfaces the same data twice (the toast says
"contact created" while the page asks the user to _finish_ creating
it). Mention but do not recommend.

## Why not done now

User asked for a tasklist row, not an implementation. Sized as ~4h
including the small refactor of the detail-page editors into a
shared `components/contacts/` module, the state extensions, and the
extra rows in `apps/web/tests/contacts-list-page.test.ts` for the
new validation branches.

## Next step

1. Confirm Option A.
2. Lift the editors into `apps/web/src/components/contacts/`.
3. Extend the form draft + payload builder + validator in
   `apps/web/src/pages/contacts-page-state.ts`; cover the new
   branches in `apps/web/tests/contacts-list-page.test.ts`.
4. Wire the dialog. Manual sanity check: create one contact with
   two emails (one primary), one phone, a company link, and a
   note; round-trip via refresh.
5. If a user-guide page exists for contacts, update the "create"
   subsection there.

## Related files / docs

- `apps/web/src/pages/ContactsListPage.tsx` — current
  `CreateContactDialog`.
- `apps/web/src/pages/ContactDetailPage.tsx` — the rich editors
  to lift.
- `apps/web/src/pages/contacts-page-state.ts` — form draft +
  validator + payload builder.
- `apps/web/tests/contacts-list-page.test.ts`,
  `apps/web/tests/contacts-detail-page.test.ts` — existing
  pure-logic test coverage to extend.
- `apps/server/src/entities/contacts/module.ts` — payload schema
  (no changes needed; it already accepts the full shape).
- `docs/user/features/` — destination for any user-facing
  documentation update once the richer form ships.
