/**
 * Phase 4b.5 — pure-logic tests for the Contacts list page.
 *
 * The web repo has no DOM runtime (see
 * `docs/dev/follow-ups/web-component-tests.md`), so we exercise the
 * pure reducer + helpers used by `ContactsListPage.tsx`. Same shape as
 * `companies-list-page.test.ts` (4a.5).
 *
 * Covered:
 *
 *   - `contactsListView` maps loading / error / empty / ready inputs to
 *     the exact render branches the page draws.
 *   - The singular ↔ plural URL mapping helpers in `contacts-routes`
 *     return the shapes the dashboard widget + router rely on. A rename
 *     in one without the other would break the seam.
 *   - `slugifyContactTitle` follows the same `^[a-z0-9-]+$` rule the
 *     server enforces in `CreateContactRequestSchema`.
 */
import { describe, expect, it } from 'bun:test';
import type { EntitySummary } from '../src/lib/api-types';
import {
  CONTACTS_SERVER_KIND,
  CONTACTS_WEB_SEGMENT,
  contactDetailWebRoute,
  contactServerDetail,
  contactServerExternalLink,
  contactServerExternalLinks,
  contactsImportWebRoute,
  contactsListWebRoute,
  contactsNewWebRoute,
  contactsServerBase,
  slugifyContactTitle,
} from '../src/lib/contacts-routes';
import { contactsListView, type ContactsListInput } from '../src/pages/contacts-page-state';

function summary(overrides: Partial<EntitySummary> = {}): EntitySummary {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    kind: 'contact',
    layerId: '00000000-0000-0000-0000-0000000000aa',
    slug: 'jane-doe',
    title: 'Jane Doe',
    subtitle: 'jane@example.com',
    searchableText: 'jane doe',
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

describe('contactsListView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(contactsListView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    const input: ContactsListInput = { status: 'error', errorKey: 'errors.network' };
    expect(contactsListView(input)).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the empty branch when the contacts list is empty', () => {
    expect(contactsListView({ status: 'ready', contacts: [] })).toEqual({ kind: 'empty' });
  });

  it('returns the ready branch with the array when the list is non-empty', () => {
    const view = contactsListView({ status: 'ready', contacts: [summary()] });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.contacts).toHaveLength(1);
      expect(view.contacts[0]?.slug).toBe('jane-doe');
    }
  });

  it('treats a single-row ready input as ready, not empty', () => {
    const view = contactsListView({ status: 'ready', contacts: [summary()] });
    expect(view.kind).toBe('ready');
  });
});

describe('contacts-routes URL helpers', () => {
  it('exposes singular server kind and plural web segment constants', () => {
    expect(CONTACTS_SERVER_KIND).toBe('contact');
    expect(CONTACTS_WEB_SEGMENT).toBe('contacts');
  });

  it('produces the plural web list route', () => {
    expect(contactsListWebRoute('personal-admin')).toBe('/l/personal-admin/contacts');
  });

  it('produces the plural web detail route', () => {
    expect(contactDetailWebRoute('personal-admin', 'jane-doe')).toBe(
      '/l/personal-admin/contacts/jane-doe',
    );
  });

  it('produces the plural web "new" deep-link route', () => {
    expect(contactsNewWebRoute('personal-admin')).toBe('/l/personal-admin/contacts/new');
  });

  it('produces the plural web "import" deep-link route', () => {
    expect(contactsImportWebRoute('personal-admin')).toBe('/l/personal-admin/contacts/import');
  });

  it('produces the singular server base used by the API client', () => {
    expect(contactsServerBase('personal-admin')).toBe('/l/personal-admin/contact');
  });

  it('produces the singular server detail URL', () => {
    expect(contactServerDetail('personal-admin', 'jane-doe')).toBe(
      '/l/personal-admin/contact/jane-doe',
    );
  });

  it('produces the singular server external-links URLs', () => {
    expect(contactServerExternalLinks('personal-admin', 'jane-doe')).toBe(
      '/l/personal-admin/contact/jane-doe/external-links',
    );
    expect(contactServerExternalLink('personal-admin', 'jane-doe', 'link-1')).toBe(
      '/l/personal-admin/contact/jane-doe/external-links/link-1',
    );
  });

  it('percent-encodes layer and contact slug segments in server URLs', () => {
    expect(contactServerDetail('a b', 'c d')).toBe('/l/a%20b/contact/c%20d');
  });
});

describe('slugifyContactTitle', () => {
  it('lowercases, replaces non-alphanumeric runs with single dashes, and trims', () => {
    expect(slugifyContactTitle('Jane Doe')).toBe('jane-doe');
    expect(slugifyContactTitle('  Foo  Bar!  ')).toBe('foo-bar');
    expect(slugifyContactTitle('multi---dash')).toBe('multi-dash');
  });

  it('caps the slug length at 64 characters', () => {
    const long = 'x'.repeat(100);
    expect(slugifyContactTitle(long).length).toBeLessThanOrEqual(64);
  });

  it('returns an empty string when the input has no slug-friendly chars', () => {
    expect(slugifyContactTitle('!!!')).toBe('');
  });
});
