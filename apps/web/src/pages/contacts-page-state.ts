/**
 * Phase 4b.5 — pure helpers for the contacts pages.
 *
 * Same rationale as `companies-page-state.ts`: the web repo has no DOM
 * runtime (see `docs/dev/follow-ups/web-component-tests.md`), so the
 * per-page logic is factored into pure functions exercised by
 * `bun test`. The matrix mirrors the Companies surface 1:1, with extra
 * reducer helpers for the `emails[]` / `phones[]` array editors:
 *
 *  - `contactsListView` — loading / error / empty / ready branches.
 *  - `contactDetailView` — loading / error / ready for the detail page.
 *  - `validateContactForm` — inline form validation matching
 *    `ContactPayloadSchema`. Returns the i18n key of the first failure,
 *    or `null` when the draft is shippable.
 *  - `buildCreateContactRequest` / `buildUpdateContactRequest` — produce
 *    the JSON bodies the server expects, stripping empty strings,
 *    promoting `isPrimary`, and de-duplicating emails by lower-cased
 *    value.
 *  - `addEmail` / `removeEmail` / `promotePrimaryEmail` — and the
 *    matching `phone` triplet — implement the array-editor operations
 *    the detail form binds to. Pure functions so the matrix is
 *    testable without a DOM.
 *  - `linkSyncStateBadgeKey` — maps an external-link `sync_state` to
 *    the user-visible status badge i18n key.
 */
import type {
  Contact,
  ContactEmail,
  ContactPayload,
  ContactPhone,
  CreateContactPayload,
  EntitySummary,
  EntitySyncState,
  UpdateContactPayload,
} from '../lib/api-types';

// ---------- list page ------------------------------------------------------

export type ContactsListInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly contacts: readonly EntitySummary[] };

export type ContactsListView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly contacts: readonly EntitySummary[] };

export function contactsListView(input: ContactsListInput): ContactsListView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  if (input.contacts.length === 0) return { kind: 'empty' };
  return { kind: 'ready', contacts: input.contacts };
}

// ---------- detail page ----------------------------------------------------

export type ContactDetailInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly contact: Contact };

export type ContactDetailView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly contact: Contact };

export function contactDetailView(input: ContactDetailInput): ContactDetailView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  return { kind: 'ready', contact: input.contact };
}

// ---------- form draft -----------------------------------------------------

export interface ContactEmailDraft {
  readonly value: string;
  readonly label: string;
  readonly isPrimary: boolean;
}

export interface ContactPhoneDraft {
  readonly value: string;
  readonly label: string;
  readonly isPrimary: boolean;
}

export interface ContactFormDraft {
  readonly title: string;
  readonly slug?: string;
  readonly givenName: string;
  readonly familyName: string;
  readonly displayName: string;
  readonly emails: readonly ContactEmailDraft[];
  readonly phones: readonly ContactPhoneDraft[];
  readonly companyEntityId: string | null;
  readonly jobTitle: string;
  readonly notes: string;
  readonly birthday: string;
}

export function emptyContactFormDraft(): ContactFormDraft {
  return {
    title: '',
    slug: '',
    givenName: '',
    familyName: '',
    displayName: '',
    emails: [],
    phones: [],
    companyEntityId: null,
    jobTitle: '',
    notes: '',
    birthday: '',
  };
}

function emailDraftFromPayload(e: ContactEmail): ContactEmailDraft {
  return {
    value: e.value,
    label: e.label ?? '',
    isPrimary: e.isPrimary === true,
  };
}

function phoneDraftFromPayload(p: ContactPhone): ContactPhoneDraft {
  return {
    value: p.value,
    label: p.label ?? '',
    isPrimary: p.isPrimary === true,
  };
}

