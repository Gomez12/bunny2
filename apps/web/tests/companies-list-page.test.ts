/**
 * Phase 4a.5 — pure-logic tests for the Companies list page.
 *
 * The repo has no DOM runtime (see
 * `docs/dev/follow-ups/web-component-tests.md`), so we exercise the
 * pure reducer + helpers used by `CompaniesListPage.tsx` instead of
 * mounting the component. The same pattern is used by
 * `apps/web/tests/companies-widget.test.ts` (phase 4a.4).
 *
 * Covered:
 *
 *   - `companiesListView` maps loading / error / empty / ready inputs
 *     to the exact render branches the page draws.
 *   - The singular ↔ plural URL mapping helpers in `companies-routes`
 *     return the shapes the dashboard widget + router rely on. A
 *     rename in one without the other would break the seam.
 *   - `slugifyCompanyTitle` follows the same `^[a-z0-9-]+$` rule the
 *     server enforces in `CreateCompanyRequestSchema`.
 */
import { describe, expect, it } from 'bun:test';
import type { EntitySummary } from '../src/lib/api-types';
import { i18nKeysForKind, isSoftDeleted, restoreTelemetryName } from '../src/lib/entity-restore';
import {
  COMPANIES_SERVER_KIND,
  COMPANIES_WEB_SEGMENT,
  companiesListWebRoute,
  companiesNewWebRoute,
  companiesServerBase,
  companyDetailWebRoute,
  companyServerDetail,
  companyServerExternalLink,
  companyServerExternalLinks,
  slugifyCompanyTitle,
} from '../src/lib/companies-routes';
import { companiesListView, type CompaniesListInput } from '../src/pages/companies-page-state';

function summary(overrides: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'company',
    layerId: '00000000-0000-0000-0000-0000000000aa',
    slug: 'ami-bv',
    title: 'AMI BV',
    subtitle: null,
    searchableText: 'ami bv',
    meta: {
      createdAt: '2026-05-23T00:00:00.000Z',
      createdBy: '00000000-0000-0000-0000-0000000000bb',
      updatedAt: '2026-05-24T10:00:00.000Z',
      updatedBy: '00000000-0000-0000-0000-0000000000bb',
      deletedAt: null,
      deletedBy: null,
      version: 1,
      originalLocale: 'en',
    },
    ...overrides,
  };
}

describe('companiesListView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(companiesListView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    const input: CompaniesListInput = { status: 'error', errorKey: 'errors.network' };
    expect(companiesListView(input)).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the empty branch when the companies list is empty', () => {
    expect(companiesListView({ status: 'ready', companies: [] })).toEqual({ kind: 'empty' });
  });

  it('returns the ready branch with the array when the list is non-empty', () => {
    const view = companiesListView({ status: 'ready', companies: [summary()] });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.companies).toHaveLength(1);
      expect(view.companies[0]?.slug).toBe('ami-bv');
    }
  });

  it('treats a single-row ready input as ready, not empty', () => {
    const view = companiesListView({ status: 'ready', companies: [summary()] });
    expect(view.kind).toBe('ready');
  });
});

describe('companies-routes URL helpers', () => {
  it('exposes singular server kind and plural web segment constants', () => {
    expect(COMPANIES_SERVER_KIND).toBe('company');
    expect(COMPANIES_WEB_SEGMENT).toBe('companies');
  });

  it('produces the plural web list route', () => {
    expect(companiesListWebRoute('personal-admin')).toBe('/l/personal-admin/companies');
  });

  it('produces the plural web detail route', () => {
    expect(companyDetailWebRoute('personal-admin', 'ami-bv')).toBe(
      '/l/personal-admin/companies/ami-bv',
    );
  });

  it('produces the plural web "new" deep-link route', () => {
    expect(companiesNewWebRoute('personal-admin')).toBe('/l/personal-admin/companies/new');
  });

  it('produces the singular server base used by the API client', () => {
    expect(companiesServerBase('personal-admin')).toBe('/l/personal-admin/company');
  });

  it('produces the singular server detail URL', () => {
    expect(companyServerDetail('personal-admin', 'ami-bv')).toBe(
      '/l/personal-admin/company/ami-bv',
    );
  });

  it('produces the singular server external-links URLs', () => {
    expect(companyServerExternalLinks('personal-admin', 'ami-bv')).toBe(
      '/l/personal-admin/company/ami-bv/external-links',
    );
    expect(companyServerExternalLink('personal-admin', 'ami-bv', 'link-1')).toBe(
      '/l/personal-admin/company/ami-bv/external-links/link-1',
    );
  });

  it('percent-encodes layer and company slug segments in server URLs', () => {
    expect(companyServerDetail('a b', 'c d')).toBe('/l/a%20b/company/c%20d');
  });
});

