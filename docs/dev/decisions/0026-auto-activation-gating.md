# ADR 0026 — Auto-activation gating contract

- Status: proposed
- Date: 2026-05-24
- Phase: 8 (sub-phases 8.0, 8.2, 8.3)
- Related: [`docs/dev/plans/phase-08-threshold-automation.md`](../plans/phase-08-threshold-automation.md)
  §1, §2, §4.2, §4.3, §11;
  ADR [`0023`](./0023-improvement-proposal-contract.md) (the
  `threshold` field this ADR finally consumes);
  ADR [`0024`](./0024-sandbox-runner.md) (the sandbox metrics
  this ADR layers quality bars on top of);
  ADR [`0025`](./0025-replan-on-approval.md) (the activation path
  this ADR re-uses unchanged);
  Source code (lands in 8.2 / 8.3):
  `apps/server/src/proposals/auto-activate.ts`,
  `apps/server/src/proposals/scheduled/auto-activate-handler.ts`.

---

## Context

Phase 7 minted `improvement_proposals.threshold` (a 0..1 number the
review-agent LLM emits per proposal) but never consumed it: every
activation needed an explicit admin click. Phase 8's job is to
turn the field into an activation signal, _safely_, and to do it
without re-shaping the activation path or weakening the phase-7
invariants ADRs 0023 / 0024 / 0025 set up.

Three decisions need to be recorded before 8.2 (gate function) and
8.3 (scheduled-task wiring) can ship deterministically:

1. **What gates an auto-activation?** A single LLM-self-rating
   threshold is too narrow — the sandbox produced objective
   evidence in phase 7.4; that evidence should be a peer signal,
   not an afterthought.
2. **How does the auto-path enter the activation machinery?**
   Either a new primitive, or it re-uses `replanOnApproval`.
3. **How is the system-actor represented in the row?** The
   `approved_by` column is a `REFERENCES users(id)` FK; we cannot
   write a literal `'system'` there without seeding a fake user
   row.

---

## Decisions

### 1. Seven deterministic gates, evaluated in cheapest-first order

Auto-activation requires **all seven** of these to pass:

```
1. auto-activation-disabled    settings.autoActivationEnabled === true
2. cooldown-not-elapsed         now - proposal.minted_at >= settings.cooldownHours
3. threshold-below-cutoff       proposal.threshold >= settings.thresholdCutoff
4. no-sandbox-evidence          a `variant='proposed'` artifact row exists
5. sandbox-outcome-not-ok       artifact.metrics.sandboxOutcome === 'ok'
6. thumbs-up-delta-non-positive !settings.requireThumbsUpDeltaPositive
                                || artifact.metrics.thumbsUpDelta > 0
7. tokens-delta-over-cap        settings.maxTokensDelta == null
                                || artifact.metrics.tokensDelta <= settings.maxTokensDelta
```

The gate function is **pure** (no clock, no I/O; `now` is
injected) and **short-circuiting** (first failing gate names the
rejection reason; remaining gates are not evaluated). Cheapest-
first ordering matters because the hourly job will iterate every
`new` proposal in every enabled layer; gates 1–2 reject without
ever loading the artifact row.

**Why seven gates and not just `threshold >= cutoff`**: the
threshold is an LLM self-rating, and the closed-enum handler-kind
model of ADR 0024 does not constrain _how good_ a proposal is —
only that it is shaped legally. The sandbox already produced
ground-truth metrics; treating those as peer gates is the cheapest
way to harden the auto-path against a confidently-wrong LLM.

Each gate emits a `GateRecord { name, passed, detail }` so the
decision JSON written to `auto_activation_decision_json` reveals
the entire evaluation in order — both to the layer admin (UI
collapse) and to telemetry (closed-enum `rejectionReason`
dimension).

### 2. The auto-path calls `replanOnApproval` — no new primitive

The auto-activate handler does **not** call
`capabilityRegistry.activate(...)` directly. It calls
`replanOnApproval(proposalId, SYSTEM_ACTOR, { ...deps, actorKind:
'system' })` — the same function the human approve route uses.

