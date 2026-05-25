import { z } from 'zod';

/**
 * Cross-package zod schemas + TypeScript types for the universal entity
 * contract (phase 4.0).
 *
 * Server-internal `EntityModule` / `EntityStore` / `EntityConnector`
 * interfaces live in `apps/server/src/entities/` — they pull in
 * `bun:sqlite` / `MessageBus` / `LlmClient` and must not leak into the
 * web client.
 *
 * These schemas describe the safe shape that crosses the HTTP boundary
 * and is shared with the renderer. Timestamps are ISO-8601 strings —
 * same convention as `packages/shared/src/auth.ts` /
 * `packages/shared/src/layer.ts`.
 *
 * Phase 4.0 is the foundation: no concrete entity kind ships here.
 * Per-kind payload schemas (`companies`, `contacts`, `calendar_events`,
 * `todos`) land in 4a..4d and parameterize the `Payload` type via the
 * `Entity<P>` / `EntitySummary` generics.
 */

/** Connector-managed sync state for an external link row. */
export const EntitySyncStateSchema = z.enum(['idle', 'syncing', 'error']);
export type EntitySyncState = z.infer<typeof EntitySyncStateSchema>;

/**
 * Loose ISO-8601 date / date-time string. Accepts:
 *  - `YYYY-MM-DD` (date-only — same shape calendar all-day events use)
 *  - `YYYY-MM-DDTHH:MM(:SS(.sss)?)?(Z|[+-]HH:MM)?`
 *
 * Used by the §4.0 entity list endpoint's `?from=&to=` range filter
 * (see `EntityModule.timeColumn`). Kept minimal and string-typed so
 * the server can pass the value straight to a `WHERE col >= ?`
 * lexicographic compare against the indexed ISO-8601 column.
 *
 * The regex rejects "obviously wrong" input (empty, non-ISO words)
 * but does NOT enforce calendar validity (e.g. `2026-02-30` slips
 * through). That's fine — the lexicographic compare is sound either
 * way; the validator's job is to refuse SQL-noise like `'; drop --`.
 */
export const ISO_8601_DATE_RE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$/;

export const Iso8601DateSchema = z
  .string()
  .min(1)
  .regex(ISO_8601_DATE_RE, 'iso8601-date');

/**
 * Minimal pointer to an entity. Used by cross-entity references (e.g.
 * a todo pointing at a contact) and by event payloads.
 */
export const EntityRefSchema = z.object({
  id: z.string().uuid(),
  kind: z.string().min(1),
  layerId: z.string().uuid(),
  slug: z.string().min(1),
});
export type EntityRef = z.infer<typeof EntityRefSchema>;

/** Audit + bookkeeping metadata every entity carries, regardless of kind. */
export const EntityMetaSchema = z.object({
  createdAt: z.string(),
  createdBy: z.string().uuid(),
  updatedAt: z.string(),
  updatedBy: z.string().uuid(),
  deletedAt: z.string().nullable(),
  deletedBy: z.string().uuid().nullable(),
  version: z.number().int().positive(),
  originalLocale: z.string().min(1),
});
export type EntityMeta = z.infer<typeof EntityMetaSchema>;

/** Per-record summary used by listings, search results, and chat retrieval. */
export const EntitySummarySchema = EntityRefSchema.extend({
  meta: EntityMetaSchema,
  title: z.string(),
  subtitle: z.string().nullable(),
  searchableText: z.string(),
  /**
   * Per-kind extras projected by `EntityModule.summaryColumns`. The
   * generic store evaluates each declared column against the row's
   * payload + audit metadata and stuffs the result keyed by `id`.
   * Modules without `summaryColumns` omit the field entirely; the
   * web client treats absence as an empty object. JSON-serialisable
   * values only.
   */
  extras: z.record(z.unknown()).optional(),
});
export type EntitySummary = z.infer<typeof EntitySummarySchema>;

/** Connector-managed link to an external system (one row in `entity_external_links`). */
export const EntityExternalLinkSchema = z.object({
  id: z.string().uuid(),
  connector: z.string().min(1),
  externalId: z.string().min(1),
  syncState: EntitySyncStateSchema,
  syncedAt: z.string().nullable(),
  error: z.string().nullable(),
  payload: z.record(z.unknown()),
});
export type EntityExternalLink = z.infer<typeof EntityExternalLinkSchema>;

/**
 * Full entity envelope. `Payload` is the kind-specific shape, defined by
 * each per-kind `EntityModule` (`companies`, `contacts`, ...). The web
 * client narrows it via the kind-specific schema published from the same
 * shared package.
 *
 * `translations` is keyed by locale code and only present when the caller
 * asks for non-original-locale content; the original-locale payload is
 * always returned in `payload`.
 */
export interface Entity<Payload = unknown> extends EntitySummary {
  readonly payload: Payload;
  readonly externalLinks: readonly EntityExternalLink[];
  readonly translations?: Readonly<Record<string, Payload>>;
}

/**
 * Generic envelope schema factory. Per-kind code calls
 * `entitySchema(MyPayloadSchema)` to get a fully-typed zod schema for
 * `Entity<MyPayload>`. The renderer uses the result for runtime payload
 * validation when it deserializes an HTTP response.
 */
export function entitySchema<TPayload extends z.ZodTypeAny>(
  payloadSchema: TPayload,
): z.ZodType<Entity<z.infer<TPayload>>> {
  return EntitySummarySchema.extend({
    payload: payloadSchema,
    externalLinks: z.array(EntityExternalLinkSchema),
    translations: z.record(payloadSchema).optional(),
  }) as unknown as z.ZodType<Entity<z.infer<TPayload>>>;
}
