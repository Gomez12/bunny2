/**
 * Pure-logic tests for the theme controller.
 *
 * The repo has no DOM runtime yet (see
 * `docs/dev/follow-ups/web-component-tests.md`), so we shim the few
 * browser globals the controller touches — `document`,
 * `localStorage`, `window.matchMedia` — and assert behaviour against
 * those shims directly. The reactive `useTheme()` hook is exercised
 * through the lower-level `setThemePref` + `subscribeToTheme` pair so
 * we don't pull in React in a non-DOM environment.
 *
 * See `docs/dev/follow-ups/done/dark-light-mode.md` for the design.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  __resetThemeForTests,
  applyTheme,
  getThemeSnapshot,
  loadThemePref,
  saveThemePref,
  setThemePref,
  subscribeToTheme,
  THEME_STORAGE_KEY,
} from '../src/lib/theme';

// --- shims ----------------------------------------------------------------

interface FakeStorage {
  data: Map<string, string>;
}

function installFakeStorage(): FakeStorage {
  const store = new Map<string, string>();
  const storage: Storage = {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  };
  (globalThis as unknown as { localStorage: Storage }).localStorage = storage;
  return { data: store };
}

interface FakeDocument {
  classes: Set<string>;
}

function installFakeDocument(): FakeDocument {
  const classes = new Set<string>();
  const root = {
    classList: {
      add(c: string): void {
        classes.add(c);
      },
      remove(c: string): void {
        classes.delete(c);
      },
      toggle(c: string, force?: boolean): boolean {
        const target = typeof force === 'boolean' ? force : !classes.has(c);
        if (target) classes.add(c);
        else classes.delete(c);
        return target;
      },
      contains(c: string): boolean {
        return classes.has(c);
      },
    },
  };
  (globalThis as unknown as { document: { documentElement: typeof root } }).document = {
    documentElement: root,
  };
  return { classes };
}

interface FakeMatchMedia {
  setMatches(next: boolean): void;
  listeners: Array<() => void>;
  bridgeCalls: Array<string>;
}

function installFakeWindow(initialMatches: boolean): FakeMatchMedia {
  let matches = initialMatches;
  const listeners: Array<() => void> = [];
  const bridgeCalls: Array<string> = [];
  const win = {
    matchMedia(_query: string) {
      return {
        get matches(): boolean {
          return matches;
        },
        addEventListener(_ev: 'change', l: () => void): void {
          listeners.push(l);
        },
        removeEventListener(_ev: 'change', l: () => void): void {
          const i = listeners.indexOf(l);
          if (i !== -1) listeners.splice(i, 1);
        },
      } as unknown as MediaQueryList;
    },
    bunny2: {
      setTheme(pref: string): void {
        bridgeCalls.push(pref);
      },
    },
  };
  (globalThis as unknown as { window: typeof win }).window = win;
  return {
    setMatches(next: boolean): void {
      matches = next;
      for (const l of listeners.slice()) l();
    },
    listeners,
    bridgeCalls,
  };
}

function uninstallShims(): void {
  delete (globalThis as { localStorage?: unknown }).localStorage;
  delete (globalThis as { document?: unknown }).document;
  delete (globalThis as { window?: unknown }).window;
}

// --- specs ----------------------------------------------------------------

describe('loadThemePref', () => {
  beforeEach(() => {
    installFakeStorage();
    __resetThemeForTests();
  });
  afterEach(() => {
    uninstallShims();
    __resetThemeForTests();
  });

  it('returns "system" when no value is persisted', () => {
    expect(loadThemePref()).toBe('system');
  });

  it('returns the persisted value when it is a known preference', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(loadThemePref()).toBe('dark');
    localStorage.setItem(THEME_STORAGE_KEY, 'light');
    expect(loadThemePref()).toBe('light');
    localStorage.setItem(THEME_STORAGE_KEY, 'system');
    expect(loadThemePref()).toBe('system');
  });

  it('falls back to "system" when localStorage holds an unknown string', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'neon-mode');
    expect(loadThemePref()).toBe('system');
  });

  it('falls back to "system" when localStorage is absent', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(loadThemePref()).toBe('system');
  });
});

describe('saveThemePref', () => {
  beforeEach(() => {
    installFakeStorage();
    __resetThemeForTests();
  });
  afterEach(() => {
    uninstallShims();
    __resetThemeForTests();
  });

  it('persists known preferences under the documented key', () => {
    saveThemePref('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    saveThemePref('light');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');
  });

  it('ignores unknown values without throwing', () => {
    saveThemePref('hot-pink' as unknown as 'dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it('silently no-ops when localStorage is absent', () => {
    delete (globalThis as { localStorage?: unknown }).localStorage;
    expect(() => saveThemePref('dark')).not.toThrow();
  });
});

describe('applyTheme', () => {
  let doc: FakeDocument;
  let mm: FakeMatchMedia;

  beforeEach(() => {
    installFakeStorage();
    doc = installFakeDocument();
    mm = installFakeWindow(false);
    __resetThemeForTests();
  });
  afterEach(() => {
    uninstallShims();
    __resetThemeForTests();
  });

  it('adds the dark class when pref is "dark"', () => {
    applyTheme('dark');
    expect(doc.classes.has('dark')).toBe(true);
  });

  it('removes the dark class when pref is "light"', () => {
    doc.classes.add('dark');
    applyTheme('light');
    expect(doc.classes.has('dark')).toBe(false);
  });

  it('honors the OS preference when pref is "system"', () => {
    mm.setMatches(true);
    applyTheme('system');
    expect(doc.classes.has('dark')).toBe(true);
    mm.setMatches(false);
    applyTheme('system');
    expect(doc.classes.has('dark')).toBe(false);
  });

  it('forwards the choice to the Electron bridge when window.bunny2.setTheme exists', () => {
    applyTheme('dark');
    applyTheme('light');
    applyTheme('system');
    expect(mm.bridgeCalls).toEqual(['dark', 'light', 'system']);
  });

  it('treats an invalid input as "system" rather than throwing', () => {
    mm.setMatches(true);
    applyTheme('purple' as unknown as 'dark');
    // "system" + OS-dark ⇒ class present
    expect(doc.classes.has('dark')).toBe(true);
  });
});

describe('setThemePref + subscribeToTheme', () => {
  beforeEach(() => {
    installFakeStorage();
    installFakeDocument();
    installFakeWindow(false);
    __resetThemeForTests();
  });
  afterEach(() => {
    uninstallShims();
    __resetThemeForTests();
  });

  it('notifies subscribers and updates the snapshot when the pref changes', () => {
    const seen: string[] = [];
    const unsub = subscribeToTheme(() => seen.push(getThemeSnapshot()));
    setThemePref('dark');
    setThemePref('light');
    unsub();
    expect(seen).toEqual(['dark', 'light']);
    expect(getThemeSnapshot()).toBe('light');
  });

  it('persists the chosen pref through saveThemePref', () => {
    setThemePref('dark');
    expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
  });

  it('does not notify subscribers when the pref is unchanged', () => {
    setThemePref('dark');
    let notified = 0;
    const unsub = subscribeToTheme(() => {
      notified += 1;
    });
    setThemePref('dark');
    unsub();
    expect(notified).toBe(0);
  });
});
