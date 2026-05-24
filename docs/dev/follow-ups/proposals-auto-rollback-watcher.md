# Follow-up — Auto-rollback watcher

- Status: open
- Created: 2026-05-25 (phase 8 close-out, ADR 0027 §4)
- Phases referencing it: 8, 9+

## What remains

Phase 8 ships **manual** rollback only
(`POST /l/:slug/proposals/:id/rollback`, ADR 0027). The next step is
a scheduled job — call it `proposals.auto-rollback` — that observes
the post-activation thumbs ratio of every active proposal-origin
capability and auto-deactivates the ones that fall below a
per-layer floor.

The audit data the watcher needs already lands in phase 8:

- `improvement_proposals.auto_activated_at` /
  `auto_activated_by` / `auto_activation_decision_json` (ADR 0026).
- `improvement_proposals.rolled_back_at` / `rolled_back_by` /
  `rolled_back_reason` (ADR 0027 decision 2).
- The `proposal.rolled-back` bus event (closed-enum
  `artifact_kind` dimension) — phase-8 emits it but no consumer
  exists yet; the watcher would be the first.

## Why not done now

ADR 0027 decision 4 records the deferral. The watcher needs a
tuned floor (thumbs ratio across what window?), a confidence
model (don't roll back on a single thumbs-down), and per-
`artifact_kind` logic (deactivating an `agent` mid-flight may
emit a final flurry of events). Phase 8's exit criterion is
"runs safely for a week with zero rollbacks needed in dogfood
use"; manual rollback ships first so humans observe outcomes
during dogfood, and the watcher can then be designed against
real data instead of guessed at.

## Next step

1. Add a `proposals.auto-rollback` scheduled-task kind, default
   cadence 1 h, `--role=worker`, register through the existing
   `register…Handler` pattern (mirror `proposals.auto-activate`).
2. Walk every `status='activated'` proposal whose origin
   capability is still active (i.e. `rolled_back_at IS NULL` and
   `layer_capabilities.deactivated_at IS NULL`).
3. Compute the post-activation thumbs ratio over the configured
   window (per-layer setting, default 7 d).
4. If the ratio drops below the per-layer floor (default 0.4),
   call the same primitives the manual route uses:
   `capabilityRegistry.deactivate(...)` +
   `proposalsRepo.recordRollback(...)` with a synthetic reason
   like `auto: thumbs ratio <floor> over <window>` —
   `rolled_back_by` records the system actor literal (mirror
   ADR 0026 §3's discriminator union).
5. Publish `proposal.rolled-back` exactly as the manual route
   does so external consumers don't have to discriminate
   auto/manual at the event boundary.
6. Telemetry: `proposal.auto-rollback.decided_count`
   dimensioned by `decision: 'rolled-back' | 'kept'` and
   `artifact_kind`; never use proposal id / layer id as a
   label.

## Related files / docs

- `docs/dev/decisions/0027-manual-rollback.md` §4 — records
  the deferral.
- `docs/dev/decisions/0026-auto-activation-gating.md` decision 3
  — pattern for the `SYSTEM_ACTOR` literal the watcher will
  reuse.
- `apps/server/src/proposals/auto-activate-handler.ts` — the
  watcher is structurally a sibling of this handler.
- `apps/server/src/http/routes/layer-proposals.ts` — the
  rollback route the watcher would re-use the primitives from.
- `docs/dev/architecture/job-inventory.md` — needs a row when
  the watcher lands.
