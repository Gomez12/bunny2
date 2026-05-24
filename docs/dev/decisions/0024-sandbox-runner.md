# ADR 0024 — Sandbox runner

- Status: accepted
- Accepted on: 2026-05-24
- Date: 2026-05-24
- Phase: 7 (sub-phases 7.0, 7.4)
- Related: `docs/dev/plans/phase-07-self-learning.md` §1, §4.4,
  §10, §11;
  ADR [`0020`](./0020-chat-pipeline.md) (the pipeline the
  sandbox replays);
  ADR [`0023`](./0023-improvement-proposal-contract.md) (the
  closed-enum handler-kind model the sandbox depends on);
  ADR [`0025`](./0025-replan-on-approval.md) (the activation
  semantic that consumes sandbox output);
  Source code (lands in 7.4):
  `apps/server/src/proposals/sandbox/`.

---

## Context

Phase 7's review loop hinges on a question the user must answer:
"is this proposed change going to help?". Without **evidence**
the approve / reject decision is a coin flip. The evidence is a
replay of the supporting messages against (a) the pipeline
as-is and (b) the pipeline with the proposed artifact registered.

Three decisions need to be recorded before any sandbox code
lands:

1. **What "registered" means in a sandbox context.** A real
   capability activation persists a row to `layer_capabilities`
   and re-attaches subscribers. The sandbox cannot do either —
   then a sandbox run would be indistinguishable from
   activation.
2. **Isolation model.** In-process? Worker thread? Child
   process? Container? The decision is load-bearing: it
   determines the security surface, the test surface, and the
   cost surface.
3. **Determinism + termination.** A non-deterministic or
   non-terminating sandbox produces evidence the admin can't
   trust.

---

## Decisions

### 1. In-memory capability overlay

The sandbox runner builds an `InMemoryCapabilityOverlay` — a
read-through `Map<(kind, name), spec>` that the per-layer
capability registry consults **first**. The overlay is scoped
to the runner instance; nothing outside the runner sees it.
The sandbox replays messages through the actual pipeline
code, which reads from the registry-with-overlay; chat traffic
in flight and other scheduled tasks read from the
registry-without-overlay and are unaffected.

**Why**: makes the sandbox a pure function of (proposal,
evidence, current capability state). No double-write risk.
`improvement_proposal_artifacts` rows are the only persistent
output.

### 2. In-process isolation

The sandbox runner does **not** spawn child processes, worker
threads, or containers. It runs in the same process as the
worker role (the `chat.review-layer` scheduled task — and later
admin-triggered replays via the route — both execute on the
worker role per the phase-5 role split).

**Why**: ADR 0023's closed-enum handler-kind model forecloses on
arbitrary-code-injection as a class. There is no executable
content in a `ProposalSpec`; everything is a JSON spec
interpreted by a small set of statically-typed handler kinds.
With no untrusted code path, the cost of a heavier sandbox
(process / container) is not earned. If a later phase opens the
handler-kind set (e.g. accepting user-uploaded JS), this ADR
should be revisited and superseded by a process-or-container
sandbox ADR before the kind ships.

### 3. Hard 10-second timeout per replay; max 5 evidence messages

Each replayed message has a hard 10-second timeout. On timeout
the sandbox aborts with `metrics.sandboxOutcome = 'timeout'` and
no partial state leaks. Each proposal carries at most 5
evidence messages (the cluster grouper picks the strongest 5).
Total sandbox time per proposal is bounded at ~50 s × 2
variants = 100 s wall-clock.

**Why**: bounds LLM cost in production deployments (the sandbox
uses the real LLM); bounds CPU/IO in worker contention; bounds
the surface for a misbehaving spec to delay the review queue.
The cap of 5 messages is chosen to keep the LLM cluster-mint
prompt bounded as well.

### 4. Deterministic replay inputs

The sandbox replays the **exact** persisted user message + the
exact persisted history slice (capped at last 20 turns per ADR
0020). It does not regenerate any pipeline step's input from
"fresh data" — the message metadata at the time of the failure
is the input.

**Why**: lets the admin trust that the `current` transcript
matches what the user actually got, and that the `proposed`
transcript is what they would have got under the same
conditions. Non-determinism in the LLM step is unavoidable but
the comparison stays apples-to-apples because both variants run
under the same LLM config.

### 5. No artifact code ever persisted by the sandbox

The sandbox writes one `improvement_proposal_artifacts` row per
variant containing the transcript JSON + the metrics JSON.
**It never writes anywhere else.** It does not insert into
`layer_capabilities`. It does not insert into the durable bus.
Activation is a separate step (ADR 0025) and is the only path
that creates a `layer_capabilities` row.

---

## Consequences

- Sandbox cost is real LLM cost. The 10-second × 5-message ×
  2-variant cap keeps it predictable. Telemetry
  `proposal.sandbox.duration_ms` + `llm_calls.cost` make it
  observable.
- The closed-enum handler-kind model from ADR 0023 is a
  hard dependency. Loosening it requires re-opening this ADR.
- Sandbox failures (timeout, parse error, unknown handler kind)
  surface as `metrics.sandboxOutcome` values on the artifact row.
  The detail page renders them inline so an admin sees "this
  proposal could not be evaluated" rather than a blank
  comparison.
- Approval can re-run the sandbox (re-plan path, ADR 0025) — the
  second sandbox run writes a `variant='replanned'` artifact row,
  keeping the audit trail complete.

---

## Alternatives considered

1. **Run the sandbox in a worker thread.** Rejected for v1: no
   security benefit given the closed-enum model; adds an IPC
   surface and a serialization cost; complicates the
   capability-overlay sharing.
2. **Spawn an isolated child process per replay.** Rejected for
   v1: spin-up cost dominates the actual work (the LLM call is
   the slow path); no security benefit until the closed-enum is
   relaxed.
3. **Skip the sandbox; let the admin read the proposal spec and
   judge.** Rejected: empirical evidence is the entire point of
   the gate. Without it the gate is theatrical.
4. **Run the sandbox at approval time only, not at mint time.**
   Rejected: the admin needs to see the comparison **before**
   approving; approval-time-only sandbox forces the UI into a
   "submit-then-show-evidence" shape that's hostile to
   reject decisions.
5. **No timeout; rely on the LLM step's own timeout.** Rejected:
   pipeline-level timeouts already exist (60 s per
   answerer call per ADR 0020) but the sandbox-level cap is
   tighter to keep total per-proposal wall-clock bounded.
