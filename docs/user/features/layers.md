# Layers

A **layer** is bunny2's unit of sharing. Every entity — companies,
contacts, calendar events, todos, whiteboards — lives inside exactly
one layer, and the layer decides who can see it and who can change
it. The layer switcher in the app header is how you move between
them.

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/layers.md` and the routes are documented in
> `docs/dev/architecture/auth.md` §4.4.

---

## 1. Layer types

- **Personal** — your private layer. Nobody else can see it.
- **Group** — visible to every member of the matching group.
- **Project** — the one type you can create yourself. Lives alongside
  any number of explicit user / group members.
- **Everyone** — visible to every signed-in user. Read-only for most
  flows.

Only **project** layers have managed memberships; the other three
derive their member sets from existing users / groups / sessions.

---

## 2. Viewing and removing members

Open the layer settings (`Settings` in the layer header) and switch
to the **Members** tab. You'll see two sections:

- **Users** — the people directly added to this layer, with their
  role (`owner` or `member`) and username.
- **Groups** — the groups added to this layer; every member of an
  added group inherits access through that row.

Each row has a destructive **Remove** button. Clicking it opens a
confirmation dialog before the change is applied; the focus returns
to the Remove button if you cancel.

### Sole-owner guard

If you're the only owner of a layer, your own Remove button is
disabled with a tooltip explaining why: removing yourself would
leave the layer with no owners. Promote another user (or a group
holding the owner role) to owner first, then come back and remove
yourself.

> The guard is a UI affordance only. The server still permits the
> removal in case you need to recover from an out-of-band state; the
> button is disabled so the common path stays safe.

### After a removal

The removed user loses access on their next request. A group
removal cascades the same way to every user that was only seeing
the layer through that group. If the actor removes themselves, the
layer immediately drops out of their switcher.

---

## 3. Adding members

In the same tab, the **Add member** form below the list lets you
pick a user OR a group from the directory you share at least one
group with, choose a role (`member` or `owner`), and submit. The
new member shows up in the list once the request completes.
