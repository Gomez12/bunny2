import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';
import en from './locales/en.json';
import nl from './locales/nl.json';

/**
 * i18n bootstrap.
 *
 * English is the source-of-truth locale and the fallback for missing keys.
 * Dutch (`nl`) is a placeholder to prove the pipeline; the `i18n-check`
 * script warns (not errors) on keys missing from `nl.json` because the
 * stub is intentional in phase 1.5.
 *
 * Namespaces are kept flat under one bundle because phase 1.5 has only
 * two screens; promote to multiple namespaces once the bundle grows.
 */
// Init is fired-and-tracked; resources are inline so the synchronous part
// of init completes before React mounts. We avoid `await` at module
// top-level because the Vite build target (browsers without TLA) rejects
// it. The `.init()` promise resolves on the same microtask tick.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      nl: { translation: nl },
    },
    fallbackLng: 'en',
    supportedLngs: ['en', 'nl'],
    interpolation: { escapeValue: false },
    returnNull: false,
  });

export default i18n;
