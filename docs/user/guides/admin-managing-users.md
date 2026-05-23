# Administering users and groups

This guide is for the bunny2 **administrator** — the person who runs
the portable build and manages who else can log in. End users do not
see most of these screens; they only see the **Sign in** page and
their own **Change password** dialog.

If you are an end user, see
[`getting-started.md`](./getting-started.md) for the first-time login
flow.

---

## 1. First-time login

The very first time you launch bunny2 against a brand-new data
directory, the server prints a one-time initial admin password to its
log. In the desktop app you see it in the server console; in dev mode
it is on the terminal where you ran `bun run dev:server`. The block
looks like this:

```
════════════════════════════════════════════════════════════
 bunny2 initial admin credentials (this is the only time
 you will see this — write it down)

   username: admin
   password: <24-char random string>

 Log in to the UI and change the password immediately.
════════════════════════════════════════════════════════════
```

This password is printed **once**. If you miss it, the only recovery
on a fresh dev install is to delete the data directory (see
[`docs/dev/setup/running.md`](../../dev/setup/running.md) §First-run
admin password) and start over — there is no "reseed admin" path by
design.

After signing in, bunny2 immediately takes you to the **Change
password** screen. You cannot reach any other screen until you set a
new password (every other request returns
`errors.auth.mustChangePassword`). Pick a password that is at least
12 characters long and contains at least one non-letter character.

> **Why the forced rotation?** The initial password is a bootstrap
> credential, not a long-term secret. Forcing rotation on first login
> means the printed value has no value once you are in.

---

## 2. Creating a user

Once you are logged in as `admin`:

1. Open **Admin · Users** from the top navigation.
2. Click **New user**.
3. Fill in:
   - **Username** — 3-32 characters, letters / digits / `.` / `_` /
     `-`. Case-insensitive uniqueness; "Alice" and "alice" collide.
   - **Display name** — what the rest of the UI shows (1-100 chars).
   - **Initial password** — optional. Leave it blank to have bunny2
     generate a 24-character random one for you.
   - **Groups** — optional. Pick any combination of existing groups.
     Adding a user to the `admin` group makes them an administrator.
4. Click **Create**.

If you left **Initial password** blank, bunny2 shows the generated
password in a dialog with a **Copy** button. **This is the only time
you will see it.** Copy it, paste it somewhere safe, then share it
with the new user through a channel you trust (in-person, password
manager share, encrypted chat — not email).

The new user starts with `must change password` set, so the first
thing they do after signing in is rotate the password to one they
chose.

```
┌────────────────────┐    1) Admin sets/generates       ┌─────────┐
│  bunny2 (admin)    │ ───────────────────────────────▶ │  User   │
│  Admin · Users     │    2) Shares it ONCE, securely   │ (first  │
│  → New user        │                                  │  login) │
└────────────────────┘                                  └────┬────┘
                                                             │ 3) Sign in
                                                             │ 4) Forced
                                                             │    password
                                                             ▼    rotation
                                                       ┌─────────┐
                                                       │ Logged  │
                                                       │ in user │
                                                       └─────────┘
```

---

## 3. Managing groups

A **group** is bunny2's only authorization unit. Users belong to
zero or more groups; future entities and features will scope access
by group membership.

### When to create a group

- You want a stable label for a team or role (`engineering`,
  `support`, `read-only`).
- You want to grant or revoke a permission for many people at once
  by adding or removing them from a single group.

### The `admin` group

The `admin` group is **seeded** on first run and cannot be deleted or
renamed. Anyone who is transitively in the `admin` group can:

- See the admin-navigation tabs in the UI.
- Reach every `/admin/*` endpoint.
- Create, edit, delete, and reset other users.
- Create, edit, and delete groups (the `admin` group itself is
  protected).

### Sub-groups (groups inside groups)

A group can hold other groups as members. Membership is **transitive**:
if Alice is in `backend`, and `backend` is in `engineering`, then
Alice is also (transitively) in `engineering`. You don't have to add
Alice twice.

```
admin ─────────────────────────────┐
   contains:                       │  Eve is admin
     - Eve  (user)                 │  (direct)
                                   │
engineering ─────────────────┐     │
   contains:                 │     │
     - backend  (group) ─┐   │     │
                         │   │     │
backend ─────────────────┘   │     │
   contains:                 │     │
     - Alice  (user)         │     │
                                   │
                       Alice is in │
                       backend AND │
                       engineering │  (transitive: backend → engineering)
```

Removing Alice from `backend` removes her from `engineering` too.
Adding `backend` to `admin` would make Alice an admin — be careful
when nesting.

