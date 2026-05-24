/**
 * Phase 4b.5 — pure-logic tests for the Contact detail page.
 *
 * Mirrors `companies-detail-page.test.ts`: covers the reducers,
 * draft↔payload bridge, validators, payload builders, and the
 * array-editor reducers for emails / phones (add / remove / promote-
 * primary). The DOM-driven save / delete-confirm flow lands once the
 * `docs/dev/follow-ups/web-component-tests.md` follow-up resolves.
 */
import { describe, expect, it } from 'bun:test';
import type { Contact, ContactEmail, ContactPhone } from '../src/lib/api-types';
import {
  addEmail,
  addPhone,
  buildCreateContactRequest,
  buildUpdateContactRequest,
  contactDetailView,
  draftFromContact,
  emptyContactFormDraft,
  linkSyncStateBadgeKey,
  primaryEmailFromPayload,
  primaryPhoneFromPayload,
  promotePrimaryEmail,
  promotePrimaryPhone,
  removeEmail,
  removePhone,
  updateEmail,
  updatePhone,
  validateContactForm,
  type ContactEmailDraft,
} from '../src/pages/contacts-page-state';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  const base: Contact = {
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
      version: 2,
      originalLocale: 'en',
    },
    payload: {
      givenName: 'Jane',
      familyName: 'Doe',
      emails: [
        { value: 'jane@example.com', isPrimary: true },
        { value: 'j.doe@work.example', label: 'work' },
      ],
      phones: [{ value: '+31 6 1234 5678' }],
    },
    externalLinks: [],
    ...overrides,
  };
  return base;
}

describe('contactDetailView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(contactDetailView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(contactDetailView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the ready branch with the contact envelope', () => {
    const contact = makeContact();
    const view = contactDetailView({ status: 'ready', contact });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.contact.slug).toBe('jane-doe');
    }
  });
});

describe('draftFromContact', () => {
  it('populates the form draft from a loaded contact payload', () => {
    const draft = draftFromContact(makeContact());
    expect(draft.title).toBe('Jane Doe');
    expect(draft.givenName).toBe('Jane');
    expect(draft.familyName).toBe('Doe');
    expect(draft.emails).toHaveLength(2);
    expect(draft.emails[0]).toEqual({ value: 'jane@example.com', label: '', isPrimary: true });
    expect(draft.emails[1]).toEqual({
      value: 'j.doe@work.example',
      label: 'work',
      isPrimary: false,
    });
    expect(draft.phones).toHaveLength(1);
    expect(draft.phones[0]).toEqual({
      value: '+31 6 1234 5678',
      label: '',
      isPrimary: false,
    });
  });

  it('fills missing payload fields with empty strings / empty arrays', () => {
    const minimal = makeContact({ payload: {} });
    const draft = draftFromContact(minimal);
    expect(draft.givenName).toBe('');
    expect(draft.emails).toHaveLength(0);
    expect(draft.phones).toHaveLength(0);
    expect(draft.companyEntityId).toBeNull();
  });
});

describe('email array editor reducers', () => {
  it('addEmail appends an empty email row', () => {
    const d0 = emptyContactFormDraft();
    const d1 = addEmail(d0);
    expect(d1.emails).toHaveLength(1);
    expect(d1.emails[0]).toEqual({ value: '', label: '', isPrimary: false });
  });

  it('removeEmail drops the row at the given index', () => {
    const d0 = draftFromContact(makeContact());
    const d1 = removeEmail(d0, 0);
    expect(d1.emails).toHaveLength(1);
    expect(d1.emails[0]?.value).toBe('j.doe@work.example');
  });

  it('removeEmail with an out-of-range index is a no-op', () => {
    const d0 = draftFromContact(makeContact());
    const d1 = removeEmail(d0, 99);
    expect(d1).toBe(d0);
  });

  it('updateEmail patches only the targeted row', () => {
    const d0 = draftFromContact(makeContact());
    const d1 = updateEmail(d0, 1, { label: 'work-2' });
    expect(d1.emails[0]?.label).toBe('');
    expect(d1.emails[1]?.label).toBe('work-2');
  });

  it('promotePrimaryEmail marks the targeted row primary and clears the rest', () => {
    const d0 = draftFromContact(makeContact());
    // Initially row 0 is primary.
    expect(d0.emails[0]?.isPrimary).toBe(true);
    expect(d0.emails[1]?.isPrimary).toBe(false);
    const d1 = promotePrimaryEmail(d0, 1);
    expect(d1.emails[0]?.isPrimary).toBe(false);
    expect(d1.emails[1]?.isPrimary).toBe(true);
  });

  it('promotePrimaryEmail with an out-of-range index is a no-op', () => {
    const d0 = draftFromContact(makeContact());
    expect(promotePrimaryEmail(d0, 99)).toBe(d0);
  });
});

