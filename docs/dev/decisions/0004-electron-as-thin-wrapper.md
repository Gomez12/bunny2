# ADR 0004 — Electron as a thin wrapper, with the Bun server as a sidecar

- Status: accepted
- Date: 2026-05-23
- Phase: 1.6
- Related: `docs/dev/plans/overall.md` §4, §10.6; `docs/dev/plans/phase-01-system-foundation.md` §4.2 row "1.6", §10 row 3 (packaging risk); `docs/dev/architecture/packaging.md`.

---

## Context

Phase 1.6 ships the first end-to-end packageable build: an Electron app
that the user opens, a Bun server that the app spawns as a child
process, and a Vite-built renderer loaded from disk. We need to decide:

1. How thick is the Electron layer — does it own business logic, or only
   the window + sidecar lifecycle?
2. How does the Bun server ship on each OS — bundled-with-Bun, native
   compiled binary, or "user must install Bun"?
3. Which packager builds the per-OS artifacts?

Constraints inherited from the overall plan:

- Portable per-OS distribution (`overall.md` §4): macOS, Linux, Windows.
- No mandatory installer; the artifact should run from any directory.
- Single source of truth in TypeScript; no UI logic duplicated between
  Electron main and the React renderer.
- Phase-1 builds must work on the developer's host without a CI matrix
  (CI matrix is a 1.7 concern).

## Decision

### 1. Electron is a thin wrapper

The Electron main process owns four things and nothing else:

1. The application window (`BrowserWindow` with `contextIsolation: true`,
   `nodeIntegration: false`, a preload that exposes only the API base
   URL via `contextBridge`).
2. The Bun sidecar lifecycle: spawn on `app.whenReady`, kill on quit /
   `window-all-closed` / `SIGTERM` / `SIGINT`.
3. Per-OS data-dir resolution via `app.getPath('userData')`.
4. First-run config seeding: copy `resources/config.sample.json` into
   the user's data-dir as `config.json` if absent.

All business logic — config loading, storage, the event bus, the LLM
client, HTTP routing — lives in `apps/server`. The renderer talks to
the server **only** over HTTP. No IPC channel, no `ipcMain` handlers.
This is what "thin wrapper" means here: if Electron were swapped for a
different shell (Tauri, a native menu-bar app, a browser tab pointed
at the local server), nothing in `apps/server` or `apps/web` would
change.

### 2. The Bun server ships as a single bundled JS file plus the Bun runtime

Three options were considered:

- **(a)** `bun build --compile` to a single OS-native binary. Rejected
  for phase 1: the compiled-binary path interacts awkwardly with
  LanceDB's native `.node` asset (the `.node` file still ships next to
  the binary, so the "single file" benefit is largely lost), and
  cross-compilation from macOS to Linux/Windows is still rough.
- **(b)** Require the user to have Bun installed. Rejected: violates
  "portable, no install" from `overall.md` §4.
- **(c)** Bundle the Bun runtime alongside the Electron app and run
  `bun resources/server.js`. **Picked.**

