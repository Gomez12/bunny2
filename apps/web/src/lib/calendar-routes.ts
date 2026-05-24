/**
 * Phase 4c.5 — URL helpers for the calendar surface.
 *
 * Same singular ↔ plural seam as Companies (`companies-routes.ts`) and
 * Contacts (`contacts-routes.ts`): the server-side entity router (§4.0)
 * mounts the singular per-kind segment (`/l/:slug/calendar_event/...`)
 * while the web URLs the user sees use the friendlier `/calendar/...`
 * segment. The 4a.1 close-out deferred a `routeSegment` override on
 * `EntityModule` until a second entity needed a different mapping;
 * Calendar intentionally reuses the same convention so no foundation
 * change is required.
 *
 * Web URLs:
 *   /l/:layerSlug/calendar                          — list (grid)
 *   /l/:layerSlug/calendar/new                      — create-dialog deep link
 *   /l/:layerSlug/calendar/:eventSlug               — detail / edit
 *
 * Server URLs every helper hits underneath:
 *   /l/:layerSlug/calendar_event
 *   /l/:layerSlug/calendar_event/:eventSlug
 *   /l/:layerSlug/calendar_event/:eventSlug/external-links
 *   /l/:layerSlug/calendar_event/_ingest/google.calendar
 */

export const CALENDAR_SERVER_KIND = 'calendar_event';
export const CALENDAR_WEB_SEGMENT = 'calendar';

/**
 * Slugs that collide with static sub-routes mounted under
 * `/l/:layerSlug/calendar/*`. React Router v6 ranks routes by specificity
 * so `/new` always wins over `/:eventSlug`, but the user could still
 * create an event named "New" whose slug normalises to `new`, which
 * would then be unreachable through the detail link. The helpers
 * reject the collision client-side so the user sees the error before
 * the round-trip.
 */
export const RESERVED_CALENDAR_SLUGS: ReadonlySet<string> = new Set(['new']);

export function webCalendarPath(layerSlug: string): string {
  return `/l/${layerSlug}/${CALENDAR_WEB_SEGMENT}`;
}

export function webCalendarEventPath(layerSlug: string, eventSlug: string): string {
  return `/l/${layerSlug}/${CALENDAR_WEB_SEGMENT}/${eventSlug}`;
}

export function webCalendarNewPath(layerSlug: string): string {
  return `/l/${layerSlug}/${CALENDAR_WEB_SEGMENT}/new`;
}

export function calendarServerBase(layerSlug: string): string {
  return `/l/${encodeURIComponent(layerSlug)}/${CALENDAR_SERVER_KIND}`;
}

export function calendarServerDetail(layerSlug: string, eventSlug: string): string {
  return `${calendarServerBase(layerSlug)}/${encodeURIComponent(eventSlug)}`;
}

export function calendarServerExternalLinks(layerSlug: string, eventSlug: string): string {
  return `${calendarServerDetail(layerSlug, eventSlug)}/external-links`;
}

export function calendarServerGoogleIngest(layerSlug: string): string {
  return `${calendarServerBase(layerSlug)}/_ingest/google.calendar`;
}

/**
 * Lowercase, dash-only slug derivation matching
 * `CreateCalendarEventRequestSchema` (`^[a-z0-9-]+$`). Mirrors
 * `slugifyContactTitle` and `slugifyCompanyTitle` so the creation
 * surfaces feel identical, with one calendar-specific twist:
 * reserved slugs (currently just `new`) are suffixed with `-event`
 * so they do not collide with the static `/new` sub-route.
 */
export function slugifyCalendarEventTitle(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (RESERVED_CALENDAR_SLUGS.has(base)) {
    return `${base}-event`;
  }
  return base;
}
