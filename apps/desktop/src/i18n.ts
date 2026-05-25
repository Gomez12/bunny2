import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Tiny locale loader for the Electron main process.
 *
 * The Electron main process is `node`, not the Vite renderer, so it
 * cannot import `i18next`. The handful of strings the main process
 * needs (right-click menu labels, see `context-menu.ts`) are resolved
 * by reading the renderer's locale JSON files directly. This keeps a
 * single source of truth for translations — `apps/web/src/i18n/locales/`
 * — and avoids growing the preload IPC surface (ADR 0004 commits the
 * renderer to "HTTP only", no extra IPC).
 *
 * Why option 2 (resolve in main): Electron's `Menu.buildFromTemplate`
 * runs in main; the menu items need their `label` at template-build
 * time. Translating in the renderer and shipping a label table over
 * IPC would invert that flow for no gain.
 *
 * Locale selection: defaults to `en`. The renderer can push its active
 * locale through the `BUNNY2_LOCALE` env var (or future
 * `additionalArguments` flag). English is always the fallback for
 * missing keys.
 *
 * Path layout:
 *   - Dev:      `<repoRoot>/apps/web/src/i18n/locales/{en,nl}.json`
 *   - Packaged: `<resourcesPath>/locales/{en,nl}.json` (copied by
 *               `apps/desktop/scripts/prepare-resources.ts`).
 */

export type LocaleCode = 'en' | 'nl';
export const SUPPORTED_LOCALES: readonly LocaleCode[] = ['en', 'nl'];
export const DEFAULT_LOCALE: LocaleCode = 'en';

export interface LocaleBundle {
  readonly code: LocaleCode;
  readonly messages: Readonly<Record<string, string>>;
}

export interface ResolveLocaleDirInput {
  /** `process.resourcesPath` in packaged, repo `apps/desktop` root in dev. */
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
}

/**
 * Resolve the directory holding `{en,nl}.json`.
 *
 * Packaged layout: `<resourcesPath>/locales/`.
 * Dev layout:      walk up to repo root and use `apps/web/src/i18n/locales/`.
 */
export function resolveLocaleDir(input: ResolveLocaleDirInput): string {
  if (input.isPackaged) {
    return path.join(input.resourcesPath, 'locales');
  }
  // Dev: `<resourcesPath>` is `apps/desktop`. Repo root is two levels up.
  const repoRoot = path.resolve(input.resourcesPath, '..', '..');
  return path.join(repoRoot, 'apps', 'web', 'src', 'i18n', 'locales');
}

/**
 * Normalize whatever locale hint the caller supplies to a supported
 * `LocaleCode`. Returns `DEFAULT_LOCALE` for unknown values.
 */
export function pickLocale(hint: string | undefined): LocaleCode {
  if (typeof hint !== 'string' || hint.length === 0) return DEFAULT_LOCALE;
  const base = hint.toLowerCase().split(/[-_]/)[0] ?? '';
  if ((SUPPORTED_LOCALES as readonly string[]).includes(base)) {
    return base as LocaleCode;
  }
  return DEFAULT_LOCALE;
}

/**
 * Flatten a nested locale object into dot-notation keys (matches the
 * `t('a.b.c')` style used by the renderer).
 */
export function flattenMessages(value: unknown, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  if (value === null || typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const next = prefix.length === 0 ? k : `${prefix}.${k}`;
    if (typeof v === 'string') {
      out[next] = v;
    } else if (typeof v === 'object' && v !== null) {
      Object.assign(out, flattenMessages(v, next));
    }
  }
  return out;
}

export interface LoadLocaleBundleInput {
  readonly localeDir: string;
  readonly locale: LocaleCode;
  /**
   * Optional fs reader, injected by tests. Defaults to `fs.readFileSync`.
   */
  readonly readFile?: ((file: string) => string) | undefined;
}

/**
 * Load and flatten one locale bundle. Throws if the file is missing or
 * unparseable; callers can catch and fall back to `DEFAULT_LOCALE`.
 */
export function loadLocaleBundle(input: LoadLocaleBundleInput): LocaleBundle {
  const reader = input.readFile ?? ((file: string) => fs.readFileSync(file, 'utf8'));
  const file = path.join(input.localeDir, `${input.locale}.json`);
  const raw = reader(file);
  const parsed = JSON.parse(raw) as unknown;
  return { code: input.locale, messages: flattenMessages(parsed) };
}

export interface CreateTranslatorInput {
  readonly active: LocaleBundle;
  readonly fallback: LocaleBundle;
}

/** Build a `t(key)` function that falls back to English then to the key. */
export function createTranslator(input: CreateTranslatorInput): (key: string) => string {
  return (key: string): string => {
    const hit = input.active.messages[key];
    if (typeof hit === 'string' && hit.length > 0) return hit;
    const fb = input.fallback.messages[key];
    if (typeof fb === 'string' && fb.length > 0) return fb;
    return key;
  };
}

export interface LoadTranslatorInput {
  readonly resourcesPath: string;
  readonly isPackaged: boolean;
  readonly localeHint?: string | undefined;
  readonly readFile?: (file: string) => string;
}

/**
 * High-level helper: pick a locale, load it + the English fallback,
 * return a `t(key)` function. Falls back to `DEFAULT_LOCALE` only if
 * the active locale fails to load — never throws.
 */
export function loadTranslator(input: LoadTranslatorInput): (key: string) => string {
  const localeDir = resolveLocaleDir({
    resourcesPath: input.resourcesPath,
    isPackaged: input.isPackaged,
  });
  const active = pickLocale(input.localeHint);
  const fallback = loadLocaleBundle({
    localeDir,
    locale: DEFAULT_LOCALE,
    readFile: input.readFile,
  });
  if (active === DEFAULT_LOCALE) {
    return createTranslator({ active: fallback, fallback });
  }
  let activeBundle: LocaleBundle;
  try {
    activeBundle = loadLocaleBundle({ localeDir, locale: active, readFile: input.readFile });
  } catch (err) {
    console.warn(`[bunny2] could not load locale '${active}', falling back to en:`, err);
    activeBundle = fallback;
  }
  return createTranslator({ active: activeBundle, fallback });
}
