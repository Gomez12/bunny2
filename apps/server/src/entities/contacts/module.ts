import { ContactPayloadSchema, type ContactPayload } from '@bunny2/shared';
import type { EntityModule } from '../module';

/**
 * Phase 4b.1 — second concrete `EntityModule`.
 *
 * Wires:
 *  - `kind = 'contact'` — the bus event prefix (`entity.contact.*`) and
 *    the URL segment (`/l/:slug/contact/...`, singular per the §4.0
 *    router naming).
 *  - `tableName = 'contacts'` — the per-kind table created in
 *    `0008_contacts.sql`.
 *  - `payloadSchema` — the cross-package zod schema from
 *    `packages/shared/src/contacts.ts`.
 *  - `indexedColumns` — three denormalized columns (`primary_email`,
 *    `primary_phone`, `company_entity_id`) the generic store writes on
 *    every insert/update. The §4.0 foundation already accepts the slot
 *    (added in 4a.1); 4b.1 needs zero further foundation tweaks.
 *  - `toSummary` — picks a sensible subtitle (primary email first,
 *    primary phone second, jobTitle third) so the listing page is
 *    useful without opening detail view.
 *  - `searchableText` — lowercase, space-joined digest of the fields a
 *    user is most likely to search for. The §4.0 `searchSummaries`
 *    lowercases the query, so the digest is lowercased here too.
 *
 * No connectors / enrichment jobs / stats provider in 4b.1 — the vCard
 * import lands in 4b.2, the contact↔company suggestion lands in 4b.3,
 * and the dashboard widget lands in 4b.4. The factory shape mirrors
 * `createCompanyModule` so those sub-phases stay additive (each one
 * passes its own deps without changing the module's exported surface).
 */
export const CONTACT_KIND = 'contact';
export const CONTACT_TABLE = 'contacts';

/**
 * Phase 4b.1 has no runtime deps yet; the option type is intentionally
 * an empty `Record` so 4b.2 (vCard connector) and 4b.3 (AI enrichment)
 * can extend it additively without breaking the existing call sites.
 * Using `Record<string, never>` instead of an empty interface keeps the
 * `@typescript-eslint/no-empty-object-type` rule happy while preserving
 * the same call-site ergonomics (`createContactModule()` with no args).
 */
export type CreateContactModuleOptions = Record<string, never>;

/**
 * Build a fresh `contactModule`. Production wiring calls this once at
 * boot (via `registerContactModule`); tests call it per-fixture so they
 * can later inject stubs without colliding on registry state. The
 * default export `contactModule` uses the no-deps factory call.
 */
export function createContactModule(
  _opts?: CreateContactModuleOptions,
): EntityModule<ContactPayload> {
  return {
    kind: CONTACT_KIND,
    tableName: CONTACT_TABLE,
    payloadSchema: ContactPayloadSchema,
    indexedColumns: [
      {
        name: 'primary_email',
        extract: (payload) => primaryEmailOf(payload),
      },
      {
        name: 'primary_phone',
        extract: (payload) => primaryPhoneOf(payload),
      },
      {
        name: 'company_entity_id',
        extract: (payload) => payload.companyEntityId ?? null,
      },
    ],
    toSummary({ ref, meta, payload, title }) {
      const subtitle =
        primaryEmailOf(payload) ?? primaryPhoneOf(payload) ?? payload.jobTitle ?? null;
      return {
        ...ref,
        meta,
        title,
        subtitle,
        searchableText: searchableTextFor(payload),
      };
    },
    searchableText(payload) {
      return searchableTextFor(payload);
    },
  };
}

export const contactModule: EntityModule<ContactPayload> = createContactModule();

/**
 * Primary-email derivation rule: the first entry with `isPrimary: true`
 * wins; otherwise the first entry overall; otherwise `null`. The
 * generic `EntityStore` writes the result into the `primary_email`
 * column so the sparse index (`idx_contacts_primary_email`) keeps
 * pointing at one address per contact.
 */
function primaryEmailOf(payload: ContactPayload): string | null {
  const emails = payload.emails;
  if (emails === undefined || emails.length === 0) return null;
  const primary = emails.find((e) => e.isPrimary === true);
  return primary?.value ?? emails[0]?.value ?? null;
}

/** Same rule as `primaryEmailOf`, applied to `payload.phones`. */
function primaryPhoneOf(payload: ContactPayload): string | null {
  const phones = payload.phones;
  if (phones === undefined || phones.length === 0) return null;
  const primary = phones.find((p) => p.isPrimary === true);
  return primary?.value ?? phones[0]?.value ?? null;
}

function searchableTextFor(payload: ContactPayload): string {
  const parts: string[] = [];
  if (payload.givenName !== undefined) parts.push(payload.givenName);
  if (payload.familyName !== undefined) parts.push(payload.familyName);
  if (payload.displayName !== undefined) parts.push(payload.displayName);
  if (payload.emails !== undefined) {
    for (const e of payload.emails) parts.push(e.value);
  }
  if (payload.phones !== undefined) {
    for (const p of payload.phones) parts.push(p.value);
  }
  if (payload.jobTitle !== undefined) parts.push(payload.jobTitle);
  if (payload.notes !== undefined) parts.push(payload.notes);
  // Lowercase the digest because the §4.0 store's `searchSummaries`
  // lowercases the query before substring-matching. Keeping both sides
  // lowercase is what makes "alice" find a row with
  // `givenName: 'Alice'`.
  return parts.join(' ').toLowerCase();
}
