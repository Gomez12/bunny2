/**
 * Phase 4b.5 — URL helpers for the contacts surface.
 *
 * Same singular ↔ plural seam as Companies (`companies-routes.ts`): the
 * server-side entity router (§4.0) mounts a singular per-kind segment
 * (`/l/:slug/contact/...`) while the web URLs the user sees use the
 * friendly plural form (`/l/:slug/contacts/...`). The 4a.1 close-out
 * deferred a `routeSegment` override on `EntityModule` until a second
 * entity needed a different mapping; Contacts intentionally reuses the
 * exact same convention so no foundation change is required.
 *
 * Web URLs the user sees:
 *   /l/:layerSlug/contacts                         — list
 *   /l/:layerSlug/contacts/new                     — create-dialog deep link
 *   /l/:layerSlug/contacts/:contactSlug            — detail / edit
 *   /l/:layerSlug/contacts/import                  — vCard import (4b.2)
 *
 * Server URLs every helper hits underneath:
 *   /l/:layerSlug/contact
 *   /l/:layerSlug/contact/:contactSlug
 *   /l/:layerSlug/contact/:contactSlug/external-links
 *   /l/:layerSlug/contact/:contactSlug/external-links/:linkId
 */

export const CONTACTS_SERVER_KIND = 'contact';
export const CONTACTS_WEB_SEGMENT = 'contacts';

export function contactsListWebRoute(layerSlug: string): string {
  return `/l/${layerSlug}/${CONTACTS_WEB_SEGMENT}`;
}

export function contactDetailWebRoute(layerSlug: string, contactSlug: string): string {
  return `/l/${layerSlug}/${CONTACTS_WEB_SEGMENT}/${contactSlug}`;
}

export function contactsNewWebRoute(layerSlug: string): string {
  return `/l/${layerSlug}/${CONTACTS_WEB_SEGMENT}/new`;
}

export function contactsImportWebRoute(layerSlug: string): string {
  return `/l/${layerSlug}/${CONTACTS_WEB_SEGMENT}/import`;
}

export function contactsServerBase(layerSlug: string): string {
  return `/l/${encodeURIComponent(layerSlug)}/${CONTACTS_SERVER_KIND}`;
}

export function contactServerDetail(layerSlug: string, contactSlug: string): string {
  return `${contactsServerBase(layerSlug)}/${encodeURIComponent(contactSlug)}`;
}

export function contactServerExternalLinks(layerSlug: string, contactSlug: string): string {
  return `${contactServerDetail(layerSlug, contactSlug)}/external-links`;
}

export function contactServerExternalLink(
  layerSlug: string,
  contactSlug: string,
  linkId: string,
): string {
  return `${contactServerExternalLinks(layerSlug, contactSlug)}/${encodeURIComponent(linkId)}`;
}

/**
 * Lowercase, dash-only slug derivation matching `CreateContactRequestSchema`
 * (`^[a-z0-9-]+$`). Mirrors `slugifyCompanyTitle` so the two creation
 * surfaces feel identical.
 */
export function slugifyContactTitle(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
