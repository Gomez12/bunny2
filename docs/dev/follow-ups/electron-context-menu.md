# Follow-up — Electron renderer needs a useful right-click menu

- Status: open
- Created: 2026-05-24 (user request, no prior coverage)
- Phases referencing it: 1.6 (Electron wrapper landed without one)

## What remains

The current Electron `BrowserWindow` (`apps/desktop/src/main.ts:151`)
ships with **no `context-menu` handler**. Right-click in the renderer
either does nothing or shows whatever Chromium's bare default is
(usually nothing in a sandboxed renderer). Users that drop out of the
app to copy a value or hit reload have to use keyboard shortcuts,
which is friction — and a missing **Inspect Element** entry is the
single biggest annoyance when debugging a packaged build.

Goal: register a `web-contents.on('context-menu', …)` handler in the
main process that opens an `electron.Menu.buildFromTemplate(...)` with
the items below. Items are context-aware (the `params` object from the
event carries `editFlags`, `mediaType`, `linkURL`, `selectionText`,
`misspelledWord`, `dictionarySuggestions`).

## Proposed menu

Grouped roughly by Chromium's own conventions; separators between
groups. Items shown only when the context makes them meaningful (use
`editFlags.canCut` etc. + `mediaType` + `linkURL.length > 0` checks).

**Text editing** (when `isEditable`):

- Undo / Redo (`editFlags.canUndo` / `canRedo`).
- Cut / Copy / Paste / Paste and match style / Delete / Select All
  (each gated on the matching `editFlags.*`).

**Selection** (when `selectionText.length > 0`, non-editable):

- Copy.
- Search the web for "<selection>" — only when there's a real
  default browser; opens via `shell.openExternal`. Optional, drop if
  there's no policy decision yet.

**Links** (when `linkURL.length > 0`):

- Open Link in Browser (`shell.openExternal(linkURL)`).
- Copy Link Address (`clipboard.writeText(linkURL)`).

**Images** (when `mediaType === 'image'`):

- Copy Image (`webContents.copyImageAt(x, y)`).
- Copy Image Address (`clipboard.writeText(srcURL)`).
- Save Image As… (`webContents.downloadURL(srcURL)`).

**Spellcheck** (when `misspelledWord.length > 0`):

- Up to ~5 `dictionarySuggestions` as menu items that call
  `webContents.replaceMisspelling(suggestion)`.
- Add to Dictionary (`session.defaultSession.addWordToSpellCheckerDictionary`).

**Page actions** (always, at the bottom):

- Back / Forward (`webContents.canGoBack()` / `canGoForward()`).
- Reload (`webContents.reload()`).
- View Page Source — dev only.
- **Inspect Element** — dev only. Opens DevTools at the click
  coordinates via `webContents.inspectElement(params.x, params.y)`.

"Dev only" = `isDev` from `apps/desktop/src/main.ts`. Packaged builds
should not expose Inspect Element / View Source.

## i18n

Every label must go through i18n. Tricky bit: the menu is built in
the **main** process, and the renderer owns the i18next instance.
Two viable paths:

1. **Send labels from renderer to main once.** Preload calls
   `ipcRenderer.invoke('register-menu-labels', labelsObject)` on
   startup; main caches the strings keyed by locale and rebuilds
   the menu when locale changes (subscribe to a `locale-changed`
   IPC). Lower coupling, but stale on the very first right-click
   before the renderer has hydrated.
2. **Resolve labels in main.** Load the JSON locale files from
   `apps/web/src/i18n/locales/` directly in main with a tiny key
   lookup. Avoids the IPC handshake but duplicates a fragment of
   the i18n loader. Acceptable because the strings are static.

Recommend option 2 with the loader behind a small helper in
`apps/desktop/src/i18n.ts` (new file) that reads the same JSON the
renderer uses. Add a `menu.contextMenu.*` namespace to
`en.json` / `nl.json` (cut, copy, paste, …) so renderer and main
share the keys.

## Why not done now

User asked for it after the layer-delete UI work. It's a focused
ergonomic improvement, not in scope for any active phase. Sized at
roughly half a day including i18n + tests.

## Next step

1. Decide on the i18n approach above (option 2 recommended).
2. Add `menu.contextMenu.*` keys to `en.json` + `nl.json`.
3. Write `apps/desktop/src/context-menu.ts` exporting
   `installContextMenu(win: BrowserWindow, opts: { isDev: boolean })`.
4. Wire it up in `createWindow()` in `apps/desktop/src/main.ts`
   right after `BrowserWindow` is constructed.
5. Tests: a small unit test for the template builder (in/out
   given a fake `params` object) — same pattern as
   `apps/web/tests/*-page.test.ts` (pure-logic, no Electron
   runtime). Manual smoke noted in
   `docs/dev/testing/phase-01-electron-manual.md`.
6. Update `docs/dev/architecture/` overview if the new file isn't
   obvious from the directory listing.

## Related files / docs

- `apps/desktop/src/main.ts:151` — `createWindow()` is where the
  handler must be installed.
- `apps/desktop/src/preload.ts` — only needs touching if the
  IPC-handshake variant is chosen.
- `apps/web/src/i18n/locales/{en,nl}.json` — destination for new
  `menu.contextMenu.*` keys.
- `apps/web/tests/i18n-no-hardcoded-strings.test.ts` — does NOT
  scan desktop sources today; the new desktop strings must still
  be loaded via the shared JSON to avoid drift.
- `docs/dev/testing/phase-01-electron-manual.md` — manual checks
  for the Electron wrapper; add a right-click checklist.
- Electron docs: <https://www.electronjs.org/docs/latest/api/web-contents#event-context-menu>
