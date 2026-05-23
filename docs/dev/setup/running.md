# Running bunny2

Companion to `docs/dev/setup/installation.md`. Once installed, this is
the script-by-script tour of what runs and where.

For the manual Electron checklist (per-OS verification of a packaged
artifact), see `docs/dev/testing/phase-01-electron-manual.md`.

---

## Quick reference

| Script                 | What it does                                                                                 | Use when                                                       |
| ---------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `bun run dev:server`   | Watches and runs `apps/server/src/index.ts`.                                                 | Hacking on the backend without Electron.                       |
| `bun run dev:web`      | Vite dev server on `:5173` for `apps/web`.                                                   | Hacking on the renderer; needs a server reachable at `:4317`.  |
| `bun run dev:desktop`  | Orchestrates Vite + server + Electron together via `apps/desktop/scripts/dev.ts`.            | Full Electron loop with hot UI reload.                         |
| `bun run smoke`        | Runs only `apps/server/tests/smoke.test.ts`.                                                 | Quickly verify the end-to-end spine after touching wiring.     |
| `bun test`             | Runs every workspace's tests.                                                                | Pre-commit / pre-PR.                                           |
| `bun run typecheck`    | `tsc --noEmit` across all workspaces.                                                        | Pre-commit / pre-PR.                                           |
| `bun run lint`         | ESLint across `.`.                                                                           | Pre-commit / pre-PR.                                           |
| `bun run format`       | Prettier write across `.`.                                                                   | Apply formatting locally.                                      |
| `bun run format:check` | Prettier check; fails on drift.                                                              | Pre-PR.                                                        |
| `bun run docs:check`   | Lightweight docs invariants (`scripts/docs-check.ts`).                                       | Pre-PR. Catches stale `done` plans and tasklist overflow.      |
| `bun run i18n:check`   | Missing-key + hardcoded-string check for the renderer.                                       | Pre-PR.                                                        |
| `bun run replay`       | Re-emits the SQLite event log into a fresh `InMemoryMessageBus` (`scripts/replay.ts`).       | Investigating event-sourcing behavior; demoing replay.         |
| `bun run build`        | Per-workspace `build` (server bundle, renderer bundle, electron main+preload).               | CI; pre-PR sanity. Does **not** package the Electron artifact. |
| `bun run package`      | Chains `package:prepare` (bundles + Bun runtime fetch) + `electron-builder` for the host OS. | Producing a portable artifact in `apps/desktop/release/`.      |

---

## Dev modes in detail

### Backend only — `bun run dev:server`

Runs the Bun HTTP server on `http://127.0.0.1:4317` against the
default `mock://echo` LLM. Useful for backend work in isolation:

```bash
bun run dev:server
# in another shell
curl http://127.0.0.1:4317/status
curl -X POST http://127.0.0.1:4317/chat \
  -H 'content-type: application/json' \
  -d '{"message":"hello"}'
```

The server writes everything under `./.data` by default (gitignored).
Delete `./.data` to reset state.

### Frontend only — `bun run dev:web`

Vite on `:5173`. The renderer reads `VITE_API_BASE` (or falls back to
`http://127.0.0.1:4317`); start `dev:server` in another shell so the
fetches succeed. CORS is already configured for `localhost` /
`127.0.0.1` (ADR 0006 §CORS).

### Full Electron loop — `bun run dev:desktop`

Spawns Vite, the Bun server, and Electron together. The orchestrator
sets `BUNNY2_DEV=1`, `BUNNY2_SKIP_SIDECAR=1`, and `BUNNY2_API_BASE` so
Electron loads `http://localhost:5173` and the preload exposes the dev
API base via `contextBridge`. Ctrl+C tears all three down cleanly.

Server source changes are **not** hot-reloaded by the orchestrator —
restart the dev session. Tracked in
`docs/dev/follow-ups/desktop-dev-restart.md`.

---

## Tests

`bun test` runs every workspace's tests. The interesting paths:

- `apps/server/tests/smoke.test.ts` — the phase-1 spine test
  (`bun run smoke`). Drives `loadConfig` → SQLite + LanceDB → bus →
  telemetry-wrapped LLM → `createApp().fetch` → `/status` and `/chat`.
- `apps/server/tests/http-chat.test.ts` — focused HTTP integration
  tests for `POST /chat` (success, error, override, malformed body).
- `apps/server/tests/llm-*.test.ts` — telemetry, mock provider,
  OpenAI-compatible provider, prune job.
- `apps/server/tests/migrations.test.ts` — applies / replays the
  migration set on a temp DB.
- `apps/server/tests/event-log.test.ts` — bus + sqlite event log.
- `apps/desktop/tests/*` — pure helpers (path resolvers, sidecar env
  builder). No Electron driver in phase 1.

The smoke test allocates a fresh temp dir under `os.tmpdir()` and
points `BUNNY2_DATA_DIR` at it; nothing under `./.data` is touched.

---

## Packaging

```bash
bun run package
```

Produces a per-OS artifact under `apps/desktop/release/` for the host
OS. The CI matrix in `.github/workflows/release.yml` builds the full
matrix (macOS + Linux + Windows) on tag push or
`workflow_dispatch`.

For the breakdown of what `package:prepare` and `electron-builder` do,
see `docs/dev/architecture/packaging.md`. For the manual verification
checklist after building, see
`docs/dev/testing/phase-01-electron-manual.md`.

---

## Resetting state

bunny2 owns its state entirely under the data-dir. To reset:

```bash
# Dev (default data-dir)
rm -rf ./.data

# Packaged (per OS, after closing the app)
# macOS:    rm -rf "~/Library/Application Support/bunny2"
# Linux:    rm -rf "~/.config/bunny2"
# Windows:  remove %APPDATA%\bunny2 via Explorer
```

Re-launching recreates the SQLite + LanceDB + (packaged) `config.json`
from scratch.
