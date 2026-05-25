import { describe, expect, it } from 'bun:test';
import * as path from 'node:path';
import {
  createTranslator,
  flattenMessages,
  loadLocaleBundle,
  loadTranslator,
  pickLocale,
  resolveLocaleDir,
} from '../src/i18n';

describe('resolveLocaleDir', () => {
  it('returns <resourcesPath>/locales when packaged', () => {
    const dir = resolveLocaleDir({ resourcesPath: '/app/Contents/Resources', isPackaged: true });
    expect(dir).toBe(path.join('/app/Contents/Resources', 'locales'));
  });

  it('walks to the renderer source in dev', () => {
    const dir = resolveLocaleDir({ resourcesPath: '/repo/apps/desktop', isPackaged: false });
    expect(dir).toBe(path.join('/repo', 'apps', 'web', 'src', 'i18n', 'locales'));
  });
});

describe('pickLocale', () => {
  it('returns en for unknown / missing values', () => {
    expect(pickLocale(undefined)).toBe('en');
    expect(pickLocale('')).toBe('en');
    expect(pickLocale('fr')).toBe('en');
  });

  it('normalizes locale tags by base', () => {
    expect(pickLocale('nl')).toBe('nl');
    expect(pickLocale('nl-NL')).toBe('nl');
    expect(pickLocale('NL')).toBe('nl');
    expect(pickLocale('en_GB')).toBe('en');
  });
});

describe('flattenMessages', () => {
  it('flattens nested objects into dot-keys', () => {
    const out = flattenMessages({ a: { b: 'x', c: { d: 'y' } }, e: 'z' });
    expect(out).toEqual({ 'a.b': 'x', 'a.c.d': 'y', e: 'z' });
  });

  it('returns an empty record for non-objects', () => {
    expect(flattenMessages(null)).toEqual({});
    expect(flattenMessages('string')).toEqual({});
  });
});

describe('loadLocaleBundle', () => {
  it('uses the injected reader and flattens the result', () => {
    const bundle = loadLocaleBundle({
      localeDir: '/locales',
      locale: 'en',
      readFile: (file) => {
        expect(file).toBe(path.join('/locales', 'en.json'));
        return JSON.stringify({ menu: { contextMenu: { copy: 'Copy' } } });
      },
    });
    expect(bundle.code).toBe('en');
    expect(bundle.messages['menu.contextMenu.copy']).toBe('Copy');
  });
});

describe('createTranslator', () => {
  it('uses the active locale, then the fallback, then the key', () => {
    const t = createTranslator({
      active: { code: 'nl', messages: { 'a.b': 'NL_B' } },
      fallback: { code: 'en', messages: { 'a.b': 'EN_B', 'a.c': 'EN_C' } },
    });
    expect(t('a.b')).toBe('NL_B');
    expect(t('a.c')).toBe('EN_C');
    expect(t('a.missing')).toBe('a.missing');
  });
});

describe('loadTranslator', () => {
  it('falls back to en when the active locale fails to load', () => {
    const reader = (file: string): string => {
      if (file.endsWith('en.json')) {
        return JSON.stringify({ menu: { x: 'X' } });
      }
      throw new Error(`unreadable: ${file}`);
    };
    const t = loadTranslator({
      resourcesPath: '/r',
      isPackaged: true,
      localeHint: 'nl',
      readFile: reader,
    });
    expect(t('menu.x')).toBe('X');
    expect(t('missing.key')).toBe('missing.key');
  });

  it('returns english labels when the hint is en', () => {
    const reader = (): string => JSON.stringify({ greet: 'Hello' });
    const t = loadTranslator({
      resourcesPath: '/r',
      isPackaged: true,
      localeHint: 'en',
      readFile: reader,
    });
    expect(t('greet')).toBe('Hello');
  });
});
