import { z } from 'zod';

/**
 * Cross-package zod schemas for the todo entity (phase 4d.1).
 *
 * Fourth concrete kind on top of the §4.0 entity-contract foundation.
 * Mirrors `packages/shared/src/companies.ts`,
 * `packages/shared/src/contacts.ts`, and
 * `packages/shared/src/calendar.ts`: zod schemas live here for the
 * HTTP boundary + the web client; server-internal repo types live in
 * the per-kind table (`0010_todos.sql`) + module
 * (`apps/server/src/entities/todos/module.ts`).
 *
 * v1 stance (per `docs/dev/plans/done/phase-04-first-entities.md` §2): a
 * todo is a single, simple item. NO recurrence, NO checklist children,
 * NO sub-tasks. The 4d.6 calendar projection turns a todo with a
 * `dueAt` into a read-only calendar entry — there is no shared FK
 * between todos and calendar events, only a subscriber-driven
 * projection.
 *
 * The router enforces `title` (handled by the §4.0 generic router).
 * Every payload field is optional; a stub todo (title only) is a
 * valid create. The defaults exist on `status` ('open') and `priority`
 * (3 = normal) so the indexed-column projection always has a value
 * to write — the SQL columns are `NOT NULL DEFAULT 'open' / 3`.
 */

// ---------- payload sub-schemas ----------------------------------------

const ISO_DATE_OR_DATETIME_PATTERN =
  // `YYYY-MM-DD` OR a full ISO-8601 timestamp with Z / offset. Stays
  // sortable lexicographically — the SQL layer uses `due_at` as a
  // sort key for "due today / due this week" queries (4d.4) without
  // needing a Date parse on every row.
  /^(\d{4}-\d{2}-\d{2})(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2}))?$/;

/**
 * Status enum. Five values cover the standard kanban columns the
 * 4d.5 web UI surfaces plus `cancelled`. `'done'` is logically
 * distinct from soft-delete (`meta.deletedAt`): a done todo stays
 * visible in the kanban "Done" column; a soft-deleted todo is
 * hidden from `listSummaries` and only reachable by slug for
 * future restore.
 */
export const TodoStatusSchema = z.enum(['open', 'in_progress', 'blocked', 'done', 'cancelled']);
export type TodoStatus = z.infer<typeof TodoStatusSchema>;

/**
 * Priority enum encoded as an integer. 1 = highest, 5 = lowest, 3 =
 * normal default. Integer (not enum) so the future 4d.4 widget can
 * `ORDER BY priority ASC` on the indexed column without a CASE
 * mapping.
 */
export const TodoPrioritySchema = z.number().int().min(1).max(5);
export type TodoPriority = z.infer<typeof TodoPrioritySchema>;

/**
 * Kind of the entity a todo links to. The v1 set is `'company'` and
 * `'contact'` — a todo lives in a layer alongside companies and
 * contacts (e.g. "Call AMI BV", "Send proposal to Alice"). A todo
 * does NOT link to a calendar event: a todo with a `dueAt` appears on
 * the calendar via the 4d.6 projection subscriber, but the projection
 * is read-only and the canonical link target is always a person /
 * business.
 */
export const TodoLinkedEntityKindSchema = z.enum(['company', 'contact']);
export type TodoLinkedEntityKind = z.infer<typeof TodoLinkedEntityKindSchema>;

/**
 * `payload.linkedEntityRef` — explicit two-key shape so a client can
 * resolve the target without a separate lookup. The route handler
 * validates the target exists and lives in the same layer at write
 * time (see `apps/server/src/entities/todos/validate-link.ts`).
 *
 * The SQL layer projects the pair into the sparse-indexed
 * `linked_entity_id` + `linked_entity_kind` columns via the module's
 * `indexedColumns`. The CHECK constraint on the migration enforces
 * "both set or both null" at the SQL layer — a defensive backstop
 * for the zod invariant.
 */
export const TodoLinkedEntityRefSchema = z
  .object({
    kind: TodoLinkedEntityKindSchema,
    entityId: z.string().uuid(),
  })
  .strict();
export type TodoLinkedEntityRef = z.infer<typeof TodoLinkedEntityRefSchema>;

// ---------- payload schema ---------------------------------------------

