# bunny2

Internal agent tool — portable, multi-user, multi-language, layered,
AI-enhanced.

This repo is in **phase 1** of [the overall plan](./docs/dev/plans/overall.md).
Phase 1 stands up the system foundation: Bun server, Vite + React UI,
Electron wrapper, SQLite + LanceDB in a portable data-dir, event-sourced
message bus, and an OpenAI-compatible LLM client with 100% telemetry.

## Quick start

Prereqs: [Bun](https://bun.sh) ≥ 1.3.

```bash
bun install
bun run typecheck
bun run lint
bun test
```

Workspaces:

- `apps/server` — Bun HTTP + bus + storage + LLM.
- `apps/web` — Vite + React UI.
- `apps/desktop` — Electron wrapper (thin, no business logic).
- `packages/shared` — types, schemas, i18n keys.
- `packages/bus` — `MessageBus` interface + adapters.

## Docs

- [Overall plan](./docs/dev/plans/overall.md)
- [Phase 1 plan](./docs/dev/plans/phase-01-system-foundation.md)
- [Tasklist](./docs/dev/tasklist.md)
- Project rules: [`AGENTS.md`](./AGENTS.md)
