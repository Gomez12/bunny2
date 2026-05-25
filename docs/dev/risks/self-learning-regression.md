# Risk — Self-learning loop ships a regression

- Status: mitigated, monitored
- Owner / area: proposals + capability registry
  (`apps/server/src/proposals/`,
  `apps/server/src/http/routes/layer-proposals.ts`)
- Related: `docs/dev/plans/overall.md` §5 invariant 9, §9 (risk
  row 4);
  ADR [`0024`](../decisions/0024-sandbox-runner.md);
  ADR [`0025`](../decisions/0025-replan-on-approval.md);
  ADR [`0026`](../decisions/0026-auto-activation-gating.md);
  ADR [`0027`](../decisions/0027-manual-rollback.md);
  open follow-up
  [`proposals-auto-rollback-watcher.md`](../follow-ups/proposals-auto-rollback-watcher.md).

---

## Description

Phase 7 lets bunny2 mint and activate its own tools / skills /
agents from chat-pipeline telemetry. Phase 8 lets a scheduled job
auto-activate proposals that pass a per-layer threshold without a
human in the loop. Three ways the loop can ship a regression:

1. **A bad proposal slips through the verification gate.** The
   sandbox runner (ADR 0024) replays prompts against the current
   pipeline vs the proposed artifact and the answerer prefers the
   new artifact for the wrong reasons — non-representative
   evidence, prompt-injection in the replay set, or a metric that
   correlates with quality on the eval set but not in production.
2. **Activation widens authorization or retrieval scope.** An
   approved skill / agent reads from a layer the requesting user
   cannot see; or it bypasses `LayerResolver` (ADR 0010). See also
   `lancedb-cross-layer-leak.md`.
3. **Auto-activation snowballs.** Phase 8's
   `proposals.auto-activate` activates several proposals in one
   tick; their interactions produce worse answers than any one
   alone; no human sees them until users complain.

## Impact

High. Chat is the product surface; a regression here is visible
to every user of the affected layer. Self-learning bugs can also
silently change permission semantics (failure mode 2), which is
worse than a quality regression.

## Likelihood

Medium. Phase 7 ships with a human gate on every activation. Phase
8's auto-path adds risk but is bounded by per-layer thresholds and
defaults to off until an operator opts a layer in.

## Mitigation

### Phase 7 — human-gated verification

1. **Sandbox runner produces evidence per proposal.**
   `apps/server/src/proposals/sandbox-runner.ts` replays each
   proposal against a held-out set of recent prompts and records
   side-by-side outputs (current vs proposed). The proposal UI
   surfaces the diff; no proposal activates without the evidence
   row present. (ADR 0024.)
2. **Re-plan on approval.** When the admin approves, the system
   regenerates the artifact spec against the **current**
   capability set, not the snapshot at minting time. A proposal
   minted weeks ago against an obsolete capability cannot
   activate stale logic. (ADR 0025.)
3. **Capability registry is per-layer + UUID-identified.**
   Activation only ever attaches to one layer; nothing in phase 7
   can widen visibility beyond the layer the proposal was minted
   from. (ADR 0023 §3.)

### Phase 8 — manual rollback (already shipped)

4. **Soft-deactivate, audit-trail rollback.** `POST
/l/:slug/proposals/:id/rollback` calls
   `capabilityRegistry.deactivate({...})` and writes
   `rolled_back_at` / `rolled_back_by` / `rolled_back_reason` on
   the proposal row plus `layer_capabilities.deactivated_at`. The
   per-layer registry stops returning the capability on the next
   chat run. (ADR 0027 §1, §2.)
5. **`proposal.rolled-back` bus event.** Emitted on every
   rollback (manual today, auto when the watcher lands). Closed
   enum `artifact_kind` dimension; never carries the proposal
   payload. Future consumers (the auto-rollback watcher itself,
   external dashboards) don't have to discriminate auto/manual
   at the event boundary. (ADR 0027 §3.)
6. **Auto-activated proposals are flagged.** The proposal row
   carries `auto_activated_at` / `auto_activated_by` /
   `auto_activation_decision_json`; UI badges distinguish the
   two paths so an admin scanning a layer's activations
   immediately sees what was system-decided. (ADR 0026.)
7. **Per-layer threshold gating with safe defaults.** Phase 8's
   `evaluateAutoActivation` returns a closed-enum `Rejection`
   reason and only activates when **all** gates pass. The
   default `layer_proposal_settings` row is "manual only" —
   auto-activation is opt-in per layer. (ADR 0026 §2.)

### Phase 9 — auto-rollback watcher (deferred)

8. **Open follow-up:** scheduled
   `proposals.auto-rollback` that observes post-activation
   thumbs ratio per active proposal-origin capability and
   auto-deactivates the ones below a per-layer floor. Details in
   [`proposals-auto-rollback-watcher.md`](../follow-ups/proposals-auto-rollback-watcher.md).
   ADR 0027 §4 records the deferral; the audit columns needed
   already exist.

## What would invalidate the mitigation

- A new artifact kind (agent, skill, tool) that bypasses the
  capability registry and registers itself directly with the
  answerer / tool registry / bus subscriber. Activation hooks
  must route through `capabilityRegistry.activate(...)`;
  anything else is a deactivate-resistant footgun.
- Removing the sandbox-evidence requirement from the proposal UI
  (admins click approve without reading evidence).
- A future capability-versioning feature that adds a "restore
  previous version" path without an additional ADR — ADR 0027 §1
  rejected this on purpose.
- Auto-activation defaults flipped to on without per-layer opt-in.
