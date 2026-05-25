# Phase 1 — Manual Electron smoke checklist

> The automated HTTP round-trip is owned by
> `apps/server/tests/smoke.test.ts` (added in phase 1.7) and runs as
> part of `bun test` / `bun run smoke`. **This document covers only the
> packaged Electron path**, because that path (sidecar lifecycle,
> per-OS data-dir, code-signing dialog, native LanceDB asset load)
> cannot be exercised in `bun test` and must be verified by a human on
> a real machine per OS.
>
> Companion: ADR 0004 (`docs/dev/decisions/0004-electron-as-thin-wrapper.md`)
> and `docs/dev/architecture/packaging.md`.

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

## Right-click context menu

The renderer installs a context-aware right-click menu in
`apps/desktop/src/context-menu.ts`. Run this checklist after the
status + chat checks above. Labels resolve through the renderer's
i18n catalogue (`apps/web/src/i18n/locales/{en,nl}.json`); set
`BUNNY2_LOCALE=nl` before launching to verify the Dutch labels.

- [ ] Right-click an empty area of the page → menu shows Back,
      Forward, Reload, View page source. Inspect element appears only
      in dev (`BUNNY2_DEV=1`).
- [ ] Select some text → right-click the selection → menu shows
      Copy and Select all (no Cut/Paste because the area is read-only).
- [ ] Focus the chat textarea → right-click it → menu shows
      Undo / Redo / Cut / Copy / Paste / Paste and match style /
      Delete / Select all. Disabled entries (e.g. Paste when the
      clipboard is empty) stay visible but are greyed out.
- [ ] Type a misspelled word in the chat textarea, right-click it →
      menu lists 1–N spelling suggestions plus "Add to dictionary".
      Clicking a suggestion replaces the misspelling.
- [ ] Right-click a link → menu shows "Open link in external browser"
      and "Copy link address". Opening sends the URL through the OS
      handler, not the Electron window.
- [ ] Right-click an image → menu shows Copy image, Copy image
      address, Save image as…. Save downloads to the OS download dir.
- [ ] Launch with `BUNNY2_LOCALE=nl` → all entries above show Dutch
      labels (Knippen / Kopiëren / Plakken / …).
- [ ] Quit and re-launch in packaged mode → no Inspect element entry.

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

---

## Results log

Record one row per verification run. Keep the latest run per OS at
the top of its section. If a follow-up was filed during the run,
reference it in the "Notes" column.

| Date       | OS      | Architecture | Tester     | Result | Notes                                                                 |
| ---------- | ------- | ------------ | ---------- | ------ | --------------------------------------------------------------------- |
| 2026-05-23 | macOS   | arm64        | maintainer | pass   | Phase 1.6 host verification; Gatekeeper warning bypassed per ADR 0004 |
| _pending_  | macOS   | x64          | _tbd_      | _tbd_  | Awaiting CI matrix or x64 host                                        |
| _pending_  | Linux   | x64          | _tbd_      | _tbd_  | Tracked: `docs/dev/follow-ups/electron-builder-ci-matrix.md`          |
| _pending_  | Linux   | arm64        | _tbd_      | _tbd_  | Optional; only if runner available                                    |
| _pending_  | Windows | x64          | _tbd_      | _tbd_  | Tracked: `docs/dev/follow-ups/electron-builder-ci-matrix.md`          |

> When a CI matrix run produces an artifact and a human downloads +
> installs + drives it through the per-OS checklist above, replace the
> matching `_pending_` row. Once every OS row is `pass`, flip tasklist
> row 1.6 from `needs-testing` to `done`.