describe('phone array editor reducers', () => {
  it('addPhone appends an empty phone row', () => {
    const d0 = emptyContactFormDraft();
    const d1 = addPhone(d0);
    expect(d1.phones).toHaveLength(1);
    expect(d1.phones[0]).toEqual({ value: '', label: '', isPrimary: false });
  });

  it('removePhone drops the row at the given index', () => {
    const d0 = draftFromContact(makeContact());
    const d1 = removePhone(d0, 0);
    expect(d1.phones).toHaveLength(0);
  });

  it('updatePhone patches only the targeted row', () => {
    const d0 = addPhone(addPhone(emptyContactFormDraft()));
    const d1 = updatePhone(d0, 1, { value: '+1 555 1234', label: 'mobile' });
    expect(d1.phones[0]?.value).toBe('');
    expect(d1.phones[1]?.value).toBe('+1 555 1234');
    expect(d1.phones[1]?.label).toBe('mobile');
  });

  it('promotePrimaryPhone marks the targeted row primary and clears the rest', () => {
    const d0 = addPhone(addPhone(emptyContactFormDraft()));
    const d1 = promotePrimaryPhone(d0, 1);
    expect(d1.phones[0]?.isPrimary).toBe(false);
    expect(d1.phones[1]?.isPrimary).toBe(true);
  });
});

describe('validateContactForm', () => {
  it('rejects an empty title', () => {
    const draft = { ...emptyContactFormDraft(), title: '   ' };
    expect(validateContactForm(draft)).toBe('errors.entity.contacts.validation');
  });

  it('accepts a minimum-viable draft (title only)', () => {
    const draft = { ...emptyContactFormDraft(), title: 'Jane Doe' };
    expect(validateContactForm(draft)).toBeNull();
  });

  it('rejects a malformed email value in the array', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      emails: [{ value: 'not-an-email', label: '', isPrimary: false }] as ContactEmailDraft[],
    };
    expect(validateContactForm(draft)).toBe('errors.entity.contacts.validation');
  });

  it('rejects duplicate emails by lower-cased value', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      emails: [
        { value: 'jane@example.com', label: '', isPrimary: true },
        { value: 'JANE@example.com', label: 'work', isPrimary: false },
      ] as ContactEmailDraft[],
    };
    expect(validateContactForm(draft)).toBe('errors.entity.contacts.emailDuplicate');
  });

  it('skips empty email rows when validating', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      emails: [{ value: '', label: '', isPrimary: false }] as ContactEmailDraft[],
    };
    expect(validateContactForm(draft)).toBeNull();
  });

  it('rejects a malformed birthday string', () => {
    const draft = { ...emptyContactFormDraft(), title: 'Jane Doe', birthday: '24-05-2026' };
    expect(validateContactForm(draft)).toBe('errors.entity.contacts.validation');
  });

  it('accepts an ISO birthday string', () => {
    const draft = { ...emptyContactFormDraft(), title: 'Jane Doe', birthday: '1990-04-23' };
    expect(validateContactForm(draft)).toBeNull();
  });

  it('rejects notes longer than 4000 chars', () => {
    const draft = { ...emptyContactFormDraft(), title: 'Jane Doe', notes: 'x'.repeat(4001) };
    expect(validateContactForm(draft)).toBe('errors.entity.contacts.validation');
  });
});

