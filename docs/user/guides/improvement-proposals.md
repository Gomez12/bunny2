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
  attached to the proposal. By default the activation gate is
  always your approval click; once auto-activation is enabled on
  the layer (§7) the threshold becomes one of the seven gates
  that decide whether the proposal qualifies for the auto-path.

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
as a soft signal. When auto-activation is enabled on a layer
(§7), the per-layer cutoff against this number is what flips the
"skip the approval click" gate; otherwise the threshold stays
informational.

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
approve a new proposal addressing the same need. (Phase 8 ships a
sibling **Rollback** affordance on the proposal detail page; see
§7 below for the layer-admin walkthrough.)

---

## 7. Auto-activation (Phase 8)

### What it is

Above-threshold proposals can activate **automatically** per layer.
The same sandbox evidence and the same `replanOnApproval` machinery
the approve button uses still runs — the auto-path just skips your
click when the proposal clears a seven-gate quality bar you
configured. Auto-activation is **off by default** on every layer;
no proposal activates without your opt-in.

### Settings page

Open **Layer settings → Proposals** (`/l/<slug>/settings/proposals`).
Each control:

- **Enable auto-activation for this layer.** The master switch. Off
  by default. With this off, every proposal still needs your
  manual approve click (phase-7 behavior, unchanged).
- **Threshold cutoff** (0.00 – 1.00, default 1.00). Proposals whose
  threshold is **at or above** this value qualify for auto-
  activation. The default 1.00 means "nothing ever qualifies"; you
  start at 1.00 and lower it once you've watched a few proposals
  and trust the review agent's self-rating on your data.
- **Cooldown hours** (default 24). How long after a proposal is
  minted before the auto-activate job will consider it. The
  cooldown is the window where you (or another admin) can read
  the sandbox evidence and intercept — reject the proposal, or
  click approve manually — before the system acts on it.
- **Require thumbs-up delta &gt; 0** (default on). Even if the
  threshold + cooldown clear, the sandbox must have shown the
  proposal making _more_ chat messages succeed, not fewer. Turn
  off only if you genuinely want token-cost-driven activations
  with no quality floor.
- **Cap tokens delta at …** (default off). Optionally reject any
  proposal whose sandbox showed the answerer's prompt growing by
  more than this many tokens per message. Useful when chat cost
  budget matters more than feature breadth.

Settings are admin-only. Non-admin members of the layer can read
them but the form is disabled.

### The cooldown window

The auto-activate job runs hourly. A proposal minted at 14:00
with a 24h cooldown will not auto-activate before tomorrow 14:00,
which leaves a full day for you to read the sandbox evidence and
reject anything that looks wrong. The cooldown is enforced **per
proposal**, not per job run — pausing the job doesn't reset
anyone's clock. The user guide §3 detail page is the right place
to read the evidence in that window.

### What you see on auto-activated proposals

Once a proposal auto-activates:

- The **Proposals** list shows an **auto** chip in the Source
  column for that row (rows you approved manually carry a
  **manual** chip).
- The detail page renders a collapsible **Auto-activation
  decision** panel: one row per gate, each with a green or red
  icon, the threshold and observed values, and the closed-enum
  gate name (so you can search support docs by name if a gate
  ever surprises you).
- The capability shows up on `/l/<slug>/capabilities` exactly
  as it does after a manual approve — there is no second-class
  "auto-only" capability; everything downstream of activation is
  the same code path.

### Rollback

Every `activated` proposal — auto **or** manual — carries a
**Rollback** button on the detail page (admin-only). Click it,
type a reason (required, 5 characters minimum), confirm. The
linked capability soft-deactivates immediately (the registry
stops returning it on the next chat run; agent subscribers
detach on the same call). The proposal row records **who** rolled
back, **when**, and **why** so the audit trail is intact.

Rollback is **not** undoable — a rolled-back proposal stays
terminal. If you change your mind, the next review-agent run on
the same failure mode will mint a fresh proposal you can approve.
The reason text stays on the row only; it is never written to
operational logs, telemetry, or analytics, so you can be specific
about why a capability misbehaved without worrying about it
leaking.

### What's NOT in phase 8

Phase 8 ships **manual** rollback only. A scheduled
auto-rollback watcher that observes the post-activation thumbs
ratio and rolls capabilities below a per-layer floor is on the
phase-9 roadmap; the audit columns + bus events shipped here are
the data foundation it will consume.

---

## 8. Frequently asked

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

## 9. Related guides

- [`working-with-chat.md`](./working-with-chat.md) — the
  chat itself.
- [`working-with-layers.md`](./working-with-layers.md) — layer
  admin permissions (who can approve / deactivate).
- [`scheduled-tasks.md`](./scheduled-tasks.md) — the
  `chat.review-layer`, `proposals.evidence.prune`, and
  `proposals.replan-stale` schedules.
