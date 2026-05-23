/**
 * Phase 4a.5 — URL helpers for the companies surface.
 *
 * The server-side entity router (§4.0) mounts singular per-kind
 * segments (`/l/:slug/company`, `/l/:slug/company/_stats`, ...). The
 * 4a.1 close-out explicitly defers exposing a `routeSegment` override
 * on `EntityModule` until a second entity needs a different mapping,
 * so the singular ↔ plural translation lives client-side here.
 *
 * Web URLs the user sees:
 *   /l/:layerSlug/companies                       — list
 *   /l/:layerSlug/companies/new                   — create-dialog deep link
 *   /l/:layerSlug/companies/:companySlug          — detail / edit
 *
 * Server URLs every helper hits underneath:
 *   /l/:layerSlug/company
 *   /l/:layerSlug/company/:companySlug
 *   /l/:layerSlug/company/:companySlug/external-links
 *
 * Keep these strings together so the two sides cannot drift apart.
 */

export const COMPANIES_SERVER_KIND = 'company';
export const COMPANIES_WEB_SEGMENT = 'companies';

export function companiesListWebRoute(layerSlug: string): string {
  return `/l/${layerSlug}/${COMPANIES_WEB_SEGMENT}`;
}

export function companyDetailWebRoute(layerSlug: string, companySlug: string): string {
  return `/l/${layerSlug}/${COMPANIES_WEB_SEGMENT}/${companySlug}`;
}

export function companiesNewWebRoute(layerSlug: string): string {
  return `/l/${layerSlug}/${COMPANIES_WEB_SEGMENT}/new`;
}

export function companiesServerBase(layerSlug: string): string {
  return `/l/${encodeURIComponent(layerSlug)}/${COMPANIES_SERVER_KIND}`;
}

export function companyServerDetail(layerSlug: string, companySlug: string): string {
  return `${companiesServerBase(layerSlug)}/${encodeURIComponent(companySlug)}`;
}

export function companyServerExternalLinks(layerSlug: string, companySlug: string): string {
  return `${companyServerDetail(layerSlug, companySlug)}/external-links`;
}

export function companyServerExternalLink(
  layerSlug: string,
  companySlug: string,
  linkId: string,
): string {
  return `${companyServerExternalLinks(layerSlug, companySlug)}/${encodeURIComponent(linkId)}`;
}

/**
 * Lowercase, dash-only slug derivation matching `CreateCompanyRequestSchema`
 * (`^[a-z0-9-]+$`). Mirrors `apps/web/src/pages/MyLayersPage.tsx`'s
 * `slugify` so the two creation surfaces feel identical.
 */
export function slugifyCompanyTitle(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}
