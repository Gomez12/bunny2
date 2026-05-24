# ADR 0027 — Manual rollback as soft-deactivate + audit

- Status: accepted
- Date: 2026-05-25
- Phase: 8 (sub-phases 8.0, 8.5)
- Related: [`docs/dev/plans/phase-08-threshold-automation.md`](../plans/phase-08-threshold-automation.md)
  §1, §2, §4.5, §11;
  ADR [`0023`](./0023-improvement-proposal-contract.md) (proposal
  data model — the row that gains the rollback columns);
  ADR [`0026`](./0026-auto-activation-gating.md) (the auto-path
  whose blast radius rollback caps);
  Source code (lands in 8.5):
  `apps/server/src/http/routes/layer-proposals.ts`,
  `apps/server/src/proposals/repos/improvement-proposals-repo.ts`,
  `apps/server/src/proposals/capability-registry.ts`.

---

## Context

Phase 7.5 left rollback as "deactivate is the v1 control; full
rollback is a phase-8 deliverable since it relies on the threshold
automation's audit trail" (see
[`phase-07-self-learning.md`](../plans/done/phase-07-self-learning.md)
§2 out-of-scope). Phase 8's exit criterion in
[`overall.md` §8](../plans/overall.md#phase-8--self-learning-threshold-automated)
demands "easy rollback" because auto-activation removes the
human-in-the-loop check that previously gated every activation.

Three decisions need to be recorded before 8.5 (rollback HTTP +
UI) can ship deterministically:

1. **Does rollback restore a previous capability version, or just
   deactivate the current one?**
2. **Where does the audit live — a new table or on the proposal
   row?**
3. **Should rollback be tied to whether the proposal was
   auto-activated, or available for any `activated` proposal?**

---

## Decisions

### 1. Rollback = soft-deactivate; no previous-version restore

Phase 8 rollback calls the existing
`capabilityRegistry.deactivate({ id, deactivatedBy })` and stops
there. It does **not** look for a previous spec, does not re-run
the sandbox of an earlier version, and does not write a new
capability row.

**Why no previous-version restore**: `layer_capabilities` carries
exactly one row per `(layer_id, kind, name)` (UNIQUE constraint
from phase 7.2's migration `0015_proposals.sql`). There is no
historical version chain to restore _from_. Adding one is a
separate effort that would require its own ADR (capability
versioning) and its own migration; it is explicitly out-of-scope
for phase 8 (see plan §2).

The practical result of a phase-8 rollback: the per-layer registry
immediately stops returning the row, the answerer / tool registry /
agent subscriber stops consulting it on the next chat run, and
the layer behaves as if the proposal had been rejected at approval
time.

### 2. Rollback metadata lives on `improvement_proposals`, not a new audit table

The proposal row gains three columns (migration 0017):

```
rolled_back_at      TEXT
rolled_back_by      TEXT REFERENCES users(id)
rolled_back_reason  TEXT
```

These three columns plus the existing `activated_at`,
`auto_activated_*`, and the `layer_capabilities.deactivated_at` /
`deactivated_by` columns form the full audit trail: who activated
(human or system), when, with what evidence, and who rolled back
when and why.

**Why no separate audit table**: rollback is a terminal,
non-repeated act per proposal — a row in
`improvement_proposals` corresponds to exactly one activation
attempt and at most one rollback. There is no "history of
rollbacks" to capture; a single row's worth of columns is
sufficient. A separate audit table would add a join to every
list-and-detail query for no behavioral payoff.

The capability registry's `deactivated_at` already records the
soft-deactivation timestamp from the registry's perspective; the
proposal row's `rolled_back_*` columns record it from the
proposal's perspective. The two views agree because the rollback
HTTP route writes both in the same transaction.

### 3. Rollback is available for any `activated` proposal

The rollback endpoint accepts any proposal with `status =
'activated'`, regardless of whether `approved_by` (human) or
`auto_activated_by = 'system'` is set.

**Why universal**: an admin discovering a degraded chat answer
should not need to remember whether the offending capability came
in through the human path or the auto path. The mental model is
"this capability is causing problems — remove it"; the activation
origin is a separate audit signal, not a rollback gate.

The rollback HTTP endpoint enforces two preconditions:

- `proposal.status === 'activated'` (409 otherwise; rejecting a
  rejected / superseded / new / already-rolled-back proposal is
  pointless).
- The linked capability (origin `proposal:<id>`) is still active in
  the registry (409 with `errorAlreadyDeactivated` otherwise —
  defensively handles "admin deactivated the capability directly
  via the phase-7.5 admin action").

Reason text is required (`>= 5 chars`) at the route boundary so
the audit row is always meaningful. The reason is **not** logged
to telemetry or analytics — free-form text is high-cardinality
and may contain sensitive information about why the capability
misbehaved.

### 4. No auto-rollback watcher in phase 8

A scheduled job that observes post-activation thumbs ratio and
auto-deactivates capabilities below a per-layer floor was
considered and deferred. The audit columns + bus events shipped
here (`proposal.rolled-back`,
`layer_capabilities.deactivated_at`, the proposal row's
`rolled_back_*`) are the data foundation an auto-rollback watcher
would consume; the watcher itself is filed as the follow-up
`proposals-auto-rollback-watcher.md` for phase 9.

**Why deferred**: an auto-rollback watcher needs a tuned floor
(thumbs ratio across what window?), a confidence model (don't
rollback on a single thumbs-down), and per-artifact-kind logic
(deactivating an `agent` mid-flight may emit a final flurry of
events). Phase 8's exit criterion is "runs safely for a week";
shipping manual rollback first means humans observe outcomes
during dogfood and the watcher can be designed against real data
in phase 9 rather than guessed at.

---

## Consequences

- The proposal row becomes the single document-of-record for one
  proposal's full lifecycle: mint → sandbox → activate →
  (optionally) rollback. Phase 8 close-out updates the data model
  diagram in `architecture/self-learning.md` accordingly.
- The `proposal.rolled-back` bus event is consumed by no one in
  phase 8 (the registry already deactivates synchronously). It
  exists for the phase-9 watcher and for any future external
  consumer (e.g. a Slack notifier).
- Rollback is **not** undoable. A rolled-back proposal stays
  terminal; reactivating it would require re-running the review
  agent so the cluster grouper produces a fresh proposal. This is
  intentional — undoable rollback would re-introduce the "what's
  the current state of this capability?" ambiguity that phase 7's
  soft-deactivate model deliberately eliminated.
- Telemetry dimension `artifact_kind` on
  `proposal.rolled-back_count` is the only label; the proposal id
  and the reason text are _not_ dimensioned.

---

## Alternatives considered

1. **Hard-delete the capability + the proposal.** Rejected:
   violates `overall.md` §5 invariant 5 (soft-delete only; admin-
   only hard delete). Forfeits the audit trail that justifies
   phase 8's risk profile.
2. **Restore a previous version of the capability.** Rejected: no
   version chain exists (decision 1). Building one is a separate
   ADR and migration.
3. **Audit table `improvement_proposal_rollbacks`.** Rejected:
   one rollback per proposal makes a separate table strictly more
   complex without adding capability (decision 2). A future
   version chain _would_ warrant its own table, but that is a
   different feature.
4. **Only auto-activated proposals are rollbackable.** Rejected:
   complicates the admin mental model for no safety gain (decision
   3). A bad capability is a bad capability regardless of how it
   was approved.
5. **Ship an auto-rollback watcher in phase 8.** Rejected:
   "runs safely for a week with zero rollbacks needed" is easier
   to verify with manual rollback first; the watcher needs data
   to tune (decision 4). Filed as a phase-9 follow-up.
