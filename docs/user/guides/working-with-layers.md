# Working with layers

bunny2 organises everything you do — chats, contacts, todos,
documents, every entity that arrives in phase 4 — by **layer**.
This guide explains what a layer is, what kinds of layer you'll see,
and how to move between them.

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/layers-and-auth.md` and the per-layer
> authorization table is in
> `docs/dev/decisions/0009-layer-model.md`.

---

## 1. What is a layer?

A layer is a **scope**. Everything you create lives inside one
layer, and you only see the layers you have access to. Think of
layers as folders that travel with their own membership, locales,
and (later) their own AI helpers — but you can also nest them so a
project layer can see the broader group's content, and the group can
see the company-wide layer.

The rule of thumb: **a layer sees everything above it** in the
hierarchy. Your personal layer sees your group layers, which see
the everyone layer. A project layer you create sees the everyone
layer by default; you can attach it to a parent group layer if you
want it to inherit more.

---

## 2. Your layers at a glance

When you log in, bunny2 ships with these layer kinds:

- **Everyone** — the company-wide layer. Everyone in the system can
  read it. Only an admin can create or remove entities here.
- **Personal — `<your name>`** — your private scratch space. Only
  you can see it. It sees everything in your group layers and in
  Everyone.
- **Group — `<group name>`** — one per group you belong to. Other
  members of the group see it; non-members do not. Site-admins can
  edit it (per-group admin roles are on the follow-up list — for
  now, ask an admin to make changes).
- **Project — `<project name>`** — any layer you (or a colleague)
  created with the **Create project layer** button. Membership is
  per-project: the creator becomes the owner and can add other users
  or groups. Visibility into a project layer is opt-in, not
  automatic.

You can spin up as many project layers as you need. There is no
admin gate on creating one.

---

## 3. Switching layers

The current layer is **always part of the URL**, so bookmarks and
browser history "just work":

- `/l/personal-you/dashboard` opens your personal dashboard.
- `/l/bunny2/dashboard` opens the project layer named `bunny2`.
- Copy-pasting a layer URL into another tab (or reopening bunny2
  after a restart) lands you on the same layer.

To switch layers, use the **Layer Switcher** in the app header
(next to your account chip). It lists every layer you have access
to, grouped by type. Selecting a layer navigates to the same logical
page under the new slug — if you were on the dashboard of one layer,
you land on the dashboard of the next.

Keyboard users: the switcher is fully keyboard-navigable. Use Tab
to focus it, Enter or Space to open, arrow keys to move between
layers, and Enter to select.

### Layer no longer visible?

If you bookmark a layer URL and later lose access (the project owner
removed you, or the layer was deleted), bunny2 routes you back to
your personal layer and shows a brief notification.

---

## 4. Creating a project layer

Project layers are the only kind you create yourself.

1. Open the **My Layers** page (`/layers`) from the main navigation.
2. Click **Create project layer**.
3. Fill in:
   - **Slug** — the URL fragment for the layer (lowercase letters,
     digits, dashes). Stays stable, so pick something memorable.
   - **Name** — the human-readable title shown in the switcher.
   - **Description** — optional, but useful when teammates browse.
4. Click **Create**.

You land on the new layer's dashboard. The empty grid will fill in
once entity widgets ship in phase 4. From here you can open the
layer's settings to add members and customise locales.

---

## 5. Layer settings — tabs

Open the **Settings** page from any layer (`/l/:slug/settings`).
The page has five tabs:

- **General** — the layer's name and description. Owners and
  site-admins can edit; everyone else sees the same fields
  read-only.
- **Members** — who has access to the layer. **In v1 you'll need
  to use the API directly to add or remove members** — the picker
  UI for non-admin users is on the follow-up list
  (`docs/dev/follow-ups/layer-members-picker.md`). Site-admins can
  use the admin pages.
- **Visibility** — the layer's parent / child edges. The page shows
  the current edges and lets you add a parent (so this layer
  inherits the parent's content). **In v1 the page does not list
  existing edges** — the read endpoint is on the follow-up list
  (`docs/dev/follow-ups/layer-visibility-list.md`). You can add a
  new edge from the UI; to inspect or remove existing ones, an
  admin can query the API.
- **Locales** — which languages the layer's content uses. Pick a
  subset of the system-configured locale list and optionally a
  default. New content authored in this layer defaults to the
  chosen default locale.
- **Attachments** — agents, skills, and MCP servers registered
  against the layer. **In v1 the page shows only the attachments
  you add in the current session** — a persistent listing is on the
  follow-up list (`docs/dev/follow-ups/layer-attachments-on-get.md`).
  Registration works; the consumer (the chat agent in phase 7+)
  is the one that will actually use it.

The "v1 you'll need to use the API for X" wording is deliberate:
the server-side endpoints are all in place and tested, but three
read-side gaps on the UI side are tracked as explicit follow-ups
so they don't get lost.

### Deleting a project layer

If you created a project layer by accident — or it has served its
purpose — open the layer's settings and scroll to the **Danger
zone** card under the tabs. The card only appears for **project**
layers; personal, group, and "everyone" layers are seeded
automatically and can't be removed.

Click **Delete layer**. A confirmation dialog asks you to confirm
the destructive action. On confirmation the layer disappears from
your switcher and from every other member's view, and you're
routed back to the **My Layers** page. The entities that were
created inside the layer are kept in the database as soft-deleted
records so a site administrator can recover them; through the UI
the deletion is permanent.

You need edit rights to see the button enabled — that's the layer's
owner or a site administrator. If the button is disabled, ask the
owner (or an admin) to do it for you.

---

## 6. Where does my data go?

Every entity you create lives in **the layer you were on when you
created it**. Phase 3 ships only the scaffolding (no entities yet
in v1); phase 4 adds Companies, Contacts, Calendar, and Todos.
When those land, "where does it live?" answers itself: the layer in
the URL is where it goes.

For chats and the upcoming chat assistant (phase 6), the same rule
applies. Your conversation is scoped to the layer; the AI can only
retrieve content you can see — bunny2 filters search results by
your layer access **before** the search runs, never after.

---

## 7. Related reading

- [`getting-started.md`](./getting-started.md) — first launch and
  your personal layer.
- [`admin-managing-users.md`](./admin-managing-users.md) — admin
  surface for users + groups (group layers are seeded from groups).