export function draftFromContact(contact: Contact): ContactFormDraft {
  const p = contact.payload;
  return {
    title: contact.title,
    slug: contact.slug,
    givenName: p.givenName ?? '',
    familyName: p.familyName ?? '',
    displayName: p.displayName ?? '',
    emails: (p.emails ?? []).map(emailDraftFromPayload),
    phones: (p.phones ?? []).map(phoneDraftFromPayload),
    companyEntityId: p.companyEntityId ?? null,
    jobTitle: p.jobTitle ?? '',
    notes: p.notes ?? '',
    birthday: p.birthday ?? '',
  };
}

// ---------- email / phone array editors ------------------------------------

export function emptyEmailDraft(): ContactEmailDraft {
  return { value: '', label: '', isPrimary: false };
}

export function emptyPhoneDraft(): ContactPhoneDraft {
  return { value: '', label: '', isPrimary: false };
}

export function addEmail(draft: ContactFormDraft): ContactFormDraft {
  return { ...draft, emails: [...draft.emails, emptyEmailDraft()] };
}

export function removeEmail(draft: ContactFormDraft, index: number): ContactFormDraft {
  if (index < 0 || index >= draft.emails.length) return draft;
  const next = draft.emails.filter((_, i) => i !== index);
  return { ...draft, emails: next };
}

export function updateEmail(
  draft: ContactFormDraft,
  index: number,
  patch: Partial<ContactEmailDraft>,
): ContactFormDraft {
  if (index < 0 || index >= draft.emails.length) return draft;
  const next = draft.emails.map((e, i) => (i === index ? { ...e, ...patch } : e));
  return { ...draft, emails: next };
}

/**
 * Mark `index` as the primary email and clear `isPrimary` on every other
 * row. The server schema does not enforce uniqueness of `isPrimary`, but
 * the indexed `primary_email` projection takes the first `isPrimary: true`
 * row; keeping the UI in lockstep avoids surprising the user.
 */
export function promotePrimaryEmail(draft: ContactFormDraft, index: number): ContactFormDraft {
  if (index < 0 || index >= draft.emails.length) return draft;
  const next = draft.emails.map((e, i) => ({ ...e, isPrimary: i === index }));
  return { ...draft, emails: next };
}

export function addPhone(draft: ContactFormDraft): ContactFormDraft {
  return { ...draft, phones: [...draft.phones, emptyPhoneDraft()] };
}

export function removePhone(draft: ContactFormDraft, index: number): ContactFormDraft {
  if (index < 0 || index >= draft.phones.length) return draft;
  const next = draft.phones.filter((_, i) => i !== index);
  return { ...draft, phones: next };
}

export function updatePhone(
  draft: ContactFormDraft,
  index: number,
  patch: Partial<ContactPhoneDraft>,
): ContactFormDraft {
  if (index < 0 || index >= draft.phones.length) return draft;
  const next = draft.phones.map((p, i) => (i === index ? { ...p, ...patch } : p));
  return { ...draft, phones: next };
}

export function promotePrimaryPhone(draft: ContactFormDraft, index: number): ContactFormDraft {
  if (index < 0 || index >= draft.phones.length) return draft;
  const next = draft.phones.map((p, i) => ({ ...p, isPrimary: i === index }));
  return { ...draft, phones: next };
}

// ---------- validation -----------------------------------------------------

/**
 * Inline form validation mirroring `ContactPayloadSchema`. Returns the
 * i18n key of the first failure, or `null` when the draft is shippable.
 * The server is the source of truth and re-validates every payload; this
 * helper just trims the round-trip for the obvious cases.
 */
export function validateContactForm(draft: ContactFormDraft): string | null {
  if (draft.title.trim().length === 0) {
    return 'errors.entity.contacts.validation';
  }
  const seenEmails = new Set<string>();
  for (const e of draft.emails) {
    const v = e.value.trim();
    if (v.length === 0) continue;
    if (!isProbablyEmail(v)) {
      return 'errors.entity.contacts.validation';
    }
    const key = v.toLowerCase();
    if (seenEmails.has(key)) {
      return 'errors.entity.contacts.emailDuplicate';
    }
    seenEmails.add(key);
  }
  for (const p of draft.phones) {
    const v = p.value.trim();
    if (v.length === 0) continue;
    if (v.length > 64) {
      return 'errors.entity.contacts.validation';
    }
  }
  if (draft.notes.length > 4000) {
    return 'errors.entity.contacts.validation';
  }
  if (draft.birthday.trim().length > 0 && !/^\d{4}-\d{2}-\d{2}$/.test(draft.birthday.trim())) {
    return 'errors.entity.contacts.validation';
  }
  return null;
}

function isProbablyEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

// ---------- payload builders -----------------------------------------------

function buildEmails(drafts: readonly ContactEmailDraft[]): readonly ContactEmail[] | undefined {
  const out: ContactEmail[] = [];
  const seen = new Set<string>();
  for (const d of drafts) {
    const value = d.value.trim();
    if (value.length === 0) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entry: { value: string; label?: string; isPrimary?: boolean } = { value };
    const label = d.label.trim();
    if (label.length > 0) entry.label = label;
    if (d.isPrimary) entry.isPrimary = true;
    out.push(entry as ContactEmail);
  }
  return out.length > 0 ? out : undefined;
}

function buildPhones(drafts: readonly ContactPhoneDraft[]): readonly ContactPhone[] | undefined {
  const out: ContactPhone[] = [];
  for (const d of drafts) {
    const value = d.value.trim();
    if (value.length === 0) continue;
    const entry: { value: string; label?: string; isPrimary?: boolean } = { value };
    const label = d.label.trim();
    if (label.length > 0) entry.label = label;
    if (d.isPrimary) entry.isPrimary = true;
    out.push(entry as ContactPhone);
  }
  return out.length > 0 ? out : undefined;
}

function buildPayload(draft: ContactFormDraft): ContactPayload {
  const payload: Record<string, unknown> = {};
  function pick(key: keyof ContactPayload, value: string): void {
    const trimmed = value.trim();
    if (trimmed.length > 0) payload[key] = trimmed;
  }
  pick('givenName', draft.givenName);
  pick('familyName', draft.familyName);
  pick('displayName', draft.displayName);
  pick('jobTitle', draft.jobTitle);
  pick('notes', draft.notes);
  pick('birthday', draft.birthday);

  const emails = buildEmails(draft.emails);
  if (emails !== undefined) payload.emails = emails;
  const phones = buildPhones(draft.phones);
  if (phones !== undefined) payload.phones = phones;

  if (draft.companyEntityId !== null && draft.companyEntityId.length > 0) {
    payload.companyEntityId = draft.companyEntityId;
  }
  return payload as ContactPayload;
}

export function buildCreateContactRequest(
  draft: ContactFormDraft,
  originalLocale: string,
): CreateContactPayload {
  const out: {
    title: string;
    slug?: string;
    originalLocale: string;
    payload: ContactPayload;
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

export function buildUpdateContactRequest(draft: ContactFormDraft): UpdateContactPayload {
  return {
    title: draft.title.trim(),
    payload: buildPayload(draft),
  };
}

// ---------- external links --------------------------------------------------

export function linkSyncStateBadgeKey(state: EntitySyncState): string {
  if (state === 'syncing') return 'entity.contacts.linkSyncSyncing';
  if (state === 'error') return 'entity.contacts.linkSyncError';
  return 'entity.contacts.linkSyncIdle';
}

// ---------- view helpers ----------------------------------------------------

/**
 * Resolve the primary email value for the list-row "email" column. Returns
 * `null` when the contact has no usable email. The first `isPrimary: true`
 * entry wins; otherwise the first entry by index.
 */
export function primaryEmailFromPayload(payload: ContactPayload): string | null {
  const emails = payload.emails ?? [];
  for (const e of emails) {
    if (e.isPrimary === true) return e.value;
  }
  return emails[0]?.value ?? null;
}

export function primaryPhoneFromPayload(payload: ContactPayload): string | null {
  const phones = payload.phones ?? [];
  for (const p of phones) {
    if (p.isPrimary === true) return p.value;
  }
  return phones[0]?.value ?? null;
}
