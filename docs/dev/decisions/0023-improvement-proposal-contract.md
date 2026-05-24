# ADR 0023 — Improvement proposal contract

- Status: accepted
- Accepted on: 2026-05-24
- Date: 2026-05-24
- Phase: 7 (sub-phases 7.0 through 7.7)
- Related: `docs/dev/plans/phase-07-self-learning.md` §1, §4.2,
  §4.3, §11;
  ADR [`0020`](./0020-chat-pipeline.md) (the chat pipeline this
  loop reviews);
  ADR [`0024`](./0024-sandbox-runner.md) (the sandbox boundary
  that evidence comes from);
  ADR [`0025`](./0025-replan-on-approval.md) (the re-plan
  semantic that consumes the `capability_snapshot_json` field
  fixed here);
  Source code (lands in 7.2 / 7.3 / 7.5):
  `apps/server/src/storage/migrations/0015_proposals.sql`,
  `apps/server/src/proposals/`,
  `packages/shared/src/proposals.ts`.

---

## Context

Phase 6 left the per-layer chat with rich telemetry
(`chat_messages` + `chat_message_feedback` +
`chat_pipeline_steps` + `llm_calls`) and a placeholder handler
`chat.review-layer` that just logs a line. Phase 7 turns that
telemetry into a review loop with a human gate
([`overall.md` §5 invariant 9](../plans/overall.md#5-architectural-principles-invariants-every-phase-must-keep)).

Before any code lands, four decisions need to be recorded so the
sub-phases (7.1–7.7) cannot drift:

1. **What a proposal is** — the data shape, the artifact kinds it
   can carry, the lifecycle states it moves through, and the
   contract it has with the chat pipeline and the per-layer
   capability registry.
2. **Where the `threshold` field lives** — phase 7 ignores it for
   activation, phase 8 reads it; both must agree on the field
   without a schema change between them.
3. **Capability snapshot at mint time** — the snapshot is the
   baseline the re-plan path (ADR 0025) diffs against; its
   shape is the load-bearing piece that lets re-plan be
   deterministic.
4. **Artifact-kind closed enum** — what kinds of improvement
   the proposal LLM is allowed to emit, and why we deliberately
   keep the set small in v1.

---

## Decisions

### 1. Four tables; one source of truth per concept

- `improvement_proposals` — one row per minted proposal; status
  field drives the UI; `proposed_spec_json` is the artifact spec
  (no code); `capability_snapshot_json` is the snapshot at mint
  time; `threshold` is recorded but never read in phase 7.
- `improvement_proposal_evidence` — N rows per proposal, each
  linking to the `chat_messages.id` that supports the cluster
  reason. No copying of message content into the proposal — the
  link is the canonical reference.
- `improvement_proposal_artifacts` — N rows per proposal
  (variant ∈ `current | proposed | replanned`), each a sandbox
  transcript + delta metrics. Lets the UI render the
  side-by-side comparison without re-running the sandbox.
- `layer_capabilities` — the per-layer registry of activated
  tools / skills / agents (the phase-3 §invariant-4 attachment
  point, finally filled). `origin` is `builtin` or
  `proposal:<uuid>`; UNIQUE `(layer_id, kind, name)`.

Phase 7.2 ships migration `0015_proposals.sql` with this exact
shape.

### 2. Three artifact kinds; closed enum

`artifact_kind` ∈ `tool | skill | agent`. Adding a kind is an
explicit code change in a future sub-phase. Within each kind,
the spec's `handler.kind` is also a closed enum (e.g.
`'searchSummaries-aliased' | 'projection-lookup'` for tools).
The proposal LLM is constrained by the prompt to emit only
specs whose handler kind exists in the registered enum; zod
validation at mint time enforces it; the registry refuses to
register an unknown kind defensively at activation time.

**Why closed-enum**: no arbitrary code is ever stored or
executed. ADR 0024 leans on this fact to keep the sandbox
boundary defensible.

### 3. `threshold` is mandatory; phase 7 ignores it

Every proposal carries a `REAL` threshold ∈ `[0, 1]`. The
review-agent LLM is instructed to set it from the cluster's
strength (frequency × thumbs-down rate × token cost). Phase 7's
activation path **does not** read it; activation requires
explicit approval regardless of threshold. Phase 8 will gate
no-approval activation on `threshold ≥ layerThreshold`. Pinning
the field now means phase 8 ships without a schema migration.

### 4. Capability snapshot is JSON-serialized at mint

`capability_snapshot_json` is the result of
`JSON.stringify(layerCapabilities.list(layerId, { activeOnly: true }))`
plus the built-in capability list (constant array). Stored
verbatim. ADR 0025 fixes the diff algorithm used at re-plan
time; this ADR fixes only the **storage** decision: the snapshot
travels with the proposal so re-plan is a pure function of
(proposal, current snapshot) — never of "what was active when
the user clicked Approve, last Tuesday".

### 5. Lifecycle is a state machine; transitions are persisted

`new → approved → activated`
`new → rejected (terminal)`
`new → superseded (terminal)`
`approved → superseded` (capability re-plan finds the gap
already covered)
`activated → deactivated` (admin action; capability registry
flips immediately)

Every transition writes a bus event (`proposal.minted`,
`proposal.approved`, `proposal.rejected`, `proposal.activated`,
`proposal.superseded`, `proposal.deactivated`) so the durable
audit trail is complete. Phase 8 will subscribe to
`proposal.minted` for threshold-gated auto-approval.

---

## Consequences

- A new schema namespace lands in phase 7.2 and is consumed by
  7.3 (mint), 7.4 (sandbox + replan), 7.5 (capability registry),
  7.6 (UI). No follow-up sub-phase can reshape the tables
  without invalidating earlier code.
- The closed-enum decision constrains what the review-agent LLM
  is allowed to propose. The first iteration's catalogue is
  small (~4 handler kinds across tool / agent; `skill` is
  prompt-fragment-only). Adding a kind in a later phase is a
  multi-file change (zod schema + registry + tests + migration
  if a new column is needed).
- Recording `capability_snapshot_json` at mint time means a
  layer admin's "Approve" click months after a proposal was
  minted still has a coherent diff to consult. Trade-off: the
  snapshot can drift far from current, which is why
  `proposals.replan-stale` exists (re-fills evidence for stale
  `new` proposals before a user sees them).
- The `threshold` field is wired through the UI in phase 7
  with a `(used by phase 8 automation)` label. Phase 8 ships
  the gating without a migration.

---

## Alternatives considered

1. **A single proposals table with a TEXT enum column for the
   artifact spec, no separate evidence or artifact tables.**
   Rejected: the UI's side-by-side sandbox comparison needs
   the artifact rows as first-class records, and the evidence
   link from proposal to message wants the join table for
   query efficiency.
2. **Store raw spec code (e.g. a serialized JS function).**
   Rejected unambiguously: opens RCE. The closed-enum
   handler-kind model is the load-bearing security choice and
   pre-dates the rest of phase 7's design.
3. **Recompute the capability snapshot at approval time.**
   Rejected: makes re-plan non-deterministic (it would depend
   on system clock + other concurrent activations). Storing the
   snapshot at mint keeps re-plan pure.
4. **Skip the `threshold` field in phase 7 and add it in phase 8.** Rejected: forces a schema migration between two
   self-learning phases, and leaves phase-7 telemetry without
   the threshold distribution data phase 8 needs to pick its
   default cutoff.
