/**
 * Map an unknown thrown value into a stable i18n error key.
 *
 * - {@link ApiError} → its `errorKey` (already an i18n key such as
 *   `errors.auth.invalidCredentials`).
 * - Anything else → `errors.network`, the universal fallback.
 *
 * Centralized so every page/form has identical fallback behavior; this
 * also keeps `t(key, { defaultValue: t('errors.network') })` consistent
 * across the app.
 */

import { ApiError } from './api';

export function errorKeyOf(err: unknown): string {
  if (err instanceof ApiError) return err.errorKey;
  return 'errors.network';
}
