# Tasklist

See `AGENTS.md` for format and rules. Keep at most 50 `done` rows
here; move older done rows to `docs/dev/tasklistarchive.md`.

| Status | Related document                                | Estimated work | Description                                                                                         |
| ------ | ----------------------------------------------- | -------------: | --------------------------------------------------------------------------------------------------- |
| done   | docs/dev/plans/overall.md                       |             2h | Write overall plan from `originalplan.md`                                                           |
| done   | docs/dev/plans/overall.md                       |           0.5h | Answer open questions in overall plan §10                                                           |
| done   | docs/dev/plans/phase-01-system-foundation.md    |             2h | Write phase-1 detail plan                                                                           |
| done   | docs/dev/plans/phase-01-system-foundation.md    |             4h | Phase 1.1: repo skeleton + Bun/TS workspaces + lint/format/typecheck/test + CI baseline             |
| done   | docs/dev/plans/phase-01-system-foundation.md    |             6h | Phase 1.2: config loader + data-dir bootstrap + SQLite migrations + LanceDB init                    |
| done   | -                                               |           0.1h | Chore: gitignore local tooling dirs (`.claude/`, `.understand-anything/`)                           |
| done   | docs/dev/plans/phase-01-system-foundation.md    |             8h | Phase 1.3: `MessageBus` interface + in-memory adapter + event-log persistence + replay + middleware |
| done   | docs/dev/plans/phase-01-system-foundation.md    |             6h | Phase 1.4: OpenAI-compatible LLM client + 100% logging + cost/tokens + retention prune              |
| open   | docs/dev/plans/phase-01-system-foundation.md    |             8h | Phase 1.5: HTTP API + Vite/React/Tailwind/shadcn frontend + i18n + status + chat round-trip         |
| open   | docs/dev/plans/phase-01-system-foundation.md    |             8h | Phase 1.6: Electron wrapper + Bun sidecar + portable per-OS packaging                               |
| open   | docs/dev/plans/phase-01-system-foundation.md    |             4h | Phase 1.7: end-to-end smoke test + dev docs + ADRs                                                  |
| open   | docs/dev/plans/phase-02-users-and-groups.md     |          (tbd) | Phase 2 detail plan: users, groups, auth                                                            |
| open   | docs/dev/plans/phase-03-layers.md               |          (tbd) | Phase 3 detail plan: layers and per-layer scoping                                                   |
| open   | docs/dev/plans/phase-04-first-entities.md       |          (tbd) | Phase 4 detail plan: companies, contacts, calendar, todos                                           |
| open   | docs/dev/plans/phase-05-scheduled-tasks.md      |          (tbd) | Phase 5 detail plan: general scheduled tasks                                                        |
| open   | docs/dev/plans/phase-06-super-chat.md           |          (tbd) | Phase 6 detail plan: super chat pipeline                                                            |
| open   | docs/dev/plans/phase-07-self-learning.md        |          (tbd) | Phase 7 detail plan: user-verified self-learning                                                    |
| open   | docs/dev/plans/phase-08-threshold-automation.md |          (tbd) | Phase 8 detail plan: threshold-automated self-learning                                              |
