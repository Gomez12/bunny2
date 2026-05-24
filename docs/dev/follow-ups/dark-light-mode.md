# Follow-up — Explicit light / dark / system theme switch

- Status: open
- Created: 2026-05-24 (user request, no prior coverage)
- Phases referencing it: 1.5 (Tailwind + shadcn scaffolding landed
  with system-only theming), 2.6 (account chip — the natural home
  for the toggle)

## What remains

Today the app reacts to the OS — `apps/web/src/index.css` declares
the light tokens on `:root` and overrides them inside a
`@media (prefers-color-scheme: dark)` block. There is no user-visible
control, no persistence, and no way to override the OS choice.

Goal: a 3-state theme preference — **light**, **dark**, **system** —
that the user can change from the account chip and that the app
remembers across launches.

## Approach

### 1. Switch Tailwind from media-query to class strategy

`apps/web/tailwind.config.js` — set `darkMode: 'class'`.

`apps/web/src/index.css` — replace the `@media (prefers-color-scheme:
dark)` block with `.dark { … }` carrying the same variables. The
light tokens stay on `:root` as the default.

### 2. Theme controller

New file `apps/web/src/lib/theme.ts`:

- `type ThemePref = 'light' | 'dark' | 'system';`
- `loadThemePref(): ThemePref` — reads `localStorage['bunny2.theme']`
  (defaults to `'system'`). Validates the value; falls back to
  `'system'` on garbage.
- `saveThemePref(pref: ThemePref): void` — writes the same key.
- `applyTheme(pref: ThemePref): void` — toggles the `.dark` class on
  `document.documentElement` based on `pref` and, when `'system'`,
  on `window.matchMedia('(prefers-color-scheme: dark)').matches`.
- `subscribeToSystemTheme(cb): () => void` — when the active pref is
  `'system'`, re-apply on `matchMedia` change events. The hook
  installed in `App.tsx` owns this subscription.

Hook: `useTheme()` exposes `{ pref, setPref }` backed by a small
store (the existing `apps/web/src/lib/session.ts` pattern with
`useSyncExternalStore` is the closest match — copy the shape, don't
add a new dep).

Mount once in `App.tsx`: read `loadThemePref()` on first render,
`applyTheme()` synchronously to avoid a light flash on dark
preference (flash-of-incorrect-theme — FOIT analogue). The synchronous
apply must happen BEFORE React paints; a tiny inline script in
`apps/web/index.html` head is the only reliable way:

```html
<script>
  (function () {
    try {
      var p = localStorage.getItem('bunny2.theme') || 'system';
      var isDark = p === 'dark' || (p === 'system' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches);
      if (isDark) document.documentElement.classList.add('dark');
    } catch (_) {}
  })();
</script>
```

This is the one place an inline script is justified — the cost of a
single async React tick is a visible flash, which is worse than a
4-line bootstrap script. Note this in the file with a short comment
pointing back to this follow-up.

### 3. UI surface

Account chip (`apps/web/src/components/UserMenu.tsx` or wherever the
auth.userMenu items live today) gets a new "Theme" submenu with
three radio items: Light / Dark / System. Selecting one calls
`setPref()`; the controller writes localStorage and re-applies.

Alternative: a single icon button in the header that cycles
light → dark → system. Smaller surface, but loses the
which-is-active affordance — keep the radio submenu.

### 4. Electron bridge

Electron has its own `nativeTheme.themeSource` (`'system' | 'light' |
'dark'`) that drives traffic-light buttons, native menus, and the
window chrome on Windows. When the user picks a theme in the
renderer, send the choice through preload → main, and call
`nativeTheme.themeSource = pref`. Otherwise the title bar stays
light while the app turns dark and looks broken.

- `apps/desktop/src/preload.ts` — expose
  `window.bunny2.setTheme(pref: 'light'|'dark'|'system')`.
- `apps/desktop/src/main.ts` — add an `ipcMain.handle('set-theme', …)`
  that validates the input and assigns `nativeTheme.themeSource`.
- Renderer's `applyTheme()` opportunistically calls
  `window.bunny2?.setTheme?.(pref)` after toggling the class — same
  no-op pattern used by `window.bunny2?.apiBase`.

### 5. i18n

Add `auth.userMenu.theme.{label, light, dark, system}` to
`en.json` + `nl.json`. Reuse the existing `auth.userMenu` namespace
so the toggle sits next to "Change password" / "Sign out" without a
new top-level key.

### 6. Tests

- `apps/web/tests/theme.test.ts` — pure-logic tests for
  `loadThemePref`, `saveThemePref`, `applyTheme` against a fake
  `document` + `localStorage` + `matchMedia`.
- `apps/web/tests/i18n-no-hardcoded-strings.test.ts` already runs
  the repo i18n-check; the new menu strings have to be loaded
  through `t()`.

DOM-driven tests for the menu interaction wait on the same
`docs/dev/follow-ups/web-component-tests.md` follow-up the other
detail pages reference.

### 7. Accessibility

- `aria-checked` on the radio items.
- The toggle must be reachable via Tab from the account chip.
- Contrast already meets WCAG AA in both palettes (the shadcn
  defaults). A quick re-check with the actual screens at the end
  of the work is still worth a row in the manual checklist.

## Why not done now

User asked for a tasklist row, not an implementation, alongside the
right-click-menu request. Sized at roughly half a day including
Electron bridge + i18n + tests; small enough to ship as a focused
PR when picked up.

## Next step

1. Switch `darkMode` to `class` and move the variables block.
2. Add `apps/web/src/lib/theme.ts` + the inline bootstrap script.
3. Wire the controller into `App.tsx` and the account chip.
4. Add IPC + `nativeTheme.themeSource` plumbing in
   `apps/desktop/{preload,main}.ts`.
5. i18n keys.
6. Test the controller + run the repo i18n-check.
7. Manual sanity: toggle in each direction, restart the app,
   confirm the choice persists and Electron's chrome follows.

## Related files / docs

- `apps/web/src/index.css` — current `:root` + `@media` tokens.
- `apps/web/tailwind.config.js` — needs `darkMode: 'class'`.
- `apps/web/index.html` — destination for the bootstrap script.
- `apps/web/src/lib/session.ts` — pattern to copy for the store.
- `apps/web/src/components/UserMenu.tsx` (or the file that owns the
  account chip — check before editing) — destination for the
  submenu.
- `apps/desktop/src/preload.ts`, `apps/desktop/src/main.ts` —
  bridge + nativeTheme.
- `apps/web/src/i18n/locales/{en,nl}.json` — new
  `auth.userMenu.theme.*` keys.
- `docs/dev/styleguide/` — record the class-strategy choice and
  the token table once shipped.
- Electron docs:
  <https://www.electronjs.org/docs/latest/api/native-theme>