describe('buildCreateContactRequest', () => {
  it('strips empty strings from the payload and trims the title', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: '  Jane Doe  ',
      givenName: '',
      familyName: 'Doe',
    };
    const body = buildCreateContactRequest(draft, 'en');
    expect(body.title).toBe('Jane Doe');
    expect(body.originalLocale).toBe('en');
    expect(body.payload.givenName).toBeUndefined();
    expect(body.payload.familyName).toBe('Doe');
    expect(body.payload.emails).toBeUndefined();
    expect(body.payload.phones).toBeUndefined();
  });

  it('emits emails only when at least one row has a non-empty value', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      emails: [
        { value: '', label: '', isPrimary: false },
        { value: 'jane@example.com', label: 'home', isPrimary: true },
      ] as ContactEmailDraft[],
    };
    const body = buildCreateContactRequest(draft, 'en');
    const emails = body.payload.emails as readonly ContactEmail[] | undefined;
    expect(emails).toBeDefined();
    expect(emails).toHaveLength(1);
    expect(emails?.[0]).toEqual({ value: 'jane@example.com', label: 'home', isPrimary: true });
  });

  it('omits an isPrimary key when the row is not flagged', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      phones: [{ value: '+1 555 1234', label: '', isPrimary: false }],
    };
    const body = buildCreateContactRequest(draft, 'en');
    const phones = body.payload.phones as readonly ContactPhone[] | undefined;
    expect(phones?.[0]).toEqual({ value: '+1 555 1234' });
  });

  it('de-duplicates emails in the built payload by lower-cased value', () => {
    const draft = {
      ...emptyContactFormDraft(),
      title: 'Jane Doe',
      emails: [
        { value: 'jane@example.com', label: '', isPrimary: false },
        { value: 'JANE@example.com', label: 'dup', isPrimary: false },
      ] as ContactEmailDraft[],
    };
    const body = buildCreateContactRequest(draft, 'en');
    expect(body.payload.emails).toHaveLength(1);
  });

  it('includes a non-empty slug override but omits an empty one', () => {
    const base = { ...emptyContactFormDraft(), title: 'Jane Doe' };
    expect(buildCreateContactRequest({ ...base, slug: '' }, 'en').slug).toBeUndefined();
    expect(buildCreateContactRequest({ ...base, slug: 'jane-doe' }, 'en').slug).toBe('jane-doe');
  });

  it('includes a non-null companyEntityId on the payload', () => {
    const id = '00000000-0000-0000-0000-0000000000ff';
    const draft = { ...emptyContactFormDraft(), title: 'Jane Doe', companyEntityId: id };
    const body = buildCreateContactRequest(draft, 'en');
    expect(body.payload.companyEntityId).toBe(id);
  });
});

describe('buildUpdateContactRequest', () => {
  it('produces a title + payload pair (no originalLocale)', () => {
    const draft = { ...emptyContactFormDraft(), title: 'Jane Doe' };
    const body = buildUpdateContactRequest(draft);
    expect(body.title).toBe('Jane Doe');
    expect(Object.keys(body)).toEqual(['title', 'payload']);
  });
});

describe('linkSyncStateBadgeKey', () => {
  it('maps each sync state to its dedicated i18n key', () => {
    expect(linkSyncStateBadgeKey('idle')).toBe('entity.contacts.linkSyncIdle');
    expect(linkSyncStateBadgeKey('syncing')).toBe('entity.contacts.linkSyncSyncing');
    expect(linkSyncStateBadgeKey('error')).toBe('entity.contacts.linkSyncError');
  });
});

describe('primary email/phone selectors', () => {
  it('returns the first isPrimary email when one is flagged', () => {
    expect(
      primaryEmailFromPayload({
        emails: [{ value: 'a@x.com' }, { value: 'b@x.com', isPrimary: true }],
      }),
    ).toBe('b@x.com');
  });

  it('falls back to the first email when no isPrimary is flagged', () => {
    expect(
      primaryEmailFromPayload({
        emails: [{ value: 'a@x.com' }, { value: 'b@x.com' }],
      }),
    ).toBe('a@x.com');
  });

  it('returns null when there are no emails', () => {
    expect(primaryEmailFromPayload({})).toBeNull();
  });

  it('mirrors the same logic for phones', () => {
    expect(
      primaryPhoneFromPayload({
        phones: [{ value: '+1' }, { value: '+2', isPrimary: true }],
      }),
    ).toBe('+2');
    expect(primaryPhoneFromPayload({})).toBeNull();
  });
});
