# Risk — Translation drift between locales after edits

- Status: partially mitigated (event-driven only; scheduled
  re-translation gap open)
- Owner / area: entity translator
  (`apps/server/src/entities/translator.ts`); shared entity
  contract (`apps/server/src/entities/store.ts`,
  `entity_translations` table).
- Related: `docs/dev/plans/overall.md` §9 (risk row 6), §10
  decision 7 (per-record original-locale);
  ADR [`0011`](../decisions/0011-entity-contract.md) §"Per-locale
  translation lifecycle";
  open follow-ups
  [`scheduled-translation-runner.md`](../follow-ups/scheduled-translation-runner.md)
  and
  [`original-locale-edit-gate.md`](../follow-ups/original-locale-edit-gate.md).

---

## Description

Every entity carries a `meta.originalLocale`. The translator
subscribes to `entity.<kind>.created|updated|...` and, for every
non-original locale active on the entity's layer, writes a
full-payload translation into `entity_translations` keyed by
`(entity_id, locale)` with `source_version = entity.version`
(ADR 0011 §Per-locale translation lifecycle).

Re-translation is **source-version-driven**: if
`entity_translations.source_version < entity.version`, translate;
else skip. That makes the translator idempotent under bus replay
and cheap when nothing changed.

Three drift modes survive this design:

1. **No cadence, no catch-up.** The translator is purely
   event-driven — no scheduled runner exists. If a translation
   write fails (LLM outage, rate limit, bus DLQ), the entry
   stays at its old `source_version` until the next entity
   write to that id. An entity that never gets edited again
   stays drifted forever.
2. **Edits in a non-original locale.** Today nothing in the
   entity PATCH router gates which locale a user is editing in.
   A user can edit the Dutch translation, which then becomes
   newer than the English original; the next translator run
   sees `source_version >= entity.version` and skips, baking the
   drift in.
3. **New locale added to a layer.** Existing translations
   pre-dating the locale addition get translated on the next
   write to that entity, but if no write happens, they stay
   untranslated. Same shape as failure mode 1.

## Impact

Medium. UI is multilingual; a user reading the layer in a
non-original locale sees an outdated payload silently. No
authorization break, no data loss — but trust in the
multilingual surface degrades, and editorial workflows
(approvals, dashboards) consume the stale text.

## Likelihood

Medium. The current mitigations cover the happy path well; both
gaps are real (open follow-ups exist for both) but bind hardest
in layers with active editors and multiple locales.

## Mitigation

### Already in place

1. **Per-record `originalLocale`.** ADR 0011 / §10.7 fixes
   per-record over per-field. Single source of truth for the
   "real" payload that everything translates from.
2. **Source-version-driven re-translation.** Every translation
   carries the entity version it derives from; the translator
   compares before encoding. Replays are idempotent; nothing
   re-translates that's already current.
3. **Translator runs off the bus, idempotent.** Subscribes with
   `{ idempotent: true }`; durable-bus boot replay can re-run
   safely after a crash without producing duplicate
   translations.
4. **Translation lives in `entity_translations`, not in the
   entity row.** A failed or stale translation never overwrites
   the canonical payload. The original is always recoverable.
5. **Soft-delete cascades to translations.** When the entity is
   soft-deleted the translations are not surfaced to the UI;
   restore re-enables them at their then-current
   `source_version` (re-translation fires on next write or
   scheduled run).

### Deferred / follow-ups

1. **Scheduled re-translation runner.** Open follow-up
   [`scheduled-translation-runner.md`](../follow-ups/scheduled-translation-runner.md)
   to register an `entity.translations.run` scheduled-task kind
   that walks `entity_translations` for stale rows and enqueues
   missing translations on a cadence. Closes failure modes 1
   and 3. Owner area: `apps/server/src/entities/translator.ts` +
   the scheduled-task registry from phase 5.
2. **Original-locale edit gate.** Open follow-up
   [`original-locale-edit-gate.md`](../follow-ups/original-locale-edit-gate.md)
   to enforce "edit only original-locale unless explicitly
   re-declared" in the entity PATCH router, so a user editing
   in a non-original locale must either re-declare the entity's
   `originalLocale` or have their edit rejected. Closes failure
   mode 2.

## What would invalidate the mitigation

- Switching translation off the bus and onto an inline call in
  the entity write transaction (current architecture
  explicitly avoided this — see ADR 0013 / 0021 patterns; same
  reasoning applies here).
- Dropping `source_version` from `entity_translations` — every
  replay would re-translate, and drift detection collapses.
- A per-field translation feature (catalogued in ADR 0011 §3 as
  "deferred") landing without revisiting drift semantics; the
  current per-record contract is what makes
  source-version-driven re-translation tractable.
