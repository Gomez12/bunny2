# ADR 0025 — Re-plan on approval

- Status: proposed
- Date: 2026-05-24
- Phase: 7 (sub-phases 7.0, 7.4)
- Related: `docs/dev/plans/phase-07-self-learning.md` §1, §4.4,
  §11;
  ADR [`0023`](./0023-improvement-proposal-contract.md) (the
  capability snapshot stored at mint time);
  ADR [`0024`](./0024-sandbox-runner.md) (the sandbox the
  re-plan path re-uses for the regenerated spec);
  Source code (lands in 7.4):
  `apps/server/src/proposals/replan.ts`.

---

## Context

[`overall.md` §5 invariant 9](../plans/overall.md#5-architectural-principles-invariants-every-phase-must-keep)
reads:

> Improvement proposals carry: detected problem, proposed fix,
> expected impact, sandbox test evidence. Approval triggers a
> **re-plan** (capabilities may have changed since proposal)
> before activation.

A proposal can sit in `new` for hours, days, weeks. Between mint
and approval, other proposals may have activated capabilities
that already address the gap; a deactivation may have widened
the gap; nothing may have changed. Activation cannot blindly
trust the mint-time spec.

Three decisions need to be recorded so phase 7.4 can ship
deterministically:

1. **When does re-plan regenerate the spec vs. activate as-is vs.
   supersede?** The branch logic shapes the user-visible outcome
   labels.
2. **How is the "covers the gap" decision made?** Without a
   precise definition, the re-plan path is non-deterministic.
3. **What's the maximum re-plan depth?** A re-plan that
   re-mints and re-sandboxes recursively could oscillate.

---

## Decisions

### 1. Three branches, four outcomes

```
diff(mintedSnapshot, currentSnapshot)
  │
  ├─ empty diff               → activate-asis             (status=activated)
  │
  ├─ drift, gap covered       → supersede                 (status=superseded)
  │
  └─ drift, gap persists      → regenerate spec via LLM
                                  │
                                  ├─ regenerated spec helps  → activate-replanned   (status=activated)
                                  │
                                  └─ regenerated spec doesn't → supersede-after-replan (status=superseded)
```

Each outcome publishes a bus event (`proposal.activated`,
`proposal.superseded`) and writes a corresponding bus payload
field `outcome`. The UI labels them with the four i18n keys
from `proposals.detail.activationOutcome*` /
`supersededOutcome` / `supersededAfterReplanOutcome`.

### 2. "Covers the gap" is a deterministic tag intersection

The cluster grouper at mint time tags every proposal with a
`failureModeTags: string[]` field (e.g.
`['zero-hit-retrieval', 'thumbs-down']`). Every capability spec
carries an `addressesTags: string[]` field. The diff "covers
the gap" iff:

```
proposalTags = Set(proposal.failureModeTags)
addedTags    = ⋃ cap.addressesTags  for cap in (currentSnapshot \ mintedSnapshot)
coversGap    = proposalTags.isSubsetOf(addedTags)
```

This is **pure code** — no LLM call. Predictable, testable, and
non-tunable in v1. Phase 8 may revisit this for confidence-
weighted decisions but does not need to.

### 3. At most one re-plan per approval

The drift-with-gap path makes exactly one LLM call to regenerate
the spec, then exactly one sandbox replay (ADR 0024 caps it at
~100 s wall-clock), then activates or supersedes terminally.
There is no re-re-plan. If the regenerated spec doesn't help,
the proposal is `superseded-after-replan` and the admin is
expected to use the review-agent's next run to surface a fresh
proposal.

**Why**: prevents oscillation; bounds LLM cost per approval;
keeps the UI's "Approve" affordance a single user action with
a deterministic worst-case latency (~120 s including the LLM
re-plan call).

### 4. Re-plan LLM prompt is constrained the same way mint is

The re-plan prompt receives:

- The original `failureModeTags`.
- The current capability snapshot.
- The original `problem_summary` (the human-readable cluster
  description).
- The original `proposedSpec` (as the LLM's prior attempt).

It must emit a new `ProposalSpec` with the same closed-enum
constraints (ADR 0023 decision 2). zod validation rejects an
out-of-enum response; on parse failure the path falls through to
`status=superseded` rather than retrying.

### 5. The activation step is the same regardless of branch

`activate(spec, layerId, origin)` inserts the
`layer_capabilities` row, publishes `proposal.activated`, and
re-attaches subscribers (for `agent` kind). Whether the spec is
the original or the re-planned one, the activation path is
identical — so the registry never has a "was this re-planned?"
branch.

---

## Consequences

- The four outcomes drive four UI states and four bus events.
  Phase 7.6 wires the strings; phase 8 will use the bus events
  for threshold-gated auto-approval audit trails.
- `failureModeTags` and `addressesTags` become contract fields
  on the proposal spec and the capability spec respectively.
  Both are populated by the LLM at mint time / proposal-spec
  authoring time and constrained by the same closed-enum set
  (a small fixed vocabulary; phase 7.2's zod schemas pin the
  list).
- The "supersede" path keeps the proposal queue clean: a
  capability already addresses the gap, so no new artifact is
  needed. The admin sees the supersession outcome with a link
  to the addressing capability.
- The "at most one re-plan" rule means an admin who really
  wants to keep iterating must let the next review-agent run
  mint a fresh proposal. Reduces user surprise vs. an unbounded
  loop.

---

## Alternatives considered

1. **No re-plan; activate the mint-time spec verbatim.**
   Rejected: violates `overall.md` §5 invariant 9 explicitly.
   The vision document chose the re-plan gate for good reason
   — capabilities really do drift between mint and approval.
2. **Always re-plan, never activate as-is.** Rejected: the
   empty-diff case is common (most approvals happen within a
   day of mint), and re-planning then doubles LLM cost for no
   functional gain.
3. **LLM-based "covers the gap" decision.** Rejected for v1: a
   non-deterministic gate is hard to test and hard to explain.
   The `tag-subset` rule is mechanical and the LLM-mint step
   has the closed enum it needs.
4. **Unbounded re-plan loop until success.** Rejected: cost
   blow-up + oscillation risk. The bounded-one-replan rule
   gives the admin a clear "let it cool, try again next run"
   path.
5. **Re-plan at mint time instead of approval time.** Rejected:
   re-planning before there's a problem to solve is wasted
   work; the whole point is to react to drift that happened
   **after** the proposal was minted.