// ---------------------------------------------------------------------------
// Phase 1 (ui-exposure-gaps) — soft-delete restore surface.
//
// Pure-logic coverage for the Companies list/detail surface: the
// `isSoftDeleted` decision used by the list-row Deleted badge and the
// detail-page Restore banner, plus the per-kind i18n key namespace
// and the telemetry-name placeholder. The page itself remains
// untested (no DOM runtime in this repo, see
// `docs/dev/follow-ups/web-component-tests.md`).
describe('soft-delete restore (companies)', () => {
  it('default-list reducer hides nothing extra — soft-deleted rows still flow through', () => {
    // The reducer is shape-agnostic: filtering happens server-side via
    // `?includeDeleted=true`. When the server returns a deleted row,
    // the reducer should pass it through so the page renders it with
    // the badge.
    const deleted = summary({
      meta: {
        createdAt: '2026-05-23T00:00:00.000Z',
        createdBy: '00000000-0000-0000-0000-0000000000bb',
        updatedAt: '2026-05-24T10:00:00.000Z',
        updatedBy: '00000000-0000-0000-0000-0000000000bb',
        deletedAt: '2026-05-24T11:00:00.000Z',
        deletedBy: '00000000-0000-0000-0000-0000000000bb',
        version: 2,
        originalLocale: 'en',
      },
    });
    const view = companiesListView({ status: 'ready', companies: [deleted] });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.companies).toHaveLength(1);
      expect(view.companies[0]?.meta.deletedAt).toBe('2026-05-24T11:00:00.000Z');
    }
  });

  it('isSoftDeleted is true exactly when deletedAt is non-null', () => {
    expect(isSoftDeleted({ deletedAt: null })).toBe(false);
    expect(isSoftDeleted({ deletedAt: '2026-05-24T11:00:00.000Z' })).toBe(true);
  });

  it('i18nKeysForKind("company") returns the per-kind namespace', () => {
    const keys = i18nKeysForKind('company');
    expect(keys.deletedBadge).toBe('entity.companies.restore.deletedBadge');
    expect(keys.bannerTitle).toBe('entity.companies.restore.bannerTitle');
    expect(keys.restoreCta).toBe('entity.companies.restore.cta');
    expect(keys.confirmTitle).toBe('entity.companies.restore.confirmTitle');
    expect(keys.toggleShowDeleted).toBe('entity.companies.restore.toggleShowDeleted');
  });

  it('restoreTelemetryName uses the stable dotted name', () => {
    expect(restoreTelemetryName('company')).toBe('entity.company.restore');
  });
});

describe('slugifyCompanyTitle', () => {
  it('lowercases, replaces non-alphanumeric runs with single dashes, and trims', () => {
    expect(slugifyCompanyTitle('AMI BV')).toBe('ami-bv');
    expect(slugifyCompanyTitle('  Foo  Bar!  ')).toBe('foo-bar');
    expect(slugifyCompanyTitle('multi---dash')).toBe('multi-dash');
  });

  it('caps the slug length at 64 characters', () => {
    const long = 'x'.repeat(100);
    expect(slugifyCompanyTitle(long).length).toBeLessThanOrEqual(64);
  });

  it('returns an empty string when the input has no slug-friendly chars', () => {
    expect(slugifyCompanyTitle('!!!')).toBe('');
  });
});
