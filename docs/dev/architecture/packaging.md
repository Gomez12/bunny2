# Packaging

> Owner: phase 1.6 / 1.7. See ADR `0004-electron-as-thin-wrapper.md`
> for the why; this doc is the how.

---

## Outputs

`bun run package` produces per-OS portable artifacts:

| OS      | Targets                 |
| ------- | ----------------------- |
| macOS   | `dmg`, `zip` (per arch) |
| Linux   | `AppImage`, `tar.gz`    |
| Windows | `portable .exe`, `zip`  |

Artifacts land in `apps/desktop/release/`. Each artifact is
self-contained: bundled Bun runtime, bundled server JS, bundled web
assets, sample config. No installer; no system-Bun required.

---

## Build pipeline

```
bun run package
  └─ bun run package:prepare        (apps/desktop/scripts/prepare-resources.ts)
  │   ├─ build the Vite renderer    → apps/web/dist
  │   ├─ copy dist                  → apps/desktop/resources/web/
  │   ├─ bun build server bundle    → apps/desktop/resources/server/index.js
  │   ├─ copy SQLite migrations     → apps/desktop/resources/server/migrations/
  │   ├─ tsc compile main+preload   → apps/desktop/dist/{main,preload}.js
  │   └─ fetch Bun runtime          → apps/desktop/vendor/bun/<plat>-<arch>/bun(.exe)
  └─ electron-builder --publish=never
      ├─ packs apps/desktop/dist/   inside  asar
      ├─ copies extraResources      next to asar (resources/)
      └─ produces per-OS artifacts  in apps/desktop/release/
```

The renderer never reads disk directly. The Electron main loads
`resources/web/index.html` via `BrowserWindow.loadFile`, and the
preload exposes `window.bunny2 = { apiBase: 'http://127.0.0.1:<port>' }`
via `contextBridge`. See `apps/desktop/src/preload.ts` and
`apps/web/src/lib/api.ts`.

---

## Where things live

### In the repo

```
apps/desktop/
  src/
    main.ts                  # Electron entry, sidecar lifecycle
    preload.ts               # contextBridge: exposes apiBase
    paths.ts                 # pure resolvers (binary, server, web, sample)
    sidecar.ts               # spawn + free-port pick + buildEnv
  scripts/
    dev.ts                   # bun-native dev orchestrator (vite + server + electron)
    fetch-bun-runtimes.ts    # download Bun release artifacts
    prepare-resources.ts     # build & copy everything needed for packaging
  resources/
    config.sample.json       # copied to user's data-dir on first run
    server/                  # populated by `package:prepare`
      index.js               #   bundled server
      migrations/            #   copied SQL migrations
      lancedb.<plat>-<arch>.node  #  emitted by bun build
    web/                     # populated by `package:prepare`
      index.html …           #   built Vite renderer
  vendor/
    bun/
      darwin-aarch64/bun
      darwin-x64/bun
      linux-x64/bun
      linux-aarch64/bun
      windows-x64/bun.exe
  electron-builder.yml
  package.json
  tsconfig.json              # build (emits to dist/)
  tsconfig.checks.json       # typecheck for src + scripts + tests
```

`apps/desktop/resources/server/`, `apps/desktop/resources/web/`, and
`apps/desktop/vendor/bun/` are **generated**; they are listed in
`.gitignore` and rebuilt on every `package:prepare`.

### Inside a packaged artifact

```
<app>.app or <app>/   (depending on OS)
  Resources/
    app.asar           ← apps/desktop/dist/{main,preload}.js + package.json
    server/index.js
    server/migrations/*.sql
    server/lancedb.*.node
    web/index.html …
    config.sample.json
    bun/<plat>-<arch>/bun(.exe)
```

The main process resolves `process.resourcesPath` and walks the
flat-file siblings of `app.asar`. The Bun binary is **outside** asar
because asar files cannot be exec'd.

---

## Per-user data-dir

| OS      | Location (`app.getPath('userData')`)                |
| ------- | --------------------------------------------------- |
| macOS   | `~/Library/Application Support/bunny2/`             |
| Linux   | `~/.config/bunny2/` (Electron's default; XDG-aware) |
| Windows | `%APPDATA%\bunny2\`                                 |

On first run, `main.ts::ensureUserDataDir` creates the directory if
missing and copies `resources/config.sample.json` to
`<dataDir>/config.json`. SQLite lives at `<dataDir>/bunny2.sqlite`;
LanceDB at `<dataDir>/lancedb/`. See `apps/server/src/config/index.ts`
and `apps/server/src/storage/sqlite.ts`.

We do **not** ship an "empty data-dir" inside the artifact — there's
nothing there until the server creates the SQLite file on first
startup. Shipping an empty directory would force a copy that the OS
already does for us via the per-user path.

---

## Adding a new target

1. Add the `(platform, arch)` pair to `ALL_TARGETS` in
   `apps/desktop/scripts/fetch-bun-runtimes.ts`.
2. Verify `apps/desktop/src/paths.ts::platformTag` and `archTag`
   accept the new value; extend if needed.
3. Add the per-OS `extraResources` entry in
   `apps/desktop/electron-builder.yml` so the binary ships with that
   OS's artifact.
4. Add the OS target list (e.g. `linux.target` with the new arch).
5. Smoke-test on a host of that OS (see
   `docs/dev/testing/phase-01-electron-manual.md`).

---

## Dev mode

`bun run dev:desktop` runs the bun-native orchestrator
(`apps/desktop/scripts/dev.ts`) which:

1. Starts Vite on `:5173`.
2. Starts the Bun server on `:4317`.
3. Starts Electron with `BUNNY2_DEV=1`, `BUNNY2_SKIP_SIDECAR=1`, and
   `BUNNY2_API_BASE=http://127.0.0.1:4317`. Electron loads
   `http://localhost:5173` and the preload exposes the dev `apiBase`.

Closing the terminal sends SIGINT to the orchestrator, which stops all
three children cleanly. We deliberately avoid `concurrently` and
`npm-run-all` to keep the dev surface Bun-native and cross-platform.

---

## Known gaps (phase 1.6)

- macOS code signing + notarization are off. Users will see a
  Gatekeeper warning on first run. Tracked:
  `docs/dev/follow-ups/electron-signing.md`.
- Bun runtime hashes are not verified at download time. Tracked:
  `docs/dev/follow-ups/bun-runtime-hashes.md`.
- A CI matrix that builds for all three OSes is a phase 1.7 deliverable.
  Tracked: `docs/dev/follow-ups/electron-builder-ci-matrix.md`.
- The dev orchestrator does not currently watch + restart the server
  on source changes; restart it manually. Tracked:
  `docs/dev/follow-ups/desktop-dev-restart.md`.
