# Follow-up — Group-layer edit authority (per-group admin role)

- Status: open
- Created: 2026-05-23 (phase 3.4)
- Phases referencing it: 3.4 (`canEditLayer` v1 fallback)

## What remains

The phase-3 plan §4.4 says a `group` layer is editable by "any admin
of the owning group OR site-admin". Phase 2's group model does NOT
have a per-group admin role — `user_group_memberships` is a single
membership bit, and the only "admin" notion the codebase has today is
transitive membership of the seeded `admin` group (which is global,
not per-group).

Phase 3.4 therefore ships a v1 fallback in
`apps/server/src/layers/authz.ts` that lets ONLY site-admins edit
group layers. This is documented in the file's JSDoc and asserted
explicitly in `apps/server/tests/layers-authz.test.ts`.

Concrete next pieces of work:

1. Decide the model. Two reasonable shapes:
   - Add a `role TEXT NOT NULL DEFAULT 'member'` column to
     `user_group_memberships` and `group_group_memberships`, with a
     constraint of `('admin','member')`. Migration is additive.
   - OR by convention: each top-level group `X` gets a child
     subgroup `X-admin`, and the rule becomes "user is in the
     `<group.slug>-admin` subgroup". No schema change; lifts the
     existing transitive-resolver logic.
2. Update `canEditLayer` to swap the v1 `false` branch for the real
   check. Mirror the `lastAdminGuard` arithmetic so we never have to
   walk the DAG twice per request.
3. Surface the choice in the admin group UI (3.5+).

## Why not done now

The phase-3 plan §C explicitly tells the 3.4 author to ship the
fallback and surface the gap as a follow-up. Picking a model that
holds up against phase 4+ entity ownership (where layer-membership
will mean "may write entities into this layer") is a real decision,
not a stub. The fallback keeps the system safe by default (only
site-admins can edit group layers) until the model is settled.

## Next step

Schedule against phase 3.5 (web UI for layer admin) or defer to
phase 4 when entity-write authority makes the design concrete.

## Related files / docs

- `apps/server/src/layers/authz.ts` — v1 fallback + JSDoc.
- `apps/server/tests/layers-authz.test.ts` — pinned negative test.
- `docs/dev/plans/done/phase-03-layers.md` §4.4 (the §4.4 authz table).
