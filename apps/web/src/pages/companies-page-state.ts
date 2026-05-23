/**
 * Phase 4a.5 — pure helpers for the companies pages.
 *
 * The web repo has no DOM runtime (see
 * `docs/dev/follow-ups/web-component-tests.md`), so the per-page logic
 * is factored into pure functions that can be exercised by
 * `bun test`. The same pattern is used by
 * `apps/web/src/dashboard/companies-widget-state.ts` (phase 4a.4).
 *
 * Covered branches:
 *
 *  - `companiesListView` — maps the load state to the four render
 *    branches the list page draws (loading / error / empty / ready).
 *  - `companyDetailView` — maps the detail page's load + edit state to
 *    the renderable view.
 *  - `validateCompanyForm` — runs the same shape that the server's
 *    `CompanyPayloadSchema` enforces; returns an i18n key when
 *    something is off, `null` when the form is acceptable. Surfaces
 *    inline before the round-trip so users get fast feedback.
 *  - `buildCreateCompanyRequest` / `buildUpdateCompanyRequest` —
 *    construct the JSON bodies the server expects, normalizing empty
 *    strings to absent fields per the optional-everywhere schema.
 *  - `linkSyncStateBadgeKey` — maps an external-link `sync_state` to
 *    the user-visible status badge i18n key.
 */
import type {
  Company,
  CompanyPayload,
  CreateCompanyPayload,
  EntitySummary,
  EntitySyncState,
  UpdateCompanyPayload,
} from '../lib/api-types';

// ---------- list page ------------------------------------------------------

export type CompaniesListInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly companies: readonly EntitySummary[] };

export type CompaniesListView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly companies: readonly EntitySummary[] };

export function companiesListView(input: CompaniesListInput): CompaniesListView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  if (input.companies.length === 0) return { kind: 'empty' };
  return { kind: 'ready', companies: input.companies };
}

// ---------- detail page ----------------------------------------------------

export type CompanyDetailInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly company: Company };

export type CompanyDetailView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly company: Company };

export function companyDetailView(input: CompanyDetailInput): CompanyDetailView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  return { kind: 'ready', company: input.company };
}

// ---------- form validation ------------------------------------------------

export interface CompanyFormDraft {
  readonly title: string;
  readonly slug?: string;
  readonly legalName: string;
  readonly tradeName: string;
  readonly kvkNumber: string;
  readonly website: string;
  readonly email: string;
  readonly phone: string;
  readonly industry: string;
  readonly description: string;
  readonly addressStreet: string;
  readonly addressHouseNumber: string;
  readonly addressPostalCode: string;
  readonly addressCity: string;
  readonly addressCountry: string;
}

export function emptyCompanyFormDraft(): CompanyFormDraft {
  return {
    title: '',
    slug: '',
    legalName: '',
    tradeName: '',
    kvkNumber: '',
    website: '',
    email: '',
    phone: '',
    industry: '',
    description: '',
    addressStreet: '',
    addressHouseNumber: '',
    addressPostalCode: '',
    addressCity: '',
    addressCountry: '',
  };
}

export function draftFromCompany(company: Company): CompanyFormDraft {
  const p = company.payload;
  const a = p.address ?? {};
  return {
    title: company.title,
    slug: company.slug,
    legalName: p.legalName ?? '',
    tradeName: p.tradeName ?? '',
    kvkNumber: p.kvkNumber ?? '',
    website: p.website ?? '',
    email: p.email ?? '',
    phone: p.phone ?? '',
    industry: p.industry ?? '',
    description: p.description ?? '',
    addressStreet: a.street ?? '',
    addressHouseNumber: a.houseNumber ?? '',
    addressPostalCode: a.postalCode ?? '',
    addressCity: a.city ?? '',
    addressCountry: a.country ?? '',
  };
}

/**
 * Inline form validation mirroring `CompanyPayloadSchema`. Returns the
 * i18n key of the first failure, or `null` when the draft is shippable.
 * The server is the source of truth and re-validates every payload; this
 * helper just trims the round-trip for the obvious cases.
 */
export function validateCompanyForm(draft: CompanyFormDraft): string | null {
  if (draft.title.trim().length === 0) {
    return 'errors.entity.companies.validation';
  }
  if (draft.kvkNumber.trim().length > 0 && !/^\d{8}$/.test(draft.kvkNumber.trim())) {
    return 'errors.entity.companies.kvkInvalid';
  }
  if (draft.website.trim().length > 0 && !isProbablyUrl(draft.website.trim())) {
    return 'errors.entity.companies.websiteInvalid';
  }
  if (draft.email.trim().length > 0 && !isProbablyEmail(draft.email.trim())) {
    return 'errors.entity.companies.emailInvalid';
  }
  if (draft.description.length > 4000) {
    return 'errors.entity.companies.descriptionTooLong';
  }
  return null;
}

function isProbablyUrl(value: string): boolean {
  try {
    // Accept anything `URL` accepts — same as the server's
    // `z.string().url()` rule (zod uses the WHATWG URL parser).
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function isProbablyEmail(value: string): boolean {
  // Very loose check — same intent as zod's `.email()`: catch obvious
  // typos client-side, the server re-validates.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function buildPayload(draft: CompanyFormDraft): CompanyPayload {
  const payload: Record<string, unknown> = {};
  function pick(key: keyof CompanyPayload, value: string): void {
    const trimmed = value.trim();
    if (trimmed.length > 0) payload[key] = trimmed;
  }
  pick('legalName', draft.legalName);
  pick('tradeName', draft.tradeName);
  pick('kvkNumber', draft.kvkNumber);
  pick('website', draft.website);
  pick('email', draft.email);
  pick('phone', draft.phone);
  pick('industry', draft.industry);
  pick('description', draft.description);

  const address: Record<string, string> = {};
  if (draft.addressStreet.trim().length > 0) address.street = draft.addressStreet.trim();
  if (draft.addressHouseNumber.trim().length > 0)
    address.houseNumber = draft.addressHouseNumber.trim();
  if (draft.addressPostalCode.trim().length > 0)
    address.postalCode = draft.addressPostalCode.trim();
  if (draft.addressCity.trim().length > 0) address.city = draft.addressCity.trim();
  if (draft.addressCountry.trim().length > 0) address.country = draft.addressCountry.trim();
  if (Object.keys(address).length > 0) {
    payload.address = address;
  }
  return payload as CompanyPayload;
}

export function buildCreateCompanyRequest(
  draft: CompanyFormDraft,
  originalLocale: string,
): CreateCompanyPayload {
  const out: {
    title: string;
    slug?: string;
    originalLocale: string;
    payload: CompanyPayload;
  } = {
    title: draft.title.trim(),
    originalLocale,
    payload: buildPayload(draft),
  };
  if (draft.slug !== undefined && draft.slug.trim().length > 0) {
    out.slug = draft.slug.trim();
  }
  return out;
}

export function buildUpdateCompanyRequest(draft: CompanyFormDraft): UpdateCompanyPayload {
  return {
    title: draft.title.trim(),
    payload: buildPayload(draft),
  };
}

// ---------- external links --------------------------------------------------

export function linkSyncStateBadgeKey(state: EntitySyncState): string {
  if (state === 'syncing') return 'entity.companies.linkSyncSyncing';
  if (state === 'error') return 'entity.companies.linkSyncError';
  return 'entity.companies.linkSyncIdle';
}