**Why**: ADR 0025 fixes the snapshot-diff semantic and the four
outcome labels (`activated-asis`, `activated-replanned`,
`superseded`, `superseded-after-replan`). If the auto-path bypassed
re-plan, it would re-introduce the staleness ADR 0025 was
designed to prevent: a capability snapshot can drift between mint
and auto-activation just as readily as between mint and human
approval. The cooldown window in fact _encourages_ drift — a
24-hour wait is plenty of time for another proposal to activate a
capability that supersedes the one being gated.

Practical consequences:

- The auto-path can therefore land any of the four outcome labels.
  `superseded` / `superseded-after-replan` are recorded but no
  capability is activated; the proposal moves to its terminal
  state with full audit columns set.
- The auto-path inherits ADR 0025's "at most one re-plan per
  approval" cost ceiling.
- Phase 8 ships zero new code in the activation primitive.

### 3. `SYSTEM_ACTOR` is a literal; user FKs stay clean

The proposal-approve repo API gains a discriminator:

```ts
approve(id: string, opts:
  | { actorKind: 'user'; approvedBy: string /* users.id */ }
  | { actorKind: 'system' })
```

- `'user'` writes `approved_by = users.id` and `approved_at` (phase
  7 path; unchanged).
- `'system'` leaves `approved_by` NULL, writes
  `auto_activated_by = 'system'` (literal string, not a FK) and
  `auto_activated_at` instead.

The new audit columns (`auto_activated_*`,
`auto_activation_decision_json`) carry the system audit; the
`users(id)` FK constraints on `approved_by` and `rolled_back_by`
stay valid because no fake "system" user is ever inserted.

**Why no system user row**: introducing a special `users` row
would (a) require auth bypass tests across every middleware that
asserts non-system identity, (b) leak into UI lists ("active
users"), and (c) be load-bearing for a single literal string. The
discriminator union is the lower-blast-radius choice and is
trivially type-checked.

### 4. Decision JSON is written _before_ `replanOnApproval` is called

If `replanOnApproval` throws (LLM call fails during re-plan, DB
hiccup), the proposal still carries the decision JSON that _would
have_ been auto-activated. This gives admins a forensic trail even
when the auto-path failed mid-flight, and prevents silent skips.

The follow-up call `proposalsRepo.recordAutoActivation(...)` (sets
`auto_activated_by = 'system'`, `auto_activated_at`) runs **after**
the four-outcome verdict, so the proposal row only carries those
two columns when the system actually made the call.

---

## Consequences

- Phase 8's auto-path is additive: phase-7 callsites of
  `proposalsRepo.approve(...)` keep working with
  `actorKind: 'user'` as the default discriminator. A one-line
  type-check test pins the union.
- The seven gates become a public contract surface: changes to
  the gate set in future phases need an ADR amendment because
  layer admins depend on the gate semantics for safety.
- Telemetry dimension `rejectionReason` is a closed enum (seven
  string literals); cardinality stays bounded.
- The "auto-path activates the same `ProposalSpec` the sandbox
  validated" invariant means ADR 0024's closed-enum handler-kind
  model continues to gate code-execution: the auto-path cannot
  smuggle in a new handler kind because the sandbox would have
  rejected it at proposal-mint time.

---

## Alternatives considered

1. **Single gate: `proposal.threshold >= layer.cutoff`.** Rejected:
   the threshold is an LLM self-rating; the sandbox metrics are
   ground truth. Trusting only the model's self-rating defeats the
   purpose of having run the sandbox in phase 7.4.
2. **Auto-path bypasses `replanOnApproval` (calls `activate`
   directly).** Rejected: re-introduces the drift problem ADR 0025
   was designed to prevent. The cooldown window makes drift more
   likely, not less.
3. **Seed a `system` user row at install time.** Rejected: see
   decision 3 — large blast radius for a single literal. The
   discriminator union is simpler and more honest about the
   non-human origin.
4. **Per-gate configurability (every gate has its own knob).**
   Rejected for v1: five settings already give admins enough
   surface area to misconfigure. Gates 1, 5, and "proposed
   artifact exists" are unconditional safety rails; only the four
   tunable ones (enabled, cutoff, cooldown, thumbs-up-delta,
   tokens cap) sit in the settings table.
5. **Activate inline immediately after sandbox (no scheduled
   task).** Rejected per the planning discussion: removes the
   cooldown window admins need to intercept. The 1-hour job
   interval + admin-configurable cooldown beats inline activation
   for the "runs safely for a week" exit criterion.
