/**
 * Phase 4a.5 — pure-logic tests for the Company detail page.
 *
 * Same rationale as `companies-list-page.test.ts` — the repo has no
 * DOM runtime, so we exercise the reducers + payload builders +
 * validators that the detail page composes. The DOM-driven
 * edit/save/delete-confirm flow lands once the
 * `docs/dev/follow-ups/web-component-tests.md` follow-up resolves.
 */
import { describe, expect, it } from 'bun:test';
import type { Company } from '../src/lib/api-types';
import {
  buildCreateCompanyRequest,
  buildUpdateCompanyRequest,
  companyDetailView,
  draftFromCompany,
  emptyCompanyFormDraft,
  linkSyncStateBadgeKey,
  validateCompanyForm,
} from '../src/pages/companies-page-state';

function makeCompany(overrides: Partial<Company> = {}): Company {
  const base: Company = {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'company',
    layerId: '00000000-0000-0000-0000-0000000000aa',
    slug: 'ami-bv',
    title: 'AMI BV',
    subtitle: '12345678',
    searchableText: 'ami bv',
    meta: {
      createdAt: '2026-05-23T00:00:00.000Z',
      createdBy: '00000000-0000-0000-0000-0000000000bb',
      updatedAt: '2026-05-24T10:00:00.000Z',
      updatedBy: '00000000-0000-0000-0000-0000000000bb',
      deletedAt: null,
      deletedBy: null,
      version: 2,
      originalLocale: 'en',
    },
    payload: {
      legalName: 'AMI BV',
      kvkNumber: '12345678',
      address: { city: 'Amsterdam' },
    },
    externalLinks: [],
    ...overrides,
  };
  return base;
}

describe('companyDetailView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(companyDetailView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(companyDetailView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the ready branch with the company envelope', () => {
    const company = makeCompany();
    const view = companyDetailView({ status: 'ready', company });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.company.slug).toBe('ami-bv');
    }
  });
});

describe('draftFromCompany', () => {
  it('populates the form draft from a loaded company payload', () => {
    const draft = draftFromCompany(makeCompany());
    expect(draft.title).toBe('AMI BV');
    expect(draft.legalName).toBe('AMI BV');
    expect(draft.kvkNumber).toBe('12345678');
    expect(draft.addressCity).toBe('Amsterdam');
  });

  it('fills missing payload fields with empty strings rather than undefined', () => {
    const minimal = makeCompany({ payload: {} });
    const draft = draftFromCompany(minimal);
    expect(draft.legalName).toBe('');
    expect(draft.addressCity).toBe('');
    expect(draft.kvkNumber).toBe('');
  });
});

describe('validateCompanyForm', () => {
  it('rejects an empty title', () => {
    const draft = { ...emptyCompanyFormDraft(), title: '   ' };
    expect(validateCompanyForm(draft)).toBe('errors.entity.companies.validation');
  });

  it('accepts a minimum-viable draft (title only)', () => {
    const draft = { ...emptyCompanyFormDraft(), title: 'AMI BV' };
    expect(validateCompanyForm(draft)).toBeNull();
  });

  it('rejects a kvkNumber that is not 8 digits', () => {
    const draft = { ...emptyCompanyFormDraft(), title: 'AMI BV', kvkNumber: '12' };
    expect(validateCompanyForm(draft)).toBe('errors.entity.companies.kvkInvalid');
  });

  it('accepts a valid 8-digit kvkNumber', () => {
    const draft = { ...emptyCompanyFormDraft(), title: 'AMI BV', kvkNumber: '12345678' };
    expect(validateCompanyForm(draft)).toBeNull();
  });

  it('rejects a malformed website URL', () => {
    const draft = { ...emptyCompanyFormDraft(), title: 'AMI BV', website: 'not a url' };
    expect(validateCompanyForm(draft)).toBe('errors.entity.companies.websiteInvalid');
  });

  it('accepts a valid website URL', () => {
    const draft = { ...emptyCompanyFormDraft(), title: 'AMI BV', website: 'https://example.com' };
    expect(validateCompanyForm(draft)).toBeNull();
  });

  it('rejects a malformed email', () => {
    const draft = { ...emptyCompanyFormDraft(), title: 'AMI BV', email: 'not-an-email' };
    expect(validateCompanyForm(draft)).toBe('errors.entity.companies.emailInvalid');
  });

  it('rejects a description longer than 4000 chars', () => {
    const draft = {
      ...emptyCompanyFormDraft(),
      title: 'AMI BV',
      description: 'x'.repeat(4001),
    };
    expect(validateCompanyForm(draft)).toBe('errors.entity.companies.descriptionTooLong');
  });
});

describe('buildCreateCompanyRequest', () => {
  it('strips empty strings from the payload', () => {
    const draft = {
      ...emptyCompanyFormDraft(),
      title: '  AMI BV  ',
      legalName: '',
      tradeName: 'AMI',
      kvkNumber: '12345678',
    };
    const body = buildCreateCompanyRequest(draft, 'en');
    expect(body.title).toBe('AMI BV');
    expect(body.originalLocale).toBe('en');
    expect(body.payload.legalName).toBeUndefined();
    expect(body.payload.tradeName).toBe('AMI');
    expect(body.payload.kvkNumber).toBe('12345678');
    expect(body.payload.address).toBeUndefined();
  });

  it('includes a non-empty slug override but omits an empty one', () => {
    const baseDraft = { ...emptyCompanyFormDraft(), title: 'AMI BV' };
    expect(buildCreateCompanyRequest({ ...baseDraft, slug: '' }, 'en').slug).toBeUndefined();
    expect(buildCreateCompanyRequest({ ...baseDraft, slug: 'ami-bv' }, 'en').slug).toBe('ami-bv');
  });

  it('emits an address object only when at least one address field is non-empty', () => {
    const baseDraft = { ...emptyCompanyFormDraft(), title: 'AMI BV' };
    expect(buildCreateCompanyRequest(baseDraft, 'en').payload.address).toBeUndefined();
    const withCity = { ...baseDraft, addressCity: 'Amsterdam' };
    expect(buildCreateCompanyRequest(withCity, 'en').payload.address).toEqual({
      city: 'Amsterdam',
    });
  });
});

describe('buildUpdateCompanyRequest', () => {
  it('produces a title + payload pair (no originalLocale)', () => {
    const draft = { ...emptyCompanyFormDraft(), title: 'AMI BV', kvkNumber: '12345678' };
    const body = buildUpdateCompanyRequest(draft);
    expect(body.title).toBe('AMI BV');
    expect(body.payload.kvkNumber).toBe('12345678');
    // The update request shape (zod `UpdateCompanyRequestSchema`) does
    // NOT carry `originalLocale` — it is set at create time only.
    expect(Object.keys(body)).toEqual(['title', 'payload']);
  });
});

describe('linkSyncStateBadgeKey', () => {
  it('maps each sync state to its dedicated i18n key', () => {
    expect(linkSyncStateBadgeKey('idle')).toBe('entity.companies.linkSyncIdle');
    expect(linkSyncStateBadgeKey('syncing')).toBe('entity.companies.linkSyncSyncing');
    expect(linkSyncStateBadgeKey('error')).toBe('entity.companies.linkSyncError');
  });
});
