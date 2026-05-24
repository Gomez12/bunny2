# Phase 7 — Self-learning, user-verified

> Parent: [`overall.md`](./overall.md) §8 Phase 7.
> Scope of this document: **detailed plan for phase 7 only**.
> Inherits from `overall.md` §4 (stack), §5 (event-sourced core,
> layered scoping, soft-delete, UUIDs, i18n, authorization-aware
> retrieval, **invariant 9 — self-learning with a verification
> gate**), §10 (LLM provider + telemetry decisions).
> Builds on phase 5
> ([`done/phase-05-scheduled-tasks.md`](./done/phase-05-scheduled-tasks.md))
> for the scheduled-task registry (one `kind` per built-in handler)
> and the durable SQLite-backed bus.
> Builds on phase 6
> ([`done/phase-06-super-chat.md`](./done/phase-06-super-chat.md))
> for the chat pipeline (`chat_messages`, `chat_pipeline_runs`,
> `chat_pipeline_steps`, `chat_message_feedback`), the LanceDB
> write scaffold (`apps/server/src/chat/embeddings/`), and the
> already-registered placeholder handler
> `chat.review-layer` whose body this phase fills in.
> Pins the contract phase 8 consumes — the **`threshold`** field
> on every proposal — so phase 8 only needs to flip activation
> gating, not re-shape data.

---

## 1. Goal

Turn the chat-pipeline telemetry that phase 6 quietly collected
(`chat_messages`, `chat_pipeline_steps`, `chat_message_feedback`,
`llm_calls`) into a **review loop with a human gate**: a per-layer
scheduled agent mines feedback + step traces, proposes concrete
improvements (new tool / new skill / new agent / improved
existing artifact), runs each proposal in a sandbox to produce
evidence, and surfaces the proposal in a UI where the layer
admin approves, rejects, or defers. On approval the system
**re-plans** against the current capability set (capabilities may
have changed since the proposal was minted) before the artifact
becomes active.

After phase 7 a logged-in layer admin should be able to:

1. Open `/l/<slug>/proposals` and see a list of improvement
   proposals their layer's review agent has minted, sorted by
   expected impact, filterable by status (`new`, `approved`,
   `rejected`, `superseded`, `activated`).
2. Open a proposal and read: detected problem (which messages,
   which feedback), proposed fix (artifact kind + spec), expected
   impact (improved thumbs ratio, latency, cost), sandbox
   evidence (replayed prompts + outputs against current
   pipeline vs proposed artifact), and the `threshold` value
   the review agent assigned.
