import { z } from 'zod';

/**
 * Cross-package zod schemas for the company entity (phase 4a.1).
 *
 * Server-internal repo types live in the per-kind table
 * (`apps/server/src/storage/migrations/0006_companies.sql` +
 * `apps/server/src/entities/companies/module.ts`); these schemas
 * describe the safe shape that crosses the HTTP boundary and is shared
 * with the web client. Mirrors the `packages/shared/src/layer.ts`
 * pattern: zod for HTTP-boundary contracts, narrow types reused on both
 * sides.
 *
 * The only field the router enforces as required on the entity row is
 * `title` (handled in `apps/server/src/entities/router.ts` per the §4.0
 * contract). Every payload field is optional — a company can be
 * stub-created (title only) and enriched later by the 4a.2 KvK
 * connector or the 4a.3 AI-enrichment job.
 */

// ---------- payload schema ---------------------------------------------

/** A company's postal / visiting address. All fields optional. */
export const CompanyAddressSchema = z
  .object({
    street: z.string().max(160).optional(),
    houseNumber: z.string().max(32).optional(),
    postalCode: z.string().max(32).optional(),
    city: z.string().max(80).optional(),
    country: z.string().max(80).optional(),
  })
  .strict();
export type CompanyAddress = z.infer<typeof CompanyAddressSchema>;

/**
 * Company payload. Every field is optional — see file-level doc above.
 *
 * `kvkNumber` follows the Dutch Chamber of Commerce format: exactly 8
 * digits. The router rejects anything else with
 * `errors.entity.companies.kvkInvalid` (mapped from
 * `errors.entity.validation` at the generic router; the per-kind UI
 * surfaces the specific message — see `entity.companies.*` i18n keys).
 *
 * `description` is capped at 4000 chars to keep the row size bounded —
 * the per-record `originalLocale` decision (§10.7 in `overall.md`)
 * means the translator re-emits this string per locale, so an unbounded
 * description multiplies translation cost.
 */
export const CompanyPayloadSchema = z
  .object({
    legalName: z.string().min(1).max(200).optional(),
    tradeName: z.string().min(1).max(200).optional(),
    kvkNumber: z
      .string()
      .regex(/^\d{8}$/, 'kvkNumber must be 8 digits')
      .optional(),
    website: z.string().url().max(2048).optional(),
    address: CompanyAddressSchema.optional(),
    phone: z.string().max(64).optional(),
    email: z.string().email().max(256).optional(),
    industry: z.string().max(120).optional(),
    description: z.string().max(4000).optional(),
  })
  .strict();
export type CompanyPayload = z.infer<typeof CompanyPayloadSchema>;

// ---------- HTTP request shapes ----------------------------------------

/**
 * `POST /l/:slug/companies`. Mirrors the §4.0 generic-router body
 * shape: `title` and `originalLocale` are top-level (the router writes
 * them onto the row), `payload` carries the kind-specific data.
 *
 * The slug constraint matches `CreateLayerRequestSchema` for the same
 * reasons (URL-safe, lowercase, no inadvertent collision with reserved
 * URL paths). The slug is optional — when omitted, the generic store
 * uses the entity's UUID.
 */
export const CreateCompanyRequestSchema = z.object({
  title: z.string().min(1).max(200),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and dashes')
    .optional(),
  originalLocale: z.string().min(1).max(16),
  payload: CompanyPayloadSchema,
});
export type CreateCompanyRequest = z.infer<typeof CreateCompanyRequestSchema>;

/**
 * `PATCH /l/:slug/companies/:companySlug`. Title is optional (the
 * router preserves the existing title when omitted); `payload` is
 * required because the §4.0 router validates the full payload shape on
 * every PATCH (the per-kind store has no partial-update path in v1 —
 * see `apps/server/src/entities/router.ts` PATCH handler).
 */
export const UpdateCompanyRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  payload: CompanyPayloadSchema,
});
export type UpdateCompanyRequest = z.infer<typeof UpdateCompanyRequestSchema>;
