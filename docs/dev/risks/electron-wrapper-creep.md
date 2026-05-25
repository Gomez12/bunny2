# Risk — Electron wrapper accumulates logic

- Status: invariant held; ongoing review required
- Owner / area: desktop app (`apps/desktop/src/`)
- Related: `docs/dev/plans/overall.md` §9 (risk row 5);
  ADR [`0004`](../decisions/0004-electron-as-thin-wrapper.md);
  `docs/dev/architecture/packaging.md`.

---

## Description

ADR 0004 fixes a hard rule: the Electron main process owns the
window, the Bun sidecar lifecycle, per-OS data-dir resolution,
and first-run config seeding. **Everything else** — config
loading, storage, the bus, the LLM client, HTTP routing,
business logic — lives in `apps/server`. The renderer talks to
the server only over HTTP; there is no `ipcMain` business
channel.

The risk is gradual erosion. Each individual "small" Electron-only
feature is locally reasonable; collectively they break the
shell-portable property (Tauri, browser-tab, native menu-bar
shell can all swap in if and only if the server alone holds the
domain logic).

Concrete creep shapes seen across projects of this kind:

1. **An IPC channel to "speed up" a UI call** that's already a
   server route. Renderer → preload → main → server (or
   worse, → SQLite directly) bypasses the HTTP boundary and
   couples the renderer to Electron.
2. **A "convenience" main-process feature** (file-system browse,
   shell exec, OS notifications, native dialogs) that does
   business work the server should own (path validation,
   permission checks, audit log).
3. **`nodeIntegration: true`** or `contextIsolation: false` on
   any window — every "just for dev" lapse turns into "we kept
   it in prod".
4. **Renderer reading state from a preload global** beyond the
   one ADR-sanctioned `window.bunny2 = { apiBase }` channel.

## Impact

Medium. No immediate security or correctness regression, but
each violation:

- Forces the same logic to be implemented twice (web build vs
  Electron build), or kills the web build entirely.
- Makes the desktop bundle bigger and slower to ship.
- Couples the project to Electron's release cadence and
  security CVEs in a way `apps/server` cannot mitigate.
- Erodes the test story (server unit tests no longer cover the
  desktop code paths).

## Likelihood

Medium. The invariant currently holds — see "Current state"
below — but every desktop-only feature request is a candidate
for creep.

## Mitigation

### Architectural rules (ADR 0004)

1. **Renderer → server is the only domain channel.** HTTP only;
   no domain IPC handler in main.
2. **`contextIsolation: true`, `nodeIntegration: false`,
   `sandbox: true`** on every `BrowserWindow`. Preload exposes
   only `window.bunny2 = { apiBase }` via `contextBridge`.
3. **Main owns four things and nothing else.** Window lifecycle;
   sidecar lifecycle; data-dir resolution; first-run config
   seeding.
4. **Preload reads its config from `process.argv`**, not
   `process.env` — sandboxed preload has no `process.env`.

### Current state (as of phase 8 close-out)

`apps/desktop/src/` files and their roles:

- `main.ts` (249 lines) — window + sidecar lifecycle, the
  `nativeTheme.themeSource` bridge for the explicit
  light/dark/system theme switch (a renderer
  preference forwarded one-way to the OS chrome — does **not**
  carry domain state).
- `sidecar.ts` (164 lines) — Bun sidecar spawn / kill /
  port discovery via `BUNNY2_HTTP_PORT` env.
- `preload.ts` (57 lines) — the single
  `window.bunny2 = { apiBase }` `contextBridge` exposure,
  parsing `--bunny2-api-base=<url>` from `process.argv`.
- `paths.ts` (102 lines) — per-OS data-dir resolution.
- `i18n.ts` (163 lines) — locale loading **for the native
  context menu and OS-level strings only** (cut / copy / paste,
  spellcheck suggestions). UI strings are in `apps/web`.
- `context-menu.ts` (338 lines) — right-click menu (cut / copy /
  paste, undo / redo, links, images, spellcheck, reload,
  Inspect Element in dev). All actions delegate to the
  renderer (`webContents.cut()`, `openExternal`, etc.) — no
  domain side effects.

No `ipcMain.handle(...)` is registered for domain operations;
the only IPC is whatever Electron's built-in `webContents`
plumbing already does for the context menu.

### Reviewer checklist (apply to every desktop PR)

- Does this PR introduce an `ipcMain` channel that carries
  domain data? If yes, push the logic into `apps/server`.
- Does the renderer code change to import `electron`, or to
  read a new field from `window.bunny2`? If yes, prove the
  feature still works in the web build.
- Does the preload expose a new global? If yes, justify why it
  cannot be an HTTP call.
- Did `contextIsolation`, `nodeIntegration`, or `sandbox`
  change? Any relaxation needs an ADR amendment.
- Does main spawn a process other than the Bun sidecar? If
  yes, defend it in the PR.

## What would invalidate the mitigation

- Any new `ipcMain` channel that handles domain data (entity
  CRUD, auth, layers, anything routed by `apps/server/src/http`).
- A second window with relaxed `webPreferences`.
- A renderer code path that branches on "running in Electron"
  for domain logic (UI affordances that depend on the shell are
  fine; domain branches are not).
- Removing or weakening
  [`apps/desktop/tests/`](../../apps/desktop/tests/) coverage
  of `paths`, `sidecar`, `i18n`, `context-menu` — those tests
  pin the wrapper's intended surface.