Cycles are blocked. The UI surfaces this as **"This would create a
loop"** (`errors.admin.groupCycle`); the server rejects the insert
before the cycle can take hold.

### Creating, editing, deleting

Open **Admin · Groups** and use the table actions. Notes:

- The `admin` group's row has its **Delete** action disabled.
- Editing a group lets you change the **name** and **description**.
  The **slug** (the machine name) is permanent.
- Deleting a group is a **soft delete**: the row keeps existing in
  the database with a `deleted_at` timestamp, but the UI hides it
  from lists. Soft-deleted groups release their members from any
  derived privileges (transitive resolution skips deleted edges).

Open a group row to manage its direct members (users and sub-groups)
on a detail page.

---

## 4. Resetting a password

Two distinct flows:

| Flow            | Who initiates       | Requires current password? | Result                                                                                                                |
| --------------- | ------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| **Self change** | The user (any user) | Yes — proof of presence    | New password takes effect. Other sessions for this user are revoked.                                                  |
| **Admin reset** | An administrator    | No                         | New password set + `must change password` flag set + target's sessions revoked. The target must rotate on next login. |

### How to reset another user's password

1. Open **Admin · Users**.
2. Click **Reset password** on the user's row.
3. Either enter a new password yourself or leave the field blank and
   let bunny2 generate one.
4. Click **Reset**.
5. The generated password (or the one you typed) is shown once.
   Copy it, share it with the user through a trusted channel.

The next time the target user signs in, they will be on the **Change
password** screen and cannot reach any other screen until they rotate
again. This is the same flow as the initial admin login.

### Why is the generated password only shown once?

bunny2 stores **only the hashed password**, never the plaintext. Once
the dialog closes, the plaintext is gone. If the user loses the value
before they sign in, you can reset it again — there is no decrypt
path, by design.

### Admins cannot reset their own password through this surface

The **Reset password** action on your own row is disabled (the server
returns `errors.admin.cannotResetOwnPassword`). Use **User menu ·
Change password** instead — that flow requires you to enter your
current password, which is the safety check that keeps a compromised
session from silently re-granting access.

---

## 5. Soft-deleting users

When you click **Delete** on a user row:

1. The row is marked with a `deleted_at` timestamp; it disappears
   from the default user list and stops showing up in group rosters.
2. Every active session that user has is **revoked immediately**.
   The next request from any of their devices comes back as 401.
3. The user's history stays in the audit log (the `events` table).
   Their `user.created`, `user.password_changed`, every login they
   ever made, and the `user.deleted` row that retired them are all
   preserved.

In other words: soft delete hides the user from product surfaces but
**does not destroy history**. This is intentional — it lets an admin
prove "who did what when" even after a person leaves.

A future hard-delete path (admin-only, irreversible) is on the
roadmap but is not in v1.

---

## 6. What happens if I'm the only admin?

bunny2 will not let you accidentally lock yourself (and everyone
else) out of the admin surface.

The server enforces a **last-admin guard** on every operation that
could remove the last administrator:

- Trying to **delete** the only remaining admin user returns
  `errors.admin.lastAdmin` and the UI keeps the row.
- Trying to **remove yourself from the `admin` group** (via the
  edit-user dialog) when you are the only admin returns the same
  error.
- Trying to **delete the `admin` group itself** is blocked
  separately: the seeded `admin` group is permanent.

If you want to step down as admin (e.g. someone else should own the
role going forward):

1. Open **Admin · Users**.
2. Either create a new user and add them to the `admin` group, or
   edit an existing user and add the `admin` group to their
   memberships.
3. Sign in as that user once to verify their admin access works
   (the **Admin** tab is visible and `/admin/users` loads).
4. **Then** edit your own membership to remove yourself from the
   `admin` group, or delete your own account.

The guard runs an arithmetic check against the transitive admin
member set, so adding a second admin user is enough — you do not have
to wait between steps 2 and 4.

> **Note on the seeded admin.** The default `admin` user (the one
> whose password was printed on first launch) is **permanent** — the
> DELETE action returns 404 on it. The intent is to keep a known
> recovery identity around. If you have rotated its password and
> shared it with a trusted teammate, you can still effectively
> "transfer ownership" without deleting the row.

---

## 7. Related docs

- End-user first-login: [`getting-started.md`](./getting-started.md).
- Developer-side narrative + endpoint reference:
  [`docs/dev/architecture/auth-and-sessions.md`](../../dev/architecture/auth-and-sessions.md).
- Where the initial admin password is printed:
  [`docs/dev/setup/running.md`](../../dev/setup/running.md) §First-run
  admin password.
