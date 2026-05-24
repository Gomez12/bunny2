# Follow-up — contacts enrichment i18n keys missing from locale files

- Status: open
- Created: 2026-05-24 (phase 4c.3 close-out)
- Phases referencing it: 4b.3 (contacts enrichment), 4c.3 (calendar
  enrichment — discovered the drift while landing calendar enrichment)

## What remains

The 4b.3 close-out
(`docs/dev/plans/phase-04-first-entities.md` §14 "4b.3 shipped") claims
the i18n keys

```
entity.enrichment.contacts.suggestCompany.running
entity.enrichment.contacts.suggestCompany.appliedCompany
entity.enrichment.contacts.suggestCompany.noMatch
```

shipped in both `apps/web/src/i18n/locales/en.json` and `nl.json` with
real Dutch translations. They do NOT exist in either file as of
2026-05-24. A direct read of both locale files at the time 4c.3 landed
showed zero `entity.enrichment.contacts.*` keys.

The 4b.6 i18n sweep close-out (same plan, "4b.6 shipped") then removed
similar `entity.enrichment.contacts.suggestCompany.{running,
appliedCompany, noMatch}` keys as "orphan UI label keys for a future
enrichment UI that does not exist yet" — which suggests the keys were
either added in 4b.3 and removed wholesale in 4b.6, or they were never
added in the first place and the 4b.3 close-out misreported. Either way,
the keys are absent now.

## Why not done now

The 4c.3 commit was scoped strictly to calendar enrichment and the
generalisation of the `enrichmentOverwriteFields` slot. Patching the
contacts i18n keys is a separate concern that does not belong in the
calendar commit:

- 4c.3's `bun run i18n:check` ends green WITHOUT these keys; nothing in
  the active codebase reads them.
- Re-adding them touches the same files the 4b.6 sweep cleaned and
  deserves its own focused commit + decision on which surface will
  actually render them.

## Next step

Re-add the three keys to both locales (real Dutch translations) when a
UI surface that consumes them lands — most likely 4b.4's
`ContactsWidget` enrichment-status badge or a future
`contacts.suggestCompany` audit log entry. If no consumer materialises
by the time the 4d block lands, drop the keys from the 4b.3 close-out
text to keep the documentation honest.

## Related files / docs

- `apps/web/src/i18n/locales/en.json`
- `apps/web/src/i18n/locales/nl.json`
- `docs/dev/plans/phase-04-first-entities.md` §14 "4b.3 shipped"
- `docs/dev/plans/phase-04-first-entities.md` §14 "4b.6 shipped" (the
  sweep that removed the keys as orphans)
