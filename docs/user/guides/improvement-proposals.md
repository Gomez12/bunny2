# Improvement proposals

bunny2 watches how its chat answers your questions inside each
layer. When the same kind of question repeatedly misses, gets a
thumbs-down, or hits an error, the per-layer review agent files
an **improvement proposal**: a small, scoped suggestion to teach
the chat something new. As a layer admin you decide whether to
approve, reject, or come back to it later.

> Developers / admins: the technical write-up lives in
> `docs/dev/architecture/self-learning.md`. The data contract
> (status enums, the closed handler-kind list, the
> `threshold` field) lives in ADR
> [`0023`](../../dev/decisions/0023-improvement-proposal-contract.md).

---

## 1. What an improvement proposal is

A proposal is a structured guess at how to fix a recurring problem
in chat. It always has:

- A **problem summary** — what failed, how often, with links to
  the actual chat messages that fed the cluster.
- A **proposed fix** — a small JSON spec for one of three
  artifact kinds the system can activate:
  - **Skill** — a short prompt fragment the chat appends to the
    answerer's system prompt when a matching intent fires
    (e.g. "If the user writes _Acmé_, also consider _Acme_.").
  - **Tool** — a typed lookup the future tool-calling answerer
    can invoke (the registry is in place from phase 7; the
    tool-calling answerer itself ships later).
  - **Agent** — a long-running per-layer subscriber that reacts
    to bus events (e.g. summarising new calendar events on
    create).
- An **expected impact** — predicted thumbs-up delta, token
  delta, and latency delta. These come from the **sandbox
  evidence** below.
- **Sandbox evidence** — the system replays the failing chat
  messages twice: once against today's pipeline and once with
  the proposed fix wired in via an in-memory overlay. You see
  both transcripts side-by-side.
- A **threshold** — a number between 0 and 1 the review agent
  attached to the proposal. In v1 this is **informational only**;
  the activation gate is always your approval click. The
  threshold becomes the auto-approval gate when phase 8 ships.

The fix never contains executable code. The system supports a
small, closed list of handler kinds (see ADR 0023 §2); the
review agent is constrained to only emit those.

---

## 2. Where to find proposals

Open the layer where the data lives, then:

- **Top navigation → Proposals** (`/l/<slug>/proposals`). The
  list shows every proposal in the layer; filter by status
  (`new`, `approved`, `rejected`, `superseded`, `activated`)
  and sort by newest, highest impact, or highest threshold.
- **Layer dashboard → Improvement proposals widget**. Shows the
  five newest `new` proposals; click through for detail.
- A `[skill:…]` / `[tool:…]` / `[agent:…]` chip on a card in the
  **chat board** (`/l/<slug>/chat/board`) tells you that the
  message used an activated capability.

---

## 3. Reading the detail page

The detail page (`/l/<slug>/proposals/<id>`) has four sections:

1. **Problem** — the LLM-distilled cluster summary plus the
   supporting messages. Each bullet is a real chat message you
   can open via the deep-link.
2. **Proposed fix** — the artifact spec in human-readable form.
   Skills show the prompt fragment; tools show the JSON schema +
   handler kind; agents show the bus event kinds they subscribe
   to.
3. **Expected impact** — predicted thumbs-up delta, tokens
   delta, latency delta. Use this as the headline "is this worth
   approving?" signal.
4. **Sandbox evidence** — two columns of transcripts: the chat
   today vs. the chat with the proposal active. The supporting
   messages run through both pipelines so you can read what
   actually changed.

Below the four sections you see the **threshold** (informational
in v1) and three actions:

- **Approve** — activates the proposal. The system re-plans
  against the current capability set first (see §5).
- **Reject** — closes the proposal as not-going-to-do. You must
  supply a reason.
