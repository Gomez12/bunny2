/**
 * Pure helper that formats an ISO-8601 timestamp as a localized
 * relative-time phrase ("2 hours ago", "5 days ago"). Uses the native
 * `Intl.RelativeTimeFormat` so it inherits the user's locale without
 * a runtime translation table.
 *
 * Lives in `apps/web/src/lib/` so list pages on every kind can reuse
 * it (companies-list-columns follow-up — see
 * `docs/dev/follow-ups/done/companies-list-columns.md`).
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/**
 * Format `iso` as a relative-time phrase against `now`. Returns
 * `null` when `iso` is null / undefined / unparseable so callers can
 * render a fallback (em-dash, "—") without an extra try/catch.
 *
 * `locale` defaults to the browser's resolved language; tests pin a
 * locale to keep snapshots stable. `now` defaults to wall-clock; pin
 * it from tests for determinism.
 */
export function formatRelativeTime(
  iso: string | null | undefined,
  opts: { readonly locale?: string; readonly now?: Date } = {},
): string | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const now = (opts.now ?? new Date()).getTime();
  const deltaMs = t - now;
  const absMs = Math.abs(deltaMs);

  let value: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (absMs < MINUTE) {
    value = Math.round(deltaMs / SECOND);
    unit = 'second';
  } else if (absMs < HOUR) {
    value = Math.round(deltaMs / MINUTE);
    unit = 'minute';
  } else if (absMs < DAY) {
    value = Math.round(deltaMs / HOUR);
    unit = 'hour';
  } else if (absMs < WEEK) {
    value = Math.round(deltaMs / DAY);
    unit = 'day';
  } else if (absMs < MONTH) {
    value = Math.round(deltaMs / WEEK);
    unit = 'week';
  } else if (absMs < YEAR) {
    value = Math.round(deltaMs / MONTH);
    unit = 'month';
  } else {
    value = Math.round(deltaMs / YEAR);
    unit = 'year';
  }

  const locale = opts.locale ?? (typeof navigator === 'undefined' ? 'en' : navigator.language);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  return rtf.format(value, unit);
}

/**
 * Convenience predicate used by list pages: was `iso` within the
 * last `hours` hours of `now`?
 */
export function isWithinHours(
  iso: string | null | undefined,
  hours: number,
  now: Date = new Date(),
): boolean {
  if (iso === null || iso === undefined || iso === '') return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return now.getTime() - t < hours * HOUR;
}
