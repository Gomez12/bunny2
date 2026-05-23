import { z } from 'zod';

/**
 * Cross-package zod schemas for the contact entity (phase 4b.1).
 *
 * Second concrete kind on top of the §4.0 entity-contract foundation.
 * Mirrors `packages/shared/src/companies.ts`: zod schemas live here for
 * the HTTP boundary + the web client; server-internal repo types live
 * in the per-kind table (`0008_contacts.sql`) + module
 * (`apps/server/src/entities/contacts/module.ts`).
 *
 * Every payload field is optional — a contact can be stub-created
 * (title only) and enriched later by the 4b.2 vCard import or by the
 * 4b.3 AI suggestion. The entity row's `title` (set by the router) is
 * the only hard requirement.
 */

// ---------- payload sub-schemas ----------------------------------------

/**
 * One email entry inside `payload.emails[]`. `isPrimary` is the
 * tiebreaker the module's `primary_email` indexed column reads first;
 * when no entry is flagged, the first entry wins.
 */
export const ContactEmailSchema = z
  .object({
    value: z.string().email().max(256),
    label: z.string().max(64).optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();
export type ContactEmail = z.infer<typeof ContactEmailSchema>;

/**
 * One phone entry inside `payload.phones[]`. We intentionally do NOT
 * validate phone format — international numbers vary too much and a
 * vCard import will surface anything. `min(1).max(64)` keeps the row
 * size bounded without locking the format.
 */
export const ContactPhoneSchema = z
  .object({
    value: z.string().min(1).max(64),
    label: z.string().max(64).optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();
export type ContactPhone = z.infer<typeof ContactPhoneSchema>;

// ---------- payload schema ---------------------------------------------

/**
 * Contact payload. Every field is optional — see file-level doc above.
 *
 * `companyEntityId` is a soft reference to a `companies.id` in the same
 * layer. The 4b.3 route handler validates the link at write time
 * (existence + same-layer); 4b.1 keeps the link permissive at the SQL +
 * payload layer so the connector and enrichment paths can stage
 * suggestions without a round-trip.
 *
 * `emails` capped at 16: a person with more than 16 emails is exotic;
 * the cap keeps the row size bounded so the translator (re-emits the
 * payload per locale) doesn't blow up. `phones` capped the same way for
 * symmetry. Emails are de-duplicated by `value` — two entries with the
 * same address but different labels are not useful for the indexed
 * `primary_email` projection.
 *
 * `birthday` is an ISO date string (`YYYY-MM-DD`). We avoid a `Date`
 * type because the boundary is JSON; the per-locale display formatting
 * lives in the web client.
 */
export const ContactPayloadSchema = z
  .object({
    givenName: z.string().min(1).max(160).optional(),
    familyName: z.string().min(1).max(160).optional(),
    displayName: z.string().min(1).max(320).optional(),
    emails: z
      .array(ContactEmailSchema)
      .max(16)
      .superRefine((emails, ctx) => {
        const seen = new Set<string>();
        for (let i = 0; i < emails.length; i += 1) {
          const v = emails[i]?.value;
          if (v === undefined) continue;
          const key = v.toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i, 'value'],
              message: 'duplicate email value',
            });
          }
          seen.add(key);
        }
      })
      .optional(),
    phones: z.array(ContactPhoneSchema).max(16).optional(),
    companyEntityId: z.string().uuid().optional(),
    jobTitle: z.string().min(1).max(160).optional(),
    notes: z.string().max(4000).optional(),
    birthday: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'birthday must be ISO date YYYY-MM-DD')
      .optional(),
  })
  .strict();
export type ContactPayload = z.infer<typeof ContactPayloadSchema>;

// ---------- HTTP request shapes ----------------------------------------

/**
 * `POST /l/:slug/contact`. Mirrors the §4.0 generic-router body shape
 * (and the 4a.1 companies create request): `title` + `originalLocale`
 * are top-level (the router writes them onto the row), `payload`
 * carries the kind-specific data. The slug constraint matches the
 * `CreateCompanyRequestSchema` rule for the same reasons (URL-safe,
 * lowercase, no inadvertent collision with reserved URL paths).
 */
export const CreateContactRequestSchema = z.object({
  title: z.string().min(1).max(320),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and dashes')
    .optional(),
  originalLocale: z.string().min(1).max(16),
  payload: ContactPayloadSchema,
});
export type CreateContactRequest = z.infer<typeof CreateContactRequestSchema>;

/**
 * `PATCH /l/:slug/contact/:contactSlug`. Title is optional (the router
 * preserves the existing title when omitted); `payload` is required
 * because the §4.0 router validates the full payload shape on every
 * PATCH.
 */
export const UpdateContactRequestSchema = z.object({
  title: z.string().min(1).max(320).optional(),
  payload: ContactPayloadSchema,
});
export type UpdateContactRequest = z.infer<typeof UpdateContactRequestSchema>;
