# Phase 1.6 — Manual Electron smoke checklist

> Phase 1.7 will add an automated smoke test that drives the round-trip
> via HTTP. Until then this checklist is the source of truth for "does
> the packaged app actually work on this OS".

---

## Prerequisites

- Node-side dev deps installed: `bun install`
- For the host you are testing on, the Bun runtime artifact is downloaded:
  `bun run --filter '@bunny2/desktop' fetch-bun`
- Disk space: ~400 MB for the build, ~150 MB for the artifact.

## Build

```bash
bun run package
```

On the developer's host this:

1. Builds the web bundle (`apps/web/dist`).
2. Bundles the server (`apps/desktop/resources/server/index.js`).
3. Compiles Electron main + preload (`apps/desktop/dist/`).
4. Fetches the Bun runtime for the host platform.
5. Runs `electron-builder` to produce per-OS artifacts in
   `apps/desktop/release/`.

If step 5 fails because the host can't cross-compile to another OS,
the in-repo bundle (`apps/desktop/resources/server/index.js`) and the
fetched Bun runtime are still usable for a local sanity run:

```bash
bun apps/desktop/resources/server/index.js
```

This is also the easiest way to reproduce a server-side bug from a
packaged build without re-running `electron-builder`.

---

## Per-OS checklist

For each OS this section is repeated. Tick each box.

### macOS

- [ ] `apps/desktop/release/bunny2-<version>-<arch>.dmg` exists.
- [ ] Mount the DMG and copy `bunny2.app` to `/Applications`.
      (Gatekeeper warning expected — see ADR 0004 §Consequences.
      Right-click → Open to bypass for phase 1.)
- [ ] Launch the app. A 1280×800 window opens.
- [ ] The status page loads. `dataDir` shows
      `~/Library/Application Support/bunny2`.
- [ ] `~/Library/Application Support/bunny2/config.json` was created
      and matches `apps/desktop/resources/config.sample.json`.
- [ ] Switch to the chat tab. Send `hello`. You see a localized
      response from the `mock://echo` provider.
- [ ] Quit (`Cmd+Q`). `~/Library/Application Support/bunny2/bunny2.sqlite`
      exists. Open with `sqlite3` and confirm `SELECT COUNT(*) FROM
llm_calls;` returns at least 1.
- [ ] Re-launch. Status page shows the increased `llm.calls` count.

### Linux

- [ ] `apps/desktop/release/bunny2-<version>.AppImage` exists.
- [ ] `chmod +x` the AppImage; double-click or run from a terminal.
- [ ] A 1280×800 window opens.
- [ ] `~/.config/bunny2/config.json` was created (XDG default; see
      `app.getPath('userData')`).
- [ ] Status + chat work as in macOS.
- [ ] `~/.config/bunny2/bunny2.sqlite` contains an `llm_calls` row.

### Windows

- [ ] `apps/desktop/release/bunny2-<version>-portable.exe` exists.
- [ ] Run from a non-admin user account. (SmartScreen warning expected.)
- [ ] A 1280×800 window opens.
- [ ] `%APPDATA%\bunny2\config.json` was created.
- [ ] Status + chat work.
- [ ] `%APPDATA%\bunny2\bunny2.sqlite` contains an `llm_calls` row.
- [ ] No Bun process is left running after closing the window
      (Task Manager).

---

## What to do when something fails

- **App launches but the renderer shows "Network error":** the sidecar
  failed to start. Open DevTools (`Cmd/Ctrl+Shift+I`) or inspect the
  terminal where the app was launched. Common causes:
  - The Bun binary is missing from `Resources/bun/<plat>-<arch>/`. Run
    `bun run --filter '@bunny2/desktop' fetch-bun` and repackage.
  - On macOS, the Bun binary lost its executable bit during the zip
    round-trip. `main.ts::ensureBunExecutable` `chmod`s it on launch;
    if that's failing, check the log line `[bunny2] bun: <path>` and
    `chmod 755` the file manually as a workaround.
  - Port 4317 is taken; the main probes a free port via
    `pickFreePort`. The app log shows which port was actually picked.

- **LanceDB native module fails to load:** the
  `lancedb.<plat>-<arch>.node` asset is missing from
  `Resources/server/`. The `bun build` step should have emitted it;
  re-run `bun run package:prepare` and inspect
  `apps/desktop/resources/server/`. If LanceDB blocks Windows
  packaging entirely, set `BUNNY2_DISABLE_LANCEDB=1` to skip
  initialization (follow-up task — not implemented yet; see
  `docs/dev/follow-ups/lancedb-windows.md`).

- **Hot-reload not picking up server changes in dev:** the
  orchestrator does not restart the server on source changes. Kill
  the dev session with Ctrl+C and re-run. Tracked in
  `docs/dev/follow-ups/desktop-dev-restart.md`.
