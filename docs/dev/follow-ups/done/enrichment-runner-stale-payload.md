# Follow-up — Enrichment runner clobbers earlier job patches in the same tick (fixed)

## Resolution (2026-05-24)

The fix landed in commit
`fix(enrichment): refresh entity between jobs in one tick (4c bug #3)`.
`processEntry` now keeps a mutable `current` reference that is
re-read from the store after every successful `applyPatch`. The
calendar smoke step 14 was restored to the production job order
`[attendeeContactsJob, summaryJob]` and a dedicated regression test
(`apps/server/tests/entities/enrichment-runner.test.ts §multi-job
tick preserves earlier writes`) covers both the "different fields"
and "same field, last-write-wins" cases.

## What remained (historical)

`createEnrichmentRunner` in
`apps/server/src/entities/enrichment-runner.ts` loads the entity once
at the top of `processEntry(entry)` and reuses the in-memory
`entity.payload` reference across every job in the module's
`enrichmentJobs` array:

```ts
const entity = store.getById(entry.entityId); // loaded once
for (const job of jobs) {
  const result = await job.run(entity, ctx);
  if (hasPatch) {
    applied = await applyPatch(module, store, entity, result.patch);
    ...
  }
}
```

`applyPatch` builds the new payload as `{ ...entity.payload, ...filtered }`
and writes it. The next job in the same tick sees the SAME stale
`entity.payload` reference. The next `applyPatch` again does
`{ ...entity.payload, ...filtered }` — so any field the previous job
wrote that the current job's `filtered` does NOT touch gets reverted
to the pre-tick value.

Concretely: a calendar event whose two jobs are
`[calendar.attendeeContacts, calendar.summary]` ends up with
`meetingSummaryNote` set (the summary job's filtered key) but
`attendees` reverted to the pre-tick value (the summary job's
`{ ...entity.payload, ...filtered }` writes back the stale attendees,
overwriting the attendeeContacts job's mutation).

The 4c.6 smoke step 14 documents the bug by reordering the calendar
module's jobs to `[summary, attendeeContacts]` so the attendees write
is last and survives.

## Why not done now

The fix is local to `processEntry`: after every applyPatch, refresh
the in-memory entity from the store before the next job runs.
Something like:

```ts
let current = entity;
for (const job of jobs) {
  const result = await job.run(current, ctx);
  if (hasPatch) {
    applied = await applyPatch(module, store, current, result.patch);
    if (applied) {
      const refreshed = store.getById(entry.entityId);
      if (refreshed !== null) current = refreshed;
    }
  }
}
```

But 4c.6 is scoped to smoke + i18n + close-out. The runner change
touches every entity kind (companies has two jobs, contacts has one,
calendar has two, todos will add more) and needs:

1. A dedicated regression test in
   `apps/server/tests/entities/enrichment-runner.test.ts` for the
   two-job clobber scenario.
2. Re-running the 4a.3 / 4b.3 / 4c.3 job tests to confirm the new
   read-after-write doesn't break their fixtures.
3. A look at the per-job ledger (token counts, hasPatch) to make
   sure the re-load doesn't cause double-counting.

## Next step

1. Land the `current = refreshed` change in `processEntry`.
2. Add a regression test that registers two enrichment jobs touching
   overlapping fields and asserts both writes survive.
3. Remove the reorder workaround from
   `apps/server/tests/smoke.test.ts` step 14 (the calendar smoke
   uses `[summary, attendeeContacts]` deliberately to avoid the
   clobber).
4. Restore the production order
   `[attendeeContactsJob, summaryJob]` in
   `apps/server/src/entities/calendar/enrichment.ts` (the array is
   already in that order — the fix removes the smoke's workaround,
   not the production order).

## Related files or docs

- `apps/server/src/entities/enrichment-runner.ts` — the
  `processEntry` function.
- `apps/server/src/entities/calendar/enrichment.ts` — production
  calendar jobs.
- `apps/server/tests/smoke.test.ts` step 14 — documented workaround.

## Status

done