- **Replay sandbox** — re-runs the sandbox right now (useful if
  the layer's data has changed since the proposal was minted).

Approve / Reject / Replay are admin-only (the same permission
that lets you edit layer settings).

---

## 4. When to approve vs. reject vs. wait

Heuristics:

- **Approve** when the sandbox shows a clear positive delta
  (more matched hits, the right entity surfaced, no obvious new
  failure mode) and the proposed fix matches how your layer
  actually works. Skills that document spelling aliases for
  recurring real entities are the canonical "approve" case.
- **Reject** when the proposal would conflict with how your
  layer is organised (e.g. it proposes aliasing two distinct
  customer names that you actually want kept separate), or when
  the sandbox transcripts don't actually improve on the
  current pipeline.
- **Wait** (leave as `new`) when you'd like another data point —
  e.g. when the cluster has only one or two supporting messages
  and you want to see whether the pattern persists. The
  `proposals.replan-stale` scheduled task refreshes sandbox
  evidence every 24 h for any `new` proposal older than a week,
  so the page stays meaningful even if you come back to it
  later.

The `threshold` value is the review agent's confidence — useful
as a soft signal, but it does not approve anything for you in
v1. When phase 8 ships, configuring a per-layer cutoff against
this number is what flips the "skip the approval click" gate.

---

## 5. What activation does

When you click **Approve**, three things happen in this order:

1. The system snapshots the layer's **current** capability set
   and compares it to the snapshot taken when the proposal was
   minted. Three outcomes are possible:
   - **Activated as-is** — no drift. The fix activates verbatim.
   - **Activated (re-planned)** — the capability set drifted but
     the original gap is still there. The system regenerates the
     spec once, re-runs the sandbox, and activates the new spec
     if it still shows a positive delta. A third sandbox row
     (`variant=replanned`) is added so you can see what changed.
   - **Superseded** — the drift already covers the gap (e.g. you
     activated a different proposal in the meantime that
     addresses the same failure mode), or the re-plan didn't
     improve on the original. No activation happens; the
     proposal closes as `superseded`. This is a safe outcome,
     not a failure.
2. On activation the system writes one row into the layer's
   capability registry (`layer_capabilities`) with `origin =
proposal:<id>` and `activated_at = now()`. This is the record
   that survives restarts and that the chat consults on every
   future message.
3. The chat begins consulting the new capability immediately:
   - **Skills** show up in the answerer's system prompt for the
     matching intent.
   - **Tools** become visible in the per-layer tool registry
     (the tool-calling answerer that consumes them is a separate
     follow-up; until that ships you'll see the tool listed under
     Capabilities but the answerer still runs its hard-coded
     shape).
   - **Agents** subscribe to the durable bus immediately and stay
     subscribed across restarts.

After activation, look for the `[skill:…]` / `[tool:…]` /
`[agent:…]` chips on the chat board cards — they confirm that a
real message used the capability you just approved.

---

## 6. Deactivating a capability

Visit `/l/<slug>/capabilities` to see every active capability
in the layer: name, kind, origin (`builtin` or
`proposal:<uuid>`), and activation date.

The **Deactivate** action soft-disables the capability:

- The registry stops returning it immediately. The next chat
  message will not use it.
- Agent subscribers detach from the bus on the same call.
- The row stays in the database (with `deactivated_at` set) so
  the audit trail and the proposal-detail page still show what
  was active when. The originating proposal stays as
  `activated`; the deactivate is a per-capability override.

Re-activation is not a v1 affordance — if you change your mind,
approve a new proposal addressing the same need. Phase 8's
rollback UI will fill this gap.

---

## 7. Frequently asked

- **Where does the proposal come from?** The per-layer review
  agent runs every 24 hours, looks at the last 7 days of chat
  telemetry in that layer, clusters by failure mode, and asks
  the LLM to suggest one fix per cluster.
- **Can I create a proposal myself?** Not in v1. Only the review
  agent mints proposals.
- **What happens if I never look at proposals?** Nothing
  activates. The list keeps growing until you triage it; the
  `proposals.evidence.prune` scheduled task removes the supporting
  evidence after 90 days so the database doesn't grow forever.
- **Does the chat slow down with more capabilities active?**
  Slightly — skills add a few hundred tokens to the answerer's
  prompt per matched intent. The per-proposal expected-impact
  panel shows the predicted token delta so you can decide.
- **Can a proposal leak chat content into a capability?** No.
  The spec carries the LLM-distilled problem summary and the
  alias / fragment text — never the raw user content. Supporting
  messages are linked by id, not embedded.

---

## 8. Related guides

- [`working-with-chat.md`](./working-with-chat.md) — the
  chat itself.
- [`working-with-layers.md`](./working-with-layers.md) — layer
  admin permissions (who can approve / deactivate).
- [`scheduled-tasks.md`](./scheduled-tasks.md) — the
  `chat.review-layer`, `proposals.evidence.prune`, and
  `proposals.replan-stale` schedules.
