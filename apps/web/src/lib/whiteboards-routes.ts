/**
 * Phase 11.5 — URL helpers for the whiteboards surface.
 *
 * Same singular ↔ plural seam as Companies / Contacts / Calendar /
 * Todos: the server-side entity router (§4.0) mounts the singular
 * `/l/:slug/whiteboard/...` path while the web URL the user sees uses
 * the friendlier `/l/:slug/whiteboards/...`.
 *
 * Web URLs:
 *   /l/:layerSlug/whiteboards                          — list page
 *   /l/:layerSlug/whiteboards/new                      — create-dialog deep link
 *   /l/:layerSlug/whiteboards/:whiteboardSlug          — detail / edit
 *
 * Server URLs every helper hits underneath:
 *   /l/:layerSlug/whiteboard
 *   /l/:layerSlug/whiteboard/_list-with-thumbnails
 *   /l/:layerSlug/whiteboard/:whiteboardSlug
 *   /l/:layerSlug/whiteboard/:whiteboardSlug/_checkpoint
 */

export const WHITEBOARD_SERVER_KIND = 'whiteboard';
export const WHITEBOARD_WEB_SEGMENT = 'whiteboards';

/**
 * Slugs that collide with static sub-routes mounted under
 * `/l/:layerSlug/whiteboards/*`. Mirrors the same precaution used by
 * `calendar-routes.ts` so the user can't create a whiteboard called
 * "New" whose slug would shadow the `/new` page.
 */
export const RESERVED_WHITEBOARD_SLUGS: ReadonlySet<string> = new Set(['new']);

export function webWhiteboardsPath(layerSlug: string): string {
  return `/l/${layerSlug}/${WHITEBOARD_WEB_SEGMENT}`;
}

export function webWhiteboardPath(layerSlug: string, whiteboardSlug: string): string {
  return `/l/${layerSlug}/${WHITEBOARD_WEB_SEGMENT}/${whiteboardSlug}`;
}

export function webWhiteboardNewPath(layerSlug: string): string {
  return `/l/${layerSlug}/${WHITEBOARD_WEB_SEGMENT}/new`;
}

export function whiteboardServerBase(layerSlug: string): string {
  return `/l/${encodeURIComponent(layerSlug)}/${WHITEBOARD_SERVER_KIND}`;
}

export function whiteboardServerDetail(layerSlug: string, whiteboardSlug: string): string {
  return `${whiteboardServerBase(layerSlug)}/${encodeURIComponent(whiteboardSlug)}`;
}

export function whiteboardServerCheckpoint(layerSlug: string, whiteboardSlug: string): string {
  return `${whiteboardServerDetail(layerSlug, whiteboardSlug)}/_checkpoint`;
}

export function whiteboardServerListWithThumbnails(layerSlug: string): string {
  return `${whiteboardServerBase(layerSlug)}/_list-with-thumbnails`;
}

/**
 * Lowercase, dash-only slug derivation matching the §4.0 contract.
 * Reserved slugs (`new`) are suffixed with `-whiteboard` so they do
 * not collide with the static `/new` sub-route.
 */
export function slugifyWhiteboardTitle(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (RESERVED_WHITEBOARD_SLUGS.has(base)) {
    return `${base}-whiteboard`;
  }
  return base;
}
