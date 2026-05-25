/**
 * Theme controller — explicit light / dark / system preference.
 *
 * The preference is persisted in `localStorage['bunny2.theme']` and
 * mirrored to the `.dark` class on `<html>` (Tailwind class strategy,
 * see `apps/web/tailwind.config.js` + `apps/web/src/index.css`).
 *
 * The inline `<script>` in `apps/web/index.html` runs the same toggle
 * synchronously before React paints to avoid a flash-of-incorrect-theme
 * (FOIT analogue). This module owns:
 *
 *   - the strict `ThemePref` type and a runtime validator,
 *   - load + save against localStorage,
 *   - `applyTheme()` which flips the class AND opportunistically pushes
 *     the choice across the Electron preload bridge so
 *     `nativeTheme.themeSource` follows (window chrome stays in sync),
 *   - a `matchMedia` subscription helper so `App.tsx` can re-apply when
 *     the OS theme changes while the user sits on `'system'`.
 *
 * Reactive React access lives in `useTheme()` (same `useSyncExternalStore`
 * pattern as `session.ts`).
 *
 * See `docs/dev/follow-ups/done/dark-light-mode.md` for the full design.
 */

import { useSyncExternalStore } from 'react';

export type ThemePref = 'light' | 'dark' | 'system';

/** localStorage key — kept stable across releases. */
export const THEME_STORAGE_KEY = 'bunny2.theme';

/** Class toggled on `document.documentElement` when the resolved theme is dark. */
const DARK_CLASS = 'dark';

function isThemePref(v: unknown): v is ThemePref {
  return v === 'light' || v === 'dark' || v === 'system';
}

/**
 * Read the persisted preference. Returns `'system'` for missing,
 * malformed, or unreadable values. Never throws.
 */
export function loadThemePref(): ThemePref {
  try {
    if (typeof localStorage === 'undefined') return 'system';
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (raw === null) return 'system';
    return isThemePref(raw) ? raw : 'system';
  } catch {
    // Storage can throw in private modes or when quota is exceeded —
    // a missing preference is a safe fallback.
    return 'system';
  }
}

/**
 * Persist the preference. Silently swallows storage errors — the runtime
 * effect (the `.dark` class flip) is already applied by `applyTheme()`,
 * so a failed write degrades to "this session only".
 */
export function saveThemePref(pref: ThemePref): void {
  if (!isThemePref(pref)) return;
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    /* see above — best-effort */
  }
}

interface BunnyBridgeWithTheme {
  readonly setTheme?: (pref: ThemePref) => void;
}

/**
 * Toggle the `.dark` class on `<html>` and forward the choice across the
 * Electron bridge so `nativeTheme.themeSource` follows. Safe in
 * non-browser test environments (no-ops when `document` or `window` is
 * missing).
 */
export function applyTheme(pref: ThemePref): void {
  const effective = isThemePref(pref) ? pref : 'system';
  if (typeof document !== 'undefined') {
    const root = document.documentElement;
    if (root !== null) {
      const isDark = effective === 'dark' || (effective === 'system' && systemPrefersDark());
      root.classList.toggle(DARK_CLASS, isDark);
    }
  }
  if (typeof window !== 'undefined') {
    const w = window as unknown as { bunny2?: BunnyBridgeWithTheme };
    // Same opportunistic call pattern as `window.bunny2?.apiBase` in
    // `lib/api.ts`. In a pure browser context the bridge is absent and
    // this is a no-op.
    try {
      w.bunny2?.setTheme?.(effective);
    } catch {
      /* never let a renderer crash block the in-app toggle */
    }
  }
}

function systemPrefersDark(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

/**
 * Subscribe to OS-level colour-scheme changes. The caller (the React
 * hook in `App.tsx`) re-runs `applyTheme(currentPref)` from `cb` so the
 * `'system'` case keeps tracking the OS while the user sits on it.
 * Returns an unsubscribe function. Safe in non-browser environments.
 */
export function subscribeToSystemTheme(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return (): void => {};
  }
  let mql: MediaQueryList;
  try {
    mql = window.matchMedia('(prefers-color-scheme: dark)');
  } catch {
    return (): void => {};
  }
  const listener = (): void => cb();
  // Older Safari only supports `addListener` / `removeListener`; modern
  // browsers expose the standard EventTarget API. Try the new API first.
  if (typeof mql.addEventListener === 'function') {
    mql.addEventListener('change', listener);
    return (): void => mql.removeEventListener('change', listener);
  }
  const legacy = mql as unknown as {
    addListener: (l: () => void) => void;
    removeListener: (l: () => void) => void;
  };
  legacy.addListener(listener);
  return (): void => legacy.removeListener(listener);
}

// ---------------------------------------------------------------------------
// Reactive store — mirrors the `useSyncExternalStore` shape used by
// `apps/web/src/lib/session.ts`.
// ---------------------------------------------------------------------------

let currentPref: ThemePref = 'system';
let initialized = false;

const target = new EventTarget();
const EVENT = 'theme-change';

function emit(): void {
  target.dispatchEvent(new Event(EVENT));
}

function ensureInitialized(): void {
  if (initialized) return;
  initialized = true;
  currentPref = loadThemePref();
}

export function getThemeSnapshot(): ThemePref {
  ensureInitialized();
  return currentPref;
}

export function subscribeToTheme(listener: () => void): () => void {
  target.addEventListener(EVENT, listener);
  return (): void => target.removeEventListener(EVENT, listener);
}

/**
 * Update the persisted preference, apply the visual change, and notify
 * subscribers. Invalid inputs are ignored.
 */
export function setThemePref(pref: ThemePref): void {
  if (!isThemePref(pref)) return;
  ensureInitialized();
  if (pref === currentPref) {
    // Still re-apply: the OS may have changed underneath a `'system'`
    // selection, and callers expect a re-apply to be idempotent.
    applyTheme(pref);
    return;
  }
  currentPref = pref;
  saveThemePref(pref);
  applyTheme(pref);
  emit();
}

export interface UseThemeResult {
  readonly pref: ThemePref;
  readonly setPref: (pref: ThemePref) => void;
}

export function useTheme(): UseThemeResult {
  const pref = useSyncExternalStore(subscribeToTheme, getThemeSnapshot, getThemeSnapshot);
  return { pref, setPref: setThemePref };
}

/**
 * Test-only reset hook. The reactive store is module-level state; tests
 * that exercise `loadThemePref` / `setThemePref` in sequence need a way
 * to clear it between cases. Production code never calls this.
 */
export function __resetThemeForTests(): void {
  currentPref = 'system';
  initialized = false;
}
