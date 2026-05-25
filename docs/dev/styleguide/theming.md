# Theming

bunny2 ships a three-state theme preference — **Light**, **Dark**, and
**System** — exposed in the account chip (`apps/web/src/components/UserMenu.tsx`)
and persisted in `localStorage` under the key `bunny2.theme`.

## Strategy: class-based dark mode

`apps/web/tailwind.config.js` uses `darkMode: 'class'`. Tailwind's
dark-variant utilities (`dark:bg-…`, `dark:text-…`, etc.) activate when
the `.dark` class is present on `<html>`.

The light tokens (HSL CSS variables) live on `:root` in
`apps/web/src/index.css`. The dark overrides live on `.dark` in the same
file. There is no `@media (prefers-color-scheme: dark)` fallback —
"follow the OS" is handled by the controller toggling the class, not by
the stylesheet, so the user's explicit choice can override the OS.

## Bootstrap script

A tiny inline `<script>` in `apps/web/index.html` runs synchronously in
the document `<head>` before React mounts. It reads
`localStorage['bunny2.theme']`, resolves `'system'` through
`window.matchMedia('(prefers-color-scheme: dark)')`, and toggles the
`.dark` class. This avoids a flash-of-incorrect-theme on first paint.

This is the one place an inline script is deliberately allowed — every
other piece of theme logic lives in `apps/web/src/lib/theme.ts`.

## Controller

`apps/web/src/lib/theme.ts` owns:

- `loadThemePref()` / `saveThemePref()` against the documented key,
- `applyTheme(pref)` which flips the `.dark` class and opportunistically
  calls `window.bunny2?.setTheme?.(pref)` so Electron's
  `nativeTheme.themeSource` keeps the window chrome in sync,
- `subscribeToSystemTheme(cb)` for the `'system'` preference re-apply,
- a `useTheme()` hook backed by `useSyncExternalStore` (same pattern as
  `apps/web/src/lib/session.ts`).

## Adding new tokens

When you add or rename a CSS custom property in `apps/web/src/index.css`,
keep light and dark in lockstep — every variable on `:root` must have a
counterpart on `.dark`. Components should reference tokens through the
Tailwind theme (`bg-background`, `text-foreground`, etc.) rather than
hardcoded colours.
