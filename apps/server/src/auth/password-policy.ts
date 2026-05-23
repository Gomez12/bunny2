/**
 * Shared password-policy floor for any code path that accepts a new
 * password — self-rotation (`POST /auth/password`) and admin-driven
 * reset (`POST /admin/users/:id/reset-password`).
 *
 * Rules (phase 2.3 originals, lifted to a shared helper in 2.5 so the
 * admin reset endpoint enforces the same bar):
 *
 *   - Length ≥ 12 characters.
 *   - At least one non-letter character.
 *
 * These two rules cover the OWASP "minimum-acceptable" bar for a
 * single-factor portable tool. Rejection surfaces as the i18n key
 * `errors.auth.weakPassword`. The structural minimum in the shared
 * zod schemas (`min(8)`) is a permissive structural check; this policy
 * is enforced in the request handlers themselves so the cross-package
 * schema does not have to tighten for everyone.
 *
 * Document the rule in `docs/dev/architecture/auth-and-sessions.md`
 * (§1 "Password policy"). Keep the two locations in sync.
 */

export const MIN_PASSWORD_LENGTH = 12;
const NON_LETTER = /[^A-Za-z]/;

export type PasswordPolicyResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorKey: 'errors.auth.weakPassword' };

/**
 * Returns `{ ok: true }` when `password` clears the policy floor, or
 * `{ ok: false, errorKey }` with the localized rejection key when it
 * doesn't. Pure function — no IO, safe to call inside argon2-CPU-bound
 * paths without changing their timing profile.
 */
export function validateNewPassword(password: string): PasswordPolicyResult {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, errorKey: 'errors.auth.weakPassword' };
  }
  if (!NON_LETTER.test(password)) {
    return { ok: false, errorKey: 'errors.auth.weakPassword' };
  }
  return { ok: true };
}
