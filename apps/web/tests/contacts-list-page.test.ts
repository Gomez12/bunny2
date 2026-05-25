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
import type { ContactEmail, ContactPhone, EntitySummary } from '../src/lib/api-types';
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
import {
  buildCreateContactRequest,
  contactsListView,
  emptyContactFormDraft,
  validateContactForm,
  type ContactEmailDraft,
  type ContactPhoneDraft,
  type ContactsListInput,
} from '../src/pages/contacts-page-state';

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

// ---------------------------------------------------------------------------
// Create-dialog branches.
//
// The `contacts-manual-create` follow-up extended `CreateContactDialog` to
// expose the same rich editors the detail page already renders (emails,
// phones, jobTitle, company link, notes). These rows assert that the
// shared validator + payload builder cover every new branch the dialog
// hands them. The detail-page test file already covers `validateContactForm`
// at the unit level; here we anchor the create dialog's contract — a
// rename or a payload-shape regression in either function would fail.

describe('CreateContactDialog payload contract', () => {
  it('rejects a draft with an invalid email entered via the create dialog', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      emails: [{ value: 'not-an-email', label: '', isPrimary: false }] as ContactEmailDraft[],
    };
    expect(validateContactForm(draft)).toBe('errors.entity.contacts.validation');
  });

  it('rejects a draft with a phone number longer than 64 chars', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      phones: [{ value: '+1 '.repeat(40), label: '', isPrimary: false }] as ContactPhoneDraft[],
    };
    expect(validateContactForm(draft)).toBe('errors.entity.contacts.validation');
  });

  it('accepts a full rich draft (emails, phones, jobTitle, company, notes)', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      givenName: 'Jane',
      familyName: 'Doe',
      jobTitle: 'Engineer',
      notes: 'met at conference',
      companyEntityId: '00000000-0000-0000-0000-0000000000ff',
      emails: [
        { value: 'jane@example.com', label: 'home', isPrimary: true },
        { value: 'j.doe@work.example', label: 'work', isPrimary: false },
      ] as ContactEmailDraft[],
      phones: [
        { value: '+31 6 1234 5678', label: 'mobile', isPrimary: true },
      ] as ContactPhoneDraft[],
    };
    expect(validateContactForm(draft)).toBeNull();

    const body = buildCreateContactRequest(draft, 'en');
    expect(body.title).toBe('Jane Doe');
    expect(body.originalLocale).toBe('en');
    expect(body.payload.givenName).toBe('Jane');
    expect(body.payload.familyName).toBe('Doe');
    expect(body.payload.jobTitle).toBe('Engineer');
    expect(body.payload.notes).toBe('met at conference');
    expect(body.payload.companyEntityId).toBe('00000000-0000-0000-0000-0000000000ff');
    const emails = body.payload.emails as readonly ContactEmail[] | undefined;
    expect(emails).toHaveLength(2);
    expect(emails?.[0]).toEqual({ value: 'jane@example.com', label: 'home', isPrimary: true });
    const phones = body.payload.phones as readonly ContactPhone[] | undefined;
    expect(phones).toHaveLength(1);
    expect(phones?.[0]).toEqual({ value: '+31 6 1234 5678', label: 'mobile', isPrimary: true });
  });

  it('drops empty optional sub-editor rows when serialising the create payload', () => {
    // The dialog lets the user "Add email" / "Add phone" then leave the
    // row empty. The payload builder must skip those rows entirely so the
    // server schema's `min length` checks do not fire on placeholders.
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      emails: [
        { value: '', label: '', isPrimary: false },
        { value: 'jane@example.com', label: '', isPrimary: false },
      ] as ContactEmailDraft[],
      phones: [{ value: '   ', label: 'mobile', isPrimary: false }] as ContactPhoneDraft[],
      jobTitle: '   ',
      notes: '   ',
    };
    expect(validateContactForm(draft)).toBeNull();
    const body = buildCreateContactRequest(draft, 'en');
    expect(body.payload.emails).toHaveLength(1);
    expect(body.payload.phones).toBeUndefined();
    expect(body.payload.jobTitle).toBeUndefined();
    expect(body.payload.notes).toBeUndefined();
  });
});