3. Click **Approve** → the system re-plans against the current
   capability snapshot, regenerates the artifact spec if a newer
   capability already covers the gap, and only then activates
   the artifact (registers a new tool / skill / agent into the
   per-layer registry from
   [`overall.md` §5 invariant 4](./overall.md#5-architectural-principles-invariants-every-phase-must-keep)).
4. Reload `/l/<slug>/chat` and ask the same question that triggered
   the proposal; see the activated artifact participating in the
   answer (a new column on the Kanban; an extra `chat_pipeline_steps`
   row tagged with the artifact id).
5. Inspect `/l/<slug>/capabilities` and see every tool / skill /
   agent attached to this layer, with its origin (`builtin`,
   `proposal:<id>`) and its activation date.
6. See the threshold value on every proposal even though phase 7
   ignores it for activation — phase 8 will consume it without
   any schema change.

Phase 7 is **also** where the phase-6 read-path placeholder for
retrieval (LIKE-on-`searchable_text`) gets swapped for a real
LanceDB vector read behind the same `searchSummaries` interface.
The read swap is the natural first sub-phase because every later
sub-phase reads from the same retrieval primitive, and shipping
the swap up front means the review agent already mines from the
real read path.

---

## 2. Scope

In scope:

- **Retrieval read swap (`apps/server/src/entities/store.ts`)** —
  add a vector-search path keyed off `lancedb.ready === true`,
  pre-filter by `layer_id IN (?)`, fall back to LIKE when the
  embedder is unavailable or the corpus is empty. `searchSummaries`
  signature unchanged; the chat pipeline does not change.
- **Proposal data model** — new tables
  `improvement_proposals`, `improvement_proposal_evidence`,
  `improvement_proposal_artifacts`,
  `layer_capabilities` (per-layer registry of activated tools /
  skills / agents — phase-3 left this as a registration point;
  phase 7 fills it). Migration `0015_proposals.sql`. zod schemas in
  `packages/shared/src/schemas/proposals.ts`.
- **Per-layer review agent (`chat.review-layer`)** — replaces
  the phase-6 placeholder body. For each layer, reads the last
  N days of `chat_messages` joined with `chat_message_feedback`
  and `chat_pipeline_steps`, groups by failure mode (zero-hit
  retrieval, low-confidence intent, thumbs-down with reason
  pattern, latency over budget, repeated `error_code`), and
  emits one proposal per cluster. Output schema is zod-validated;
  the run writes one `improvement_proposals` row per cluster and
  one `improvement_proposal_evidence` row per supporting message.
- **Sandbox runner (`apps/server/src/proposals/sandbox/`)** —
  replays the supporting messages against (a) the current
  pipeline and (b) the pipeline with the proposed artifact
  registered into an **in-memory capability overlay**. Writes one
  `improvement_proposal_artifacts` row with both transcripts +
  delta metrics (`thumbs_up_delta`, `tokens_delta`, `latency_delta`).
  The sandbox never touches the durable bus, never persists
  artifact code anywhere visible to chat, and runs with a hard
  10-second timeout per replay.
- **Capability re-inspector (`apps/server/src/proposals/replan.ts`)** —
  on approval, snapshots the layer's current capability set,
  diffs against the snapshot the proposal was minted under, and
  either: activates the artifact as-is (no drift), regenerates
  the artifact spec against current capabilities (capability set
  changed but the gap persists), or marks the proposal
  `superseded` (a newer capability already covers the gap).
  Re-plan is a single LLM call validated with zod; the
  regenerated spec re-runs the sandbox before activating.
- **Tool / skill / agent builder** — three artifact kinds, each
  with a tight contract:
  - `tool`: a typed function the answerer step can call (lays the
    groundwork for the phase-7+ tool-calling answerer follow-up;
    phase 7 ships the registry + activation, the answerer still
    runs the hard-coded shape).
  - `skill`: a prompt-fragment registered against a
    `(layer_id, intent)` key, injected into the answerer's system
    prompt when the resolver picks that intent.
  - `agent`: a long-running per-layer subscriber registered against
    one or more bus event kinds (e.g. "summarize new calendar
    events on `entity.created`"). Lives off the durable bus.

  All three persist to `improvement_proposal_artifacts` (spec
  JSON only; never raw code) and to `layer_capabilities` on
  activation.

- **Per-layer HTTP routes**:
  - `GET /l/:slug/proposals` (list, filter by status, sort by
    expected impact / created_at)
  - `GET /l/:slug/proposals/:id` (detail)
  - `POST /l/:slug/proposals/:id/approve` (triggers re-plan +
    activation)
  - `POST /l/:slug/proposals/:id/reject` (terminal, with reason)
  - `POST /l/:slug/proposals/:id/replay-sandbox` (re-runs sandbox
    on demand; admin-only)
  - `GET /l/:slug/capabilities` (list activated artifacts)
- **Web UI**:
  - `/l/:slug/proposals` — table view (status filter, sort,
    badge for `threshold`, link to detail).
  - `/l/:slug/proposals/:id` — detail page: problem clusters,
    supporting messages (deep-link to
    [`chat-page-message-deep-link.md`](../follow-ups/chat-page-message-deep-link.md)),
    proposed artifact spec, sandbox transcripts side-by-side,
    impact deltas, **Approve / Reject** buttons (admin-only).
  - `/l/:slug/capabilities` — list of activated artifacts per
    layer, with origin + activation date + a "deactivate" admin
    action.
  - `ProposalsWidget` registered via the existing widget registry
    (mirror `RecentChatsWidget`) — shows the latest 5 `new`
    proposals on the layer dashboard.
  - `/l/:slug/chat/board` — extend the Kanban to surface the
    activated artifact id on each card when a tool / skill / agent
    contributed to that message.
- **Two new scheduled-task kinds, plus the placeholder fill-in**:
  - `chat.review-layer` (placeholder body replaced; existing
    kind, existing registration; phase-6 cadence preserved at 24 h).
  - `proposals.evidence.prune` (retention, 90 d default; mirrors
    `chat.runs.prune`).
  - `proposals.replan-stale` (re-replans every `new` proposal
    older than 7 d whose capability snapshot drifted, so the UI
    doesn't show stale evidence; idempotent).
- **ADRs**:
  - `0023 — Improvement proposal contract` (data model + lifecycle
    - threshold field + capability-snapshot semantics).
  - `0024 — Sandbox runner` (boundary, capability overlay, no
    code persistence, hard timeout, replay determinism rules).
  - `0025 — Re-plan on approval` (when re-plan regenerates vs
    activates as-is vs supersedes; the snapshot diff algorithm).
- **Architecture docs**:
  - `docs/dev/architecture/self-learning.md` — the review-loop
    tour (review agent → proposal → sandbox → re-plan →
    activation; with Mermaid).
  - `docs/dev/architecture/retrieval.md` — section §5 updated to
    document the read swap (auth contract unchanged).
  - `docs/dev/architecture/job-inventory.md` — two new rows
    (`proposals.evidence.prune`, `proposals.replan-stale`);
    `chat.review-layer` row's "touches LLM?" flips to **yes**.
- **User guide** `docs/user/guides/improvement-proposals.md` —
  what a proposal is, how to read evidence, when to approve,
  what activation does, where activated artifacts appear in
  chat.
- **Smoke extension**: the headline phase-7 smoke runs the entire
  loop end-to-end on a calendar-event question whose phase-6
  retrieval returned zero hits (deliberately misspelled term) →
  thumbs-down → review agent runs → one proposal exists → admin
  approves → re-plan activates a `skill` (prompt fragment that
  expands "Acmé" → "Acme") → same question is re-asked → answer
  now references the event.
- **i18n keys** under `proposals.*` and `capabilities.*` (en + nl
  1:1).
- **`tests/docs/job-inventory.test.ts`** updated with the two
  new kinds.

Out of scope (deferred, called out so a sub-phase cannot drag
them in):

- **Threshold-based automation.** Phase 8. The `threshold` field
  is recorded on every proposal in phase 7 but is never read by
  the activation path; activation always requires explicit
  approval.
- **Tool-calling answerer.** Tools are registered in phase 7 but
  the answerer still runs the hard-coded shape. Wiring the
  registered tools into a tool-calling answerer is the
  `chat-tool-calling-answerer.md` follow-up.
- **Multi-layer proposal aggregation.** Each review agent run is
  scoped to one layer; cross-layer pattern mining is a phase-8+
  topic.
- **Conversation auto-summary.** Separate follow-up
  (`chat-conversation-auto-summary.md`); phase 7 does not pick
  it up — the title fallback stays as-is.
- **Per-layer LLM model override.** Separate follow-up
  (`chat-per-layer-llm-model.md`); the review agent + sandbox
  use the system-default LLM until that follow-up lands.
- **Per-layer embedding budget.** Separate follow-up
  (`chat-per-layer-embedding-budget.md`); read swap stays under
  the existing system-wide rate limit.
- **Shared / multi-user proposals.** Approvals are
  `(layer_id, user_id)`-scoped today; cross-user proposal
  ownership is a follow-up.
- **Cloud-hosted sandbox.** Sandbox runs in-process; isolated
  child processes / containers are not in scope (originalplan.md
  §non-goals — local-first).
- **External proposal source.** No webhook, no admin-initiated
  proposal creation — only the review agent mints proposals in
  v1.
- **Activated-artifact rollback UI.** "Deactivate" is the v1
  control; full rollback (re-run sandbox of previous version) is
  a phase-8 deliverable since it relies on the threshold
  automation's audit trail.

---

## 3. Sub-phases

| #   | Title                                                                                                                                                                                                                                                                                                                                                                     | Estimate | Output                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------: | -------------------------------------------------------------------------------- |
| 7.0 | This detail plan + ADR stubs (`0023`, `0024`, `0025` as `proposed`)                                                                                                                                                                                                                                                                                                       |       3h | plan + ADR drafts; tasklist rows 7.1–7.7 open                                    |
| 7.1 | LanceDB read swap behind `EntityStore.searchSummaries` (pre-filter on `layer_id IN (?)`; fallback to LIKE when corpus empty); regression test pins the auth boundary; closes `chat-lancedb-read-swap.md`                                                                                                                                                                  |       6h | chat retrieval reads from LanceDB by default; LIKE remains the degraded path     |
| 7.2 | Migration `0015_proposals.sql` + repos (`improvement_proposals`, `improvement_proposal_evidence`, `improvement_proposal_artifacts`, `layer_capabilities`) + zod schemas in `packages/shared/src/schemas/proposals.ts` + repo unit tests                                                                                                                                   |       5h | schema migration applied; CRUD round-trips green                                 |
| 7.3 | Review agent: replace `chat.review-layer` body with the real implementation (telemetry mining, cluster grouper, proposal minter); LLM call validated by zod; unit tests against fixture telemetry; bus event `proposal.minted`                                                                                                                                            |       8h | seeded telemetry → at least one proposal row per fixture cluster                 |
| 7.4 | Sandbox runner + capability re-inspector: replay supporting messages against current pipeline + overlay-with-proposed-artifact; delta metrics; capability-snapshot diff; ADR 0024 / 0025 enforced in code; integration test that approval re-plans correctly under all three outcomes (no drift / drift but gap persists / superseded)                                    |       8h | one proposal can move new → approved → activated end-to-end against the mock LLM |
| 7.5 | Tool / skill / agent builder: three artifact kinds with their activation paths (tool → answerer-step lookup table; skill → answerer prompt fragment; agent → durable-bus subscriber registered on activation); `layer_capabilities` write path + per-layer registry consumers; admin-only deactivate                                                                      |       6h | a `skill` activated by 7.4's flow shows up in the next chat answer               |
| 7.6 | HTTP routes (`/l/:slug/proposals/*`, `/l/:slug/capabilities`) + admin auth gates + web UI (`/l/:slug/proposals`, `/l/:slug/proposals/:id`, `/l/:slug/capabilities`, `ProposalsWidget`) + Kanban artifact-id badge + i18n keys (en + nl) + `proposals.evidence.prune` + `proposals.replan-stale` scheduled-task handlers registered                                        |       8h | admin can read, approve, reject, replay-sandbox; widget on dashboard             |
| 7.7 | Smoke (`apps/server/tests/smoke.test.ts` + `apps/server/tests/smoke-worker.test.ts`) + en/nl i18n + ADRs 0023/0024/0025 accepted + `architecture/self-learning.md` + `architecture/retrieval.md` §5 update + `architecture/job-inventory.md` rows + `user/guides/improvement-proposals.md` + close-out (move plan to `done/`; write `overall.md` §8 phase-7 status block) |       5h | green CI; plan moves to `done/`; overall.md §8 phase-7 status block written      |

Each sub-phase needs its own `open → done` row in
`docs/dev/tasklist.md` referencing this plan. 7.0 closes when this
file + the three ADR stubs + the seven new tasklist rows land in
one commit.

---

## 4. Approach

### 4.1 Retrieval read swap (lands in 7.1)

```ts
// apps/server/src/entities/store.ts — pseudo-shape
async searchSummaries(layerIds, term, opts) {
  if (lancedb.ready && this.embedder && this.embedder.kind !== 'mock') {
    const queryVec = await this.embedder.encode(term);
    const rows = await this.lance.table(this.kind).search(queryVec)
      .where(`layer_id IN (${quoted(layerIds)})`)   // PRE-FILTER (auth)
      .limit(opts.limit ?? 5)
      .toArray();
    if (rows.length > 0) return mapToSummaries(rows);
  }
  return this.sqliteLike(layerIds, term, opts);   // existing fallback
}
```

- The `where(...)` clause runs **before** the vector neighbour
  scan (per [ADR 0021 §1](../decisions/0021-embedding-and-lance-auth-tag.md)).
  Without this we'd violate `overall.md` §5 invariant 8.
- The signature does not change — the chat pipeline's retrieval
  step keeps working byte-for-byte; the swap is observable only
  in latency and recall.
- `MockEmbedder` is **not** swapped in (the `kind !== 'mock'`
  guard preserves the test path; tests stay deterministic on
  LIKE).
- A regression test (`apps/server/tests/retrieval-auth-boundary.test.ts`)
  asserts: insert two entities in different layers, embed both,
  query for a term matching both — caller in layer X must
  receive only the layer-X row, both via LanceDB and via LIKE
  fallback.
- Closes the `chat-lancedb-read-swap.md` follow-up (move to
  `docs/dev/follow-ups/done/` at 7.7).

### 4.2 Proposal data model (lands in 7.2)

```sql
-- 0015_proposals.sql sketch (final SQL lands in the 7.2 PR)

CREATE TABLE improvement_proposals (
  id TEXT PRIMARY KEY,                       -- uuid
  layer_id TEXT NOT NULL REFERENCES layers(id),
  status TEXT NOT NULL
    CHECK (status IN ('new','approved','rejected','superseded','activated','deactivated')),
  artifact_kind TEXT NOT NULL
    CHECK (artifact_kind IN ('tool','skill','agent')),
  problem_summary TEXT NOT NULL,             -- LLM-minted summary
  proposed_spec_json TEXT NOT NULL,          -- artifact spec (no code)
  expected_impact_json TEXT NOT NULL,        -- {thumbsUpDelta, tokensDelta, latencyDelta}
  threshold REAL NOT NULL,                   -- 0..1; phase 8 consumes
  capability_snapshot_json TEXT NOT NULL,    -- snapshot at mint time
  minted_by_run_id TEXT NOT NULL,            -- scheduled_task_runs.id
  minted_at TEXT NOT NULL,
  approved_by TEXT REFERENCES users(id),
  approved_at TEXT,
  rejected_by TEXT REFERENCES users(id),
  rejected_at TEXT,
  rejected_reason TEXT,
  activated_at TEXT,
  deleted_at TEXT,
  deleted_by TEXT
);
CREATE INDEX idx_improvement_proposals_layer_status
  ON improvement_proposals(layer_id, status, minted_at);

CREATE TABLE improvement_proposal_evidence (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES improvement_proposals(id),
  message_id TEXT NOT NULL REFERENCES chat_messages(id),
  cluster_reason TEXT NOT NULL,              -- 'zero_hit_retrieval' | 'thumbs_down' | …
  detail_json TEXT
);
CREATE INDEX idx_improvement_proposal_evidence_proposal
  ON improvement_proposal_evidence(proposal_id);

CREATE TABLE improvement_proposal_artifacts (
  id TEXT PRIMARY KEY,
  proposal_id TEXT NOT NULL REFERENCES improvement_proposals(id),
  variant TEXT NOT NULL                      -- 'current' | 'proposed'
    CHECK (variant IN ('current','proposed','replanned')),
  transcript_json TEXT NOT NULL,             -- replay output
  metrics_json TEXT NOT NULL,                -- {tokensIn, tokensOut, latencyMs, thumbsScore}
  ran_at TEXT NOT NULL
);

CREATE TABLE layer_capabilities (
  id TEXT PRIMARY KEY,
  layer_id TEXT NOT NULL REFERENCES layers(id),
  kind TEXT NOT NULL                         -- 'tool' | 'skill' | 'agent'
    CHECK (kind IN ('tool','skill','agent')),
  name TEXT NOT NULL,
  spec_json TEXT NOT NULL,                   -- the live spec
  origin TEXT NOT NULL,                      -- 'builtin' | 'proposal:<uuid>'
  activated_at TEXT NOT NULL,
  deactivated_at TEXT,
  UNIQUE(layer_id, kind, name)
);
CREATE INDEX idx_layer_capabilities_layer
  ON layer_capabilities(layer_id, deactivated_at);
```

zod schemas live in `packages/shared/src/schemas/proposals.ts`
(mirror `packages/shared/src/schemas/chat.ts` shape).

### 4.3 Review agent (lands in 7.3)

The body of `chat.review-layer` becomes the per-layer review
agent. Pseudo-shape:

```ts
async function run(ctx) {
  const layerId = ctx.task.layerId;
  const window = { from: now() - 7d, to: now() };
  const messages = chatRepo.listForReview(layerId, window);
  const feedback = feedbackRepo.byMessageIds(messages.map(m => m.id));
  const steps    = stepsRepo.byMessageIds(messages.map(m => m.id));
  const llmCalls = llmRepo.byCorrelationIds(messages.map(m => m.correlationId));

  const clusters = clusterFailureModes({ messages, feedback, steps, llmCalls });
  // ^ pure code: zero-hit retrieval; thumbs_down; invalid_step_output;
  //   latency-over-budget; error_code patterns. Deterministic.

  for (const cluster of clusters) {
    const spec = await llmMintProposal(cluster, capabilitySnapshot(layerId));
    //   ^ one LLM call per cluster; output zod-validated against
    //     ProposalSpec; on parse failure: retry once, then skip.
    proposalsRepo.insert({
      layerId,
      artifactKind: spec.artifactKind,
      problemSummary: spec.summary,
      proposedSpec: spec,
      expectedImpact: spec.expectedImpact,
      threshold: spec.threshold,
      capabilitySnapshot: capabilitySnapshot(layerId),
      mintedByRunId: ctx.runId,
      mintedAt: now(),
      status: 'new',
    });
    bus.publish('proposal.minted', { proposalId, layerId });
  }
}
```

- One LLM call per cluster (not per message). `llm_calls` row
  per cluster.
- Capability snapshot is the JSON serialization of
  `layer_capabilities` rows where `deactivated_at IS NULL` plus
  the built-in capability list (constant). The snapshot lives on
  the proposal so re-plan at approval time has a baseline to
  diff against.
- The cluster grouper is **pure code** (deterministic, testable).
  The LLM only sees the cluster summary + capability snapshot
  and produces a `ProposalSpec`. Keeps the LLM cost bounded and
  the test surface tractable.
- The handler's `defaultSchedule` stays at `interval, 24 h` (the
  phase-6 placeholder cadence). Existing scheduled-task rows are
  not re-seeded — the row in the DB keeps its layer-specific
  override.
- `chat.review-layer` "touches LLM?" flips to **yes** in
  `job-inventory.md`.

### 4.4 Sandbox runner + capability re-inspector (lands in 7.4)

```ts
// apps/server/src/proposals/sandbox/runner.ts — pseudo-shape

interface SandboxResult {
  current: Transcript; // pipeline as-is
  proposed: Transcript; // pipeline + overlay capability
  metrics: DeltaMetrics; // proposed minus current
}

export async function runSandbox(proposal, evidenceMessages, deps): Promise<SandboxResult> {
  const overlay = buildCapabilityOverlay(proposal.proposedSpec);
  // ^ in-memory ONLY. The overlay layers on top of
  //   layer_capabilities for the duration of this run.

  const current = await replayMessages(evidenceMessages, /* overlay */ null, deps);
  const proposed = await replayMessages(evidenceMessages, overlay, deps);
  return {
    current,
    proposed,
    metrics: diff(current, proposed),
  };
}
```

- The overlay is a Map<(kind, name), spec> read-through that the
  per-layer registry consults first. Sandbox runs that consult
  the registry see the overlay; everything else (chat traffic in
  flight, other scheduled tasks) does not.
- Replays run against `MockLlmClient` if the deployment is in
  test mode and against the real LLM in production; the
  result transcripts include `tokens_in` / `tokens_out` /
  `latency_ms` so the delta is real.
- Hard 10-second timeout per replayed message; sandbox aborts
  with `metrics.sandboxOutcome = 'timeout'` if exceeded.
- Sandbox **never** persists artifact code anywhere visible to
  chat; it only writes `improvement_proposal_artifacts` rows
  with transcripts + metrics. ADR 0024 records this.

```ts
// apps/server/src/proposals/replan.ts — pseudo-shape

export async function replanOnApproval(proposalId, approvedBy, deps) {
  const proposal = proposalsRepo.get(proposalId);
  const mintedSnapshot   = JSON.parse(proposal.capabilitySnapshotJson);
  const currentSnapshot  = capabilitySnapshot(proposal.layerId);
  const diff = diffSnapshots(mintedSnapshot, currentSnapshot);

  if (diff.coversGap(proposal.proposedSpec)) {
    proposalsRepo.update(proposalId, { status: 'superseded' });
    return { outcome: 'superseded' };
  }

  if (diff.isEmpty) {
    activate(proposal.proposedSpec, proposal.layerId, `proposal:${proposalId}`);
    proposalsRepo.update(proposalId, { status: 'activated', approvedBy, approvedAt: now(), activatedAt: now() });
    return { outcome: 'activated-asis' };
  }

  // capabilities changed but gap persists → regenerate the spec
  const replannedSpec = await llmReplan(proposal, currentSnapshot);
  const sandbox = await runSandbox({...proposal, proposedSpec: replannedSpec}, ...);
  if (sandbox.metrics.thumbsUpDelta <= 0) {
    proposalsRepo.update(proposalId, { status: 'superseded' });   // re-plan didn't help
    return { outcome: 'superseded-after-replan' };
  }
  artifactsRepo.insert({ proposalId, variant: 'replanned', ... });
  activate(replannedSpec, proposal.layerId, `proposal:${proposalId}`);
  proposalsRepo.update(proposalId, { status: 'activated', approvedBy, approvedAt: now(), activatedAt: now() });
  return { outcome: 'activated-replanned' };
}
```

- Three outcomes (`activated-asis`, `activated-replanned`,
  `superseded`, plus `superseded-after-replan`) — each has its
  own UI affordance and bus event (`proposal.activated`,
  `proposal.superseded`).
- ADR 0025 fixes the diff algorithm: "covers the gap" is
  defined as "the cluster's failure-mode tags are all addressed
  by a capability that exists in `currentSnapshot` but not in
  `mintedSnapshot`".
- Re-plan is at most **one** LLM call. Phase 7 does not loop on
  re-plan to keep cost bounded.

### 4.5 Tool / skill / agent builder + registry (lands in 7.5)

Three artifact kinds, three activation paths:

| Artifact kind | What the spec describes                                                                                              | Activation hook                                                                                                                    | Consumer (phase 7)                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `tool`        | `{ name, description, jsonSchema, handler: { kind: 'searchSummaries-aliased' \| 'projection-lookup', config }}`      | Inserts into `layer_capabilities`; per-layer tool registry exposes `listTools(layerId)`                                            | Tool registry available; **hard-coded answerer ignores it** (tool-calling is a follow-up) |
| `skill`       | `{ name, description, intent, promptFragment }` (intent matches the resolver's enum)                                 | Inserts into `layer_capabilities`; answerer step calls `loadSkillFragments(layerId, intent)` and appends each to the system prompt | Answerer prompt automatically includes activated skills for the matched intent            |
| `agent`       | `{ name, description, subscribesTo: BusEventKind[], handler: { kind: 'enrichment-call' \| 'summary-call', config }}` | Inserts into `layer_capabilities`; bus subscriber wrapper subscribes on activation, unsubscribes on deactivation                   | Bus events trigger the agent (idempotent; off-the-bus retries)                            |

- **No raw code is ever stored or executed.** All three kinds
  are JSON specs interpreted by a small set of statically-typed
  handler kinds (`'searchSummaries-aliased'`,
  `'projection-lookup'`, `'enrichment-call'`, `'summary-call'`).
  This is the central security choice: it makes the sandbox
  boundary defensible (ADR 0024) and forecloses on
  arbitrary-code-injection as a class.
- Adding new handler kinds is an explicit code change in a
  future sub-phase; the proposal LLM is constrained at mint
  time to only emit specs whose handler kind exists in the
  registered enum. Validation runs both at mint (zod) and at
  activation (defensive re-check).
- `layer_capabilities` rows survive restart; the bootstrap path
  in `apps/server/src/index.ts` re-attaches subscribers for every
  active `agent` row, mirroring the way the scheduled-task
  registry re-seeds.
- Admin "deactivate" sets `deactivated_at`; the registry
  immediately stops returning the row.

### 4.6 HTTP + UI (lands in 7.6)

#### ASCII wireframe — `/l/:slug/proposals`

```txt
+---------------------------------------------------------------------+
| Improvement proposals — <Layer name>                                |
|---------------------------------------------------------------------|
| Status: [All] [New] [Approved] [Rejected] [Superseded] [Activated]  |
| Sort:   [Newest] [Highest impact] [Highest threshold]               |
|---------------------------------------------------------------------|
| Kind  | Problem                  | Impact | Threshold | Status      |
|-------|--------------------------|--------|-----------|-------------|
| skill | "Acme" misspelled hits 0 |  +18%  |   0.72    | new         |
| tool  | Calendar week lookup     |   +9%  |   0.55    | new         |
| agent | Auto-summarise meetings  |  +12%  |   0.81    | approved    |
|---------------------------------------------------------------------|
| Empty state: shown when no proposals exist for the filter           |
| Error state: shown when fetch fails                                 |
+---------------------------------------------------------------------+
```

#### ASCII wireframe — `/l/:slug/proposals/:id`

```txt
+---------------------------------------------------------------------+
| ← back to proposals                                                 |
| skill — "Expand Acme alias"                  threshold: 0.72        |
|---------------------------------------------------------------------|
| Problem                                                             |
|   3 messages got 0 retrieval hits searching for "Acmé"              |
|   • [#m1] when do I meet Acmé?            (thumbs-down)             |
|   • [#m2] show me Acmé strategy notes     (thumbs-down)             |
|   • [#m3] who at Acmé did I email last?   (thumbs-down)             |
|                                                                     |
| Proposed fix                                                        |
|   Add a skill prompt-fragment for intent=question.entity_lookup:    |
|     "If the user writes Acmé, also search for Acme."                |
|                                                                     |
| Expected impact                                                     |
|   thumbs-up delta: +18%                                             |
|   tokens delta:    +12 / message                                    |
|   latency delta:   +14 ms / message                                 |
|                                                                     |
| Sandbox evidence (replayed 3 messages)                              |
|   ┌─ current ────────────┐  ┌─ proposed ───────────┐                |
|   │ 0 hits, "I don't…"   │  │ 1 hit, real answer   │                |
|   │ 0 hits, "I don't…"   │  │ 2 hits, real answer  │                |
|   │ 0 hits, "I don't…"   │  │ 1 hit, real answer   │                |
|   └──────────────────────┘  └──────────────────────┘                |
|                                                                     |
| [Approve]  [Reject]  [Replay sandbox]                               |
|---------------------------------------------------------------------|
| Status: new                                                         |
+---------------------------------------------------------------------+
```

- Approve / Reject / Replay sandbox are admin-only (reuse the
  existing `canEditLayer` check).
- The supporting-message bullets deep-link to the chat page with
  `?message=:id`; the deep-link itself is the
  `chat-page-message-deep-link.md` follow-up — phase 7 emits the
  link, phase-6 follow-up resolves the scroll behaviour.
- `ProposalsWidget` mirrors `RecentChatsWidget`: top 5 `new`
  proposals, click-through to detail.
- `/l/:slug/chat/board` extension: a small `[skill:…]` /
  `[tool:…]` / `[agent:…]` chip on every card whose pipeline
  consulted an activated capability. Source field is `chat_pipeline_steps.attribution_json` (one new nullable column added in 7.2).

### 4.7 Telemetry, logging, analytics

- **Console + file logging**: every review-agent run logs `event:
'proposal.mint.cluster'` + `event: 'proposal.mint.persist'`
  (or `…skipped`). Sandbox logs `event:
'proposal.sandbox.replay'` per message + summary
  `proposal.sandbox.complete`. Re-plan logs
  `event: 'proposal.replan.outcome'` with one of
  `activated-asis | activated-replanned | superseded | superseded-after-replan`. File logging via the standard
  `ctx.logger` so the durable diagnostics path catches it.
- **Telemetry** (`llm_calls` + new emit calls):
  `proposal.minted_count` (per layer), `proposal.sandbox.duration_ms`
  (per run), `proposal.replan.outcome_count` (per outcome label),
  `proposal.capability.activated_count`. Names follow the
  `<domain>.<event>.<unit>` convention from
  [`AGENTS.md §Telemetry`](../../../AGENTS.md#telemetry).
  **Cardinality cap**: outcome label is bounded; never use
  proposal id or message id as a label.
- **Analytics** (uses the placeholder `console.log('[chat.analytics] …')`
  primitive from
  [`web-analytics-primitive.md`](../follow-ups/web-analytics-primitive.md)
  until that follow-up lands): `proposals_page_opened`,
  `proposal_detail_opened`, `proposal_approved`,
  `proposal_rejected`, `proposal_sandbox_replayed`. No sensitive
  values; proposal id is opaque.
- LLM calls are already logged (phase-1 invariant); the review
  agent call + the re-plan call show up as `flow_id =
proposal.mint:<runId>` / `flow_id = proposal.replan:<proposalId>`
  in `llm_calls`. Re-uses the existing telemetry table.

---

## 5. Affected modules

- **New**: `apps/server/src/proposals/` (review-agent body lives
  here; sandbox/, replan.ts, registry.ts, repos/, routes
  under `http/routes/layer-proposals.ts` and `layer-capabilities.ts`),
  `apps/web/src/pages/LayerProposalsListPage.tsx`,
  `apps/web/src/pages/LayerProposalDetailPage.tsx`,
  `apps/web/src/pages/LayerCapabilitiesPage.tsx`,
  `apps/web/src/dashboard/ProposalsWidget.tsx`,
  `packages/shared/src/schemas/proposals.ts`,
  `apps/server/src/scheduled/built-in/proposals-evidence-prune.ts`,
  `apps/server/src/scheduled/built-in/proposals-replan-stale.ts`.
- **Migrated / extended**:
  `apps/server/src/storage/migrations/0015_proposals.sql` (new),
  `apps/server/src/entities/store.ts` (vector read path; LIKE
  fallback unchanged),
  `apps/server/src/chat/review-layer-handler.ts` (placeholder
  body replaced with real implementation; **kind unchanged**),
  `apps/server/src/chat/pipeline/orchestrator.ts` +
  `chat_pipeline_steps` schema (one new nullable
  `attribution_json` column for capability badging),
  `apps/server/src/chat/pipeline/answer-step.ts` (loads
  activated `skill` prompt fragments via the per-layer
  registry),
  `apps/server/src/index.ts` (re-attach `agent` subscribers on
  boot from `layer_capabilities`; register two new scheduled-task
  kinds; expose proposals routes),
  `apps/web/src/App.tsx` (three new routes),
  `apps/web/src/i18n/locales/{en,nl}.json` (new keys under
  `proposals.*` and `capabilities.*`),
  `apps/web/src/dashboard/widgets.ts` (barrel import),
  `apps/web/src/lib/api.ts` (new functions for proposals +
  capabilities).
- **Reused unchanged**: `LayerResolver`
  (`apps/server/src/layers/resolver.ts`), `withEffectiveLayers` /
  `requireLayer` middleware, the durable bus, the scheduled-task
  registry, the `llm_calls` telemetry table, shadcn primitives
  in `apps/web/src/components/ui/`, the `TodosKanbanView` shape,
  the chat repos, `MockLlmClient`.
- **Docs**: `docs/dev/architecture/self-learning.md` (new),
  `docs/dev/architecture/retrieval.md` §5 (update),
  `docs/dev/architecture/job-inventory.md` (two new rows;
  `chat.review-layer` LLM flag flips to yes),
  `docs/dev/architecture/overview.md` (proposals module added),
  `docs/dev/decisions/0023-improvement-proposal-contract.md`,
  `docs/dev/decisions/0024-sandbox-runner.md`,
  `docs/dev/decisions/0025-replan-on-approval.md`,
  `docs/user/guides/improvement-proposals.md` (new),
  `docs/dev/plans/overall.md` §8 phase-7 status block (added at
  close-out), `docs/dev/tasklist.md` (eight rows total for phase 7).

---

## 6. Tests

- **Unit**:
  - Repos: CRUD round-trips on all four new tables; soft-delete
    propagation; `layer_capabilities` UNIQUE constraint.
  - zod schemas: every `ProposalSpec` artifact-kind shape
    round-trips; reject malformed handler kinds.
  - Cluster grouper (`apps/server/src/proposals/clusters.ts`):
    feed fixture telemetry → assert exact cluster boundaries
    and `cluster_reason` labels.
  - Capability snapshot diff (`apps/server/src/proposals/replan.ts`):
    pinned input → three deterministic outcomes (covers / empty /
    persists).
  - Sandbox runner timeout: a deliberately-slow mock LLM →
    abort path emits `sandboxOutcome: 'timeout'`, no partial
    state leaks.
  - Vector-fallback: with `lancedb.ready = false`, retrieval
    silently uses LIKE.
- **Integration (the headline test)**: seed a layer + a calendar
  event titled "Acme strategy"; post three thumbs-down messages
  whose retrieval misses ("Acmé"); run `chat.review-layer`;
  assert one `improvement_proposals` row + 3 evidence rows;
  approve the proposal via the route; assert `layer_capabilities`
  has the new skill; ask the question again; assert the answer
  references the event.
- **Auth boundary (critical, per `overall.md` §5 invariant 8)**:
  vector-path test — user A in layer X queries a term matching
  layer-Y rows in LanceDB; result is empty. Compile-time test
  that `searchSummaries`'s vector path always wraps `where('layer_id
IN …')` in the same call as `.search(...)`.
- **Sandbox boundary**: a proposed `agent` artifact whose spec
  asks for an event kind not in the enum is rejected at sandbox
  time with `error_code = 'unknown_handler_kind'`. No row
  written to `layer_capabilities`.
- **Re-plan outcomes**: three integration tests, one per
  outcome label. The "superseded" path asserts the proposal
  status is updated and no capability is activated.
- **HTTP**: routes auth-gated (admin-only for mutations); list
  filter + sort honored; rejection requires a reason; approve
  returns the activation outcome.
- **i18n**: existing `tests/docs/i18n.test.ts` catches missing
  Dutch keys.
- **Job inventory**: existing `tests/docs/job-inventory.test.ts`
  catches missing entries for `proposals.evidence.prune` and
  `proposals.replan-stale`, plus the LLM-flag flip on
  `chat.review-layer`.
- **Smoke** (extends `apps/server/tests/smoke.test.ts` and
  `apps/server/tests/smoke-worker.test.ts`): end-to-end the
  loop described in §2 ("Smoke extension").

---

## 7. Docs impact

- New: `docs/dev/architecture/self-learning.md` (review-loop
  tour: review agent → proposal → sandbox → re-plan →
  activation; with Mermaid).
- Updated: `docs/dev/architecture/retrieval.md` (§5 updated to
  reflect the LanceDB read swap; auth contract unchanged);
  `docs/dev/architecture/job-inventory.md` (two new rows;
  `chat.review-layer` LLM flag flips);
  `docs/dev/architecture/overview.md` (proposals module in the
  module map); `docs/dev/plans/overall.md` §8 phase-7 row marked
  done at close-out (mirror the phase-6 block).
- Three ADRs accepted (status `proposed` in 7.0, flipped to
  `accepted` in 7.7): 0023 improvement proposal contract; 0024
  sandbox runner; 0025 re-plan on approval.

---

## 8. i18n impact

New namespaces under `proposals.*` and `capabilities.*`:

- `proposals.list.{title,emptyTitle,emptyDescription,errorLoadFailed,statusFilter,sortBy,thresholdHeader,impactHeader,kindHeader,statusHeader,problemHeader}`
- `proposals.status.{new,approved,rejected,superseded,activated,deactivated}`
- `proposals.kind.{tool,skill,agent}`
- `proposals.detail.{problemSectionTitle,proposedFixSectionTitle,expectedImpactSectionTitle,sandboxSectionTitle,approveCta,rejectCta,replaySandboxCta,rejectReasonLabel,rejectReasonPlaceholder,rejectConfirm,backToList,supportingMessagesTitle,supportingMessageOpen,thresholdLabel,activationOutcomeAsis,activationOutcomeReplanned,supersededOutcome,supersededAfterReplanOutcome}`
- `proposals.errors.{network,validation,upstream,replanFailed,sandboxFailed,timeout,unknownHandlerKind}`
- `capabilities.list.{title,emptyTitle,emptyDescription,errorLoadFailed,nameHeader,kindHeader,originHeader,activatedAtHeader,deactivateCta,deactivateConfirm,originBuiltin,originProposal}`
- `layer.dashboard.widgets.proposals.{title,emptyDescription,loading,errorLoadFailed,linkOpen}`
- `chat.board.cardCapabilityChip.{tool,skill,agent}`
- `nav.proposals`, `nav.capabilities`

en.json is primary; nl.json must be 1:1 — CI catches drift.

---

## 9. Accessibility impact

- Proposals list: data-table semantics (`<table>` with
  `<thead>`/`<tbody>`); sort buttons in `<th>` are real
  `<button>`s with `aria-sort` reflecting active state.
- Status filter chips: `role="radiogroup"` with `aria-label`
  from i18n; arrow-key navigation between chips.
- Approve / Reject / Replay buttons: real `<button>` elements;
  confirmation dialog uses the existing native `<dialog>` wrapper
  with focus trap.
- Sandbox transcripts: two `<section>`s with `<h2>` headings
  carrying localized titles; transcripts inside use semantic
  `<pre>` or `<ol>` for replays; not `<div>` soup.
- Supporting-message bullets: real `<a>` elements with
  `aria-describedby` pointing at the thumbs/zero-hit reason
  text.
- Kanban capability chip: visible label (not icon-only); has
  `title` for hover + `aria-label` for screen readers.
- Empty / error / loading states present on every page.

---

## 10. Security impact

- **No code execution from proposals.** ADR 0024 fixes this:
  every artifact kind has a closed enum of handler kinds; no
  field on a `ProposalSpec` is interpreted as code, ever. The
  proposal LLM is constrained at mint time, the spec is
  zod-validated at mint + sandbox + activation, and the
  registry refuses to register a handler kind it doesn't know.
  This forecloses on RCE as a class.
- **Re-plan still respects the auth boundary.** The capability
  snapshot only carries `(layer_id)`-scoped capabilities; the
  re-plan LLM call never receives capabilities from other
  layers. The sandbox runs replays through the same
  `requireLayer`-equivalent code path; no cross-layer leakage.
- **Approval is admin-only.** Approve / Reject / Replay sandbox
  / Deactivate routes all gate on `canEditLayer` (mirrors the
  phase-3 layer settings gate). A non-admin GET on the list
  returns 200 (everyone in the layer can read proposals);
  a non-admin POST returns 403.
- **Sandbox isolation is in-process.** The runner does not spawn
  child processes; it constructs an in-memory overlay and
  re-runs the existing pipeline. The 10-second timeout is the
  only resource bound. Stronger isolation (workers, containers)
  is a phase-8 follow-up if real-world spec complexity demands
  it; v1's `closed-enum` handler-kind model makes a heavier
  sandbox unnecessary.
- **Review-agent telemetry input is layer-scoped.** The cluster
  grouper queries `chat_messages WHERE layer_id = ?`; no
  cross-layer joins. The LLM call sees only that layer's
  cluster + that layer's capability snapshot.
- **Proposal spec never contains raw user content.** The
  cluster summary is LLM-distilled into `problem_summary`;
  supporting message texts are linked by id, not embedded into
  the spec. Means activating a proposal cannot leak chat
  content into a capability.
- LLM calls use the system-default config (no per-component
  override yet); same secret rules as elsewhere.

---

## 11. Risks

| Risk                                                                                             | Likelihood | Impact | Mitigation                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review-agent LLM emits a `ProposalSpec` referencing an unknown handler kind                      | Med        | Low    | zod validation at mint rejects; on second failure the cluster is skipped with `event: 'proposal.mint.skipped'`. Defensive re-check at activation guards the bypass case.                                                                                      |
| Re-plan loop oscillates between activation and supersession across review runs                   | Low        | Med    | Phase 7 does at most **one** re-plan per approval; replan-stale job is idempotent (only operates on `status='new'` proposals); cluster grouper de-duplicates by cluster signature, so a re-minted proposal carries the same id only if the signature matches. |
| LanceDB read swap silently degrades recall (vectors vs LIKE)                                     | Med        | Med    | Phase 7 keeps LIKE as fallback when `lancedb.ready === false`; a regression integration test runs the same fixture queries against both paths and asserts both find the seeded entity. Per-layer recall telemetry tracks divergence.                          |
| Sandbox replays charge real LLM calls in production                                              | Med        | Med    | Sandbox uses the same `MockLlmClient` in test mode and the real LLM in production; the 10-second timeout + small evidence-message cap (max 5 per proposal) cap cost. Telemetry `proposal.sandbox.duration_ms` + `llm_calls.cost` make it observable.          |
| Capability snapshot drifts between mint and approval, leading to confusing UI                    | Med        | Low    | `proposals.replan-stale` re-runs sandbox + re-fills evidence for every `new` proposal older than 7 d whose snapshot drifted, before a user opens the detail page.                                                                                             |
| Activated `agent` subscriber misbehaves and emits storms                                         | Low        | High   | Agent subscribers re-use the durable-bus's existing rate-limit + DLQ machinery (ADR 0019); a deactivate unsubscribes immediately. Bus storm telemetry already exists (per `event-bus.md`); no new surface needed.                                             |
| Cluster grouper bug skips a real failure mode                                                    | Med        | Low    | Grouper is pure code with fixture tests; a phase-8 follow-up could add an LLM-assist for outlier clusters once telemetry has enough data.                                                                                                                     |
| Threshold field is ignored in phase 7 but already wired UI-wise; users expect it to do something | Med        | Low    | The detail page labels the threshold "(used by phase 8 automation)"; the user guide spells out the gating. Telemetry tracks threshold distribution so phase 8 has data to pick its default cutoff.                                                            |

---

## 12. Open questions (answered before sub-phase 7.3 starts; do not block 7.0–7.2)

1. **Review-agent window**: last 7 days or last N messages per
   layer? Default to **7 days** in v1; reconfigurable per layer
   as a phase-7 follow-up if a quiet layer gets too few
   clusters.
2. **Evidence-message cap per cluster**: 5 supporting messages
   per cluster keeps the LLM prompt bounded; the runner
   deterministically picks the 5 with the strongest signal
   (recent thumbs-down first).
3. **Embedding model for the LanceDB read swap**: the
   `chat-lancedb-read-swap.md` follow-up reserved the choice for
   phase 7. v1 default: **OpenAI `text-embedding-3-small`** when
   the chat LLM is OpenAI-compatible and an `embeddings.model` is
   configured; otherwise `MockEmbedder` (and the read path falls
   back to LIKE). The system-level config gets one new optional
   field (`embeddings.model`) and a CI-friendly default that
   keeps tests offline.

These three are the only loose ends, and they don't block landing
7.0 / 7.1 / 7.2.

---

## 13. Verification

End-to-end manual smoke (matches the `AGENTS.md` "Done Means Done"
checklist; runs at 7.7 close-out):

1. `bun install && bun run dev` → log in as admin, switch to a
   layer that has a calendar event titled "Acme strategy".
2. Open `/l/<slug>/chat`. Ask "Wanneer is mijn Acmé strategy
   meeting?" three times in three conversations; thumbs-down on
   each.
3. Trigger `chat.review-layer` from `/admin/scheduled-tasks`
   (run-now button).
4. Open `/l/<slug>/proposals`. See one `new` proposal,
   artifact kind `skill`, problem summary mentioning the alias.
5. Click into the detail page; verify three supporting messages,
   side-by-side sandbox transcripts, deltas.
6. Click **Approve**. UI confirms `activated-asis`; status flips
   to `activated`.
7. Open `/l/<slug>/capabilities`. The new skill appears with
   origin `proposal:<uuid>`.
8. Ask the same question again in `/l/<slug>/chat`. The answer
   now references the calendar event.
9. Open `/l/<slug>/chat/board`. The latest message card has a
   `[skill:expand-acme-alias]` chip.
10. `/admin/llm/logs` shows the review-agent call (one row,
    `flow_id=proposal.mint:<runId>`), no re-plan row (no
    capability drift).
11. SQLite: one row in `improvement_proposals`, three in
    `improvement_proposal_evidence`, two in
    `improvement_proposal_artifacts` (current + proposed), one
    in `layer_capabilities` (active).
12. Soft-delete the calendar event → LanceDB row gone (phase-6
    invariant unchanged) → ask the question again → answer
    falls back to "I don't know" (skill is still active but
    retrieval has nothing to ground on).
13. CI (matches `AGENTS.md §Pull Requests`):
    `bun run format:check && bun run lint && bun run typecheck
&& bun test && bun run build && bun run docs:check && bun run
i18n:check` all green.
14. Smoke (`bun test apps/server/tests/smoke.test.ts`) and
    `smoke-worker` both green.

---

## 14. Close-out checklist (from `AGENTS.md`)

When phase 7 closes:

- All 8 tasklist rows for phase 7 are `done`.
- This plan moves from `docs/dev/plans/phase-07-self-learning.md` →
  `docs/dev/plans/done/phase-07-self-learning.md`; tasklist
  `Related document` paths updated.
- `docs/dev/plans/overall.md` §8 phase-7 status block written
  (mirror the §8 phase-6 block).
- Three new ADRs accepted (0023 / 0024 / 0025).
- `docs/dev/architecture/job-inventory.md` lists the two new
  `proposals.*` job kinds and flips the LLM flag on
  `chat.review-layer`; `tests/docs/job-inventory.test.ts` green.
- `chat-lancedb-read-swap.md` moves to
  `docs/dev/follow-ups/done/`.
- No new entries in `docs/dev/risks/` beyond what §11 already
  identifies (or new files if any §11 rows promote to first-class
  risks).
- Open follow-ups recorded as `docs/dev/follow-ups/*.md` for any
  loose ends raised during sub-phases (none anticipated up
  front; the existing chat-shaped follow-ups remain owned by
  their files).

---

## 15. Mermaid — review loop

```mermaid
flowchart TD
  A[chat.review-layer runs<br/>(every 24h, per layer)] --> B[cluster grouper<br/>(pure code)]
  B --> C{any clusters?}
  C -- no --> Z1[log 'no clusters']
  C -- yes --> D[LLM mint ProposalSpec<br/>(one call per cluster)]
  D --> E[insert improvement_proposals + evidence<br/>publish proposal.minted]
  E --> F[sandbox runner<br/>(replay messages with overlay)]
  F --> G[insert improvement_proposal_artifacts<br/>(current + proposed)]
  G --> H[proposal visible in /l/:slug/proposals]
  H --> I{admin approves?}
  I -- reject --> Z2[status=rejected]
  I -- approve --> J[capability snapshot diff]
  J -- empty diff --> K[activate as-is]
  J -- drift, gap covered --> L[status=superseded]
  J -- drift, gap persists --> M[LLM re-plan<br/>(one call) → re-sandbox → activate or supersede]
  K --> N[layer_capabilities row + publish proposal.activated]
  M --> N
  N --> O[answerer / tool registry / bus picks up the new capability]
  O --> P[next chat message uses it]
```