/**
 * Todo payload.
 *
 * `status` and `priority` carry defaults so a create with only a
 * title (`POST { title: 'Buy milk', payload: {} }`) lands as
 * `{ status: 'open', priority: 3 }` and the indexed-column
 * projection writes the defaults verbatim. Every other field is
 * optional.
 *
 * `dueAt` accepts either a date-only string (`YYYY-MM-DD`) or a
 * full ISO-8601 timestamp. The 4d.6 calendar projection treats
 * date-only `dueAt` as an all-day calendar entry and timestamped
 * `dueAt` as a point-in-time entry.
 *
 * `linkedEntityRef` is the polymorphic cross-kind link. The kind
 * sits inside the object so a client never has to guess. Route-level
 * validation (per-kind code, NOT the foundation) confirms the
 * referenced entity exists and lives in the same layer; the SQL
 * layer keeps the link soft so a layered re-export survives a
 * contact / company soft-delete.
 *
 * `completedAt` is a forward-stable slot the schema accepts so a
 * future client can write it on `status='done'`. In 4d.1 the server
 * does NOT automatically normalize this field — `onUpdate` lifecycle
 * hooks fire AFTER the row write and cannot mutate the persisted
 * payload, so deferring automatic `completedAt` normalization to the
 * 4d.5 web UI (which writes it explicitly when the user marks a todo
 * done) is the simpler choice that needs zero foundation tweaks. See
 * the 4d.1 close-out in
 * `docs/dev/plans/done/phase-04-first-entities.md` §14.
 *
 * `tags` is a small bounded list (max 16) of lowercase short
 * strings — useful for `#urgent` style filters in 4d.5. Duplicate
 * entries (case-insensitive) are rejected by the superRefine; the
 * client de-dupes by lowercasing.
 */
export const TodoPayloadSchema = z
  .object({
    description: z.string().max(4000).optional(),
    status: TodoStatusSchema.default('open'),
    priority: TodoPrioritySchema.default(3),
    dueAt: z
      .string()
      .min(1)
      .max(40)
      .regex(ISO_DATE_OR_DATETIME_PATTERN, 'dueAt must be YYYY-MM-DD or an ISO-8601 timestamp')
      .optional(),
    linkedEntityRef: TodoLinkedEntityRefSchema.optional(),
    completedAt: z
      .string()
      .min(1)
      .max(40)
      .regex(
        ISO_DATE_OR_DATETIME_PATTERN,
        'completedAt must be YYYY-MM-DD or an ISO-8601 timestamp',
      )
      .optional(),
    tags: z
      .array(z.string().min(1).max(64))
      .max(16)
      .superRefine((tags, ctx) => {
        const seen = new Set<string>();
        for (let i = 0; i < tags.length; i += 1) {
          const t = tags[i];
          if (t === undefined) continue;
          const key = t.toLowerCase();
          if (seen.has(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [i],
              message: 'duplicate tag',
            });
          }
          seen.add(key);
        }
      })
      .optional(),
  })
  .strict();
export type TodoPayload = z.infer<typeof TodoPayloadSchema>;

// ---------- HTTP request shapes ----------------------------------------

/**
 * `POST /l/:slug/todo`. Mirrors the §4.0 generic-router body shape and
 * the 4a.1 / 4b.1 / 4c.1 precedents: `title` + `originalLocale` are
 * top-level (the router writes them onto the row), `payload` carries
 * the kind-specific data. The slug constraint matches the existing
 * entity slug rule (URL-safe, lowercase, no inadvertent collision
 * with reserved URL paths).
 */
export const CreateTodoRequestSchema = z.object({
  title: z.string().min(1).max(320),
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and dashes')
    .optional(),
  originalLocale: z.string().min(1).max(16),
  payload: TodoPayloadSchema,
});
export type CreateTodoRequest = z.infer<typeof CreateTodoRequestSchema>;

/**
 * `PATCH /l/:slug/todo/:todoSlug`. Title is optional (the router
 * preserves the existing title when omitted); `payload` is required
 * because the §4.0 router validates the full payload shape on every
 * PATCH (and merges top-level keys against the stored payload — see
 * the post-4c router fix in
 * `docs/dev/plans/done/phase-04-first-entities.md` §14).
 */
export const UpdateTodoRequestSchema = z.object({
  title: z.string().min(1).max(320).optional(),
  payload: TodoPayloadSchema,
});
export type UpdateTodoRequest = z.infer<typeof UpdateTodoRequestSchema>;