For (c), we run `bun build apps/server/src/index.ts --target=bun
--outdir=apps/desktop/resources` to produce `index.js` plus any native
assets (LanceDB ships `lancedb.<platform>-<arch>.node` next to it).
The SQLite `migrations/` directory is copied next to the bundle so the
runtime resolver in `apps/server/src/storage/sqlite.ts` finds the SQL
files via `import.meta.url`. The Bun runtime is fetched per target by
`apps/desktop/scripts/fetch-bun-runtimes.ts` from the official Bun
releases and placed under `apps/desktop/vendor/bun/<platform>-<arch>/`.
`electron-builder` includes the current-target Bun binary in
`extraResources` so packaged artifacts stay small (~50–100 MB per
target instead of carrying every platform's runtime).

### 3. electron-builder is the packager

electron-builder is the most-used Electron packager, supports macOS
DMG/ZIP, Linux AppImage/tar.gz, and Windows portable EXE/ZIP out of
the box, and lets us declare per-OS `extraResources` so we only ship
the runtime that matches the target. Notable alternatives considered:

- `electron-forge`: comparable; we picked `electron-builder` for
  per-OS `extraResources` ergonomics and the `portable` Windows target,
  which matches our "no installer" goal directly.
- Hand-rolled zip-up scripts: rejected — we'd reimplement asar, code
  signing hooks (deferred but not removed), and platform packaging
  metadata.

### 4. Port discovery via env, not stdout parsing

The Electron main probes a free port via `net.createServer().listen(0)`
on the loopback interface, then passes `BUNNY2_HTTP_PORT=<port>` to the
sidecar. The server config layer (added in 1.6,
`apps/server/src/config/index.ts::applyHttpEnvOverrides`) reads
`BUNNY2_HTTP_PORT` and `BUNNY2_HTTP_HOST` and overrides the schema
defaults. This is deterministic and race-free; stdout parsing was
considered and rejected (buffering + log-format drift make it brittle).

### 5. Renderer reads the API base URL from a preload-injected global

The Electron preload exposes `window.bunny2 = { apiBase }` via
`contextBridge`. The web app's `apps/web/src/lib/api.ts` reads the
global when present (Electron build), falls back to
`import.meta.env.VITE_API_BASE` (Vite-dev build), and finally to the
schema default `http://127.0.0.1:4317`. Picked over a query-string
parameter because the bundled file is loaded via `loadFile`, and over
a JSON config file because the renderer cannot read disk.

**How the preload receives the value.** The main process passes the
URL through `BrowserWindow.webPreferences.additionalArguments` as the
flag `--bunny2-api-base=<url>`; `preload.ts` parses it from
`process.argv`. We do **not** rely on `process.env` because Electron's
sandboxed preload (`sandbox: true`) only exposes a stripped-down
`process` object — `process.env` is undefined, but `process.argv`
remains. Using argv avoids a silent fallback to the default URL when
the sidecar binds to a non-default port.

## Consequences

**Positive**

- The Electron layer is small enough that 1.6's tests focus on pure
  resolver logic (binary path per platform, env build) rather than a
  flaky end-to-end Electron driver. Phase 1.7's smoke test exercises
  the round-trip via HTTP, which is the real contract.
- The same Bun bundle runs in dev and packaged contexts; reproducing a
  bug from a packaged artifact is just `bun resources/server.js`.
- The server's source tree never knew about Electron; future phases can
  swap the shell with zero server changes.

**Negative / accepted**

- Bundle size: each target ships its own Bun runtime (~50–60 MB per
  platform) plus LanceDB's native `.node` (~60 MB). Phase 1 accepts
  this; phase 1+ can revisit by either compiling the server (`bun
build --compile`) or stripping LanceDB if it's not needed at runtime.
- macOS code signing and notarization are deferred. Users on macOS
  will see a Gatekeeper warning on first run. Tracked in
  `docs/dev/follow-ups/electron-signing.md`.
- Windows packaging on a non-Windows host produces a `portable` EXE
  using Wine if available; CI matrix in phase 1.7 will validate the
  real Windows build.

## Alternatives considered

1. **Tauri + Rust shell.** Smaller artifact, but the renderer would
   still talk HTTP to a Bun sidecar — same shape, different shell. Not
   a phase-1 win.
2. **Single Electron process running the server in-process.** Would
   couple the renderer to the main process and force us to either
   reimplement Bun's runtime in Node or ship a Bun bridge. Rejected:
   destroys the "thin wrapper" property.
3. **`bun build --compile` single binary.** Considered for the server
   bundle; defer to phase 2+ once we know whether the native LanceDB
   asset survives compilation cleanly on every target.

## Follow-ups

- `docs/dev/follow-ups/electron-signing.md` — macOS notarization and
  Windows code signing.
- `docs/dev/follow-ups/electron-builder-ci-matrix.md` — phase 1.7 CI
  matrix that runs the real Linux/Windows builds.
- `docs/dev/follow-ups/bun-compile-server.md` — try `bun build
--compile` once the LanceDB native-asset story is mature.
