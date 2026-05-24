import type { Database } from 'bun:sqlite';
import type { TodoLinkedEntityKind, TodoPayload } from '@bunny2/shared';

/**
 * Phase 4d.1 — cross-kind link validation.
 *
 * A todo's `payload.linkedEntityRef` points to either a contact or a
 * company in the SAME layer. The §4.0 generic router does not know
 * about cross-kind links, so this validator lives in the per-kind
 * module and is invoked by `mountTodoRoutes` via a small Hono
 * middleware that intercepts POST + PATCH on `/l/:slug/todo/*` BEFORE
 * `mountEntityRoutes` handles the request body. The middleware reads
 * `payload.linkedEntityRef` from the request body via `c.req.json()`
 * (which Hono caches, so the downstream handler reads the same parsed
 * object), validates the target, and either rejects with the
 * appropriate i18n key or calls `next()`.
 *
 * Approach (the brief's "Option 2"): inline per-kind validation. No
 * `EntityModule.validatePayload?` foundation slot — the cross-kind
 * concern stays out of the §4.0 contract. If a second consumer needs
 * the same shape (calendar attendee → contact validation has been
 * deferred to a follow-up), that's the trigger to extract a slot —
 * not now. See the 4d.1 close-out in
 * `docs/dev/plans/done/phase-04-first-entities.md` §14.
 *
 * Validation rules:
 *   - `linkedEntityRef === undefined` → OK (no link, no check).
 *   - `linkedEntityRef.kind === 'contact'` →
 *       the target id MUST exist in `contacts` AND
 *       `layer_id === currentLayerId` AND `deleted_at IS NULL`.
 *   - `linkedEntityRef.kind === 'company'` → same against `companies`.
 *   - Any failure → return `{ ok: false, code }` with one of:
 *       - `errors.entity.todos.linkedEntityNotFound`
 *       - `errors.entity.todos.linkedEntityWrongLayer`
 *
 * The split between "not found" and "wrong layer" avoids leaking
 * cross-layer existence: if the target id doesn't exist at all in the
 * referenced table OR exists but lives in a DIFFERENT layer, we
 * surface the same `linkedEntityNotFound` code. The
 * `linkedEntityWrongLayer` code is reserved for a future bulk-move
 * surface that may want to distinguish — keeping it in the i18n
 * catalogue forward-stable.
 */

export type ValidateLinkedEntityResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: string };

export interface ValidateLinkedEntityInput {
  readonly payload: Pick<TodoPayload, 'linkedEntityRef'>;
  readonly layerId: string;
  readonly db: Database;
}

const TABLE_BY_KIND: Record<TodoLinkedEntityKind, string> = {
  contact: 'contacts',
  company: 'companies',
};

/**
 * Run the cross-kind link check synchronously against the shared
 * Database handle. Caller is the route-level middleware mounted by
 * `mountTodoRoutes`.
 */
export function validateTodoLinkedEntity(
  input: ValidateLinkedEntityInput,
): ValidateLinkedEntityResult {
  const ref = input.payload.linkedEntityRef;
  if (ref === undefined) return { ok: true };

  const table = TABLE_BY_KIND[ref.kind];
  // The shape is enforced by the zod schema (`kind: z.enum([...])`),
  // so an undefined table here would indicate a programmer error —
  // surface the not-found code rather than crashing the request.
  if (table === undefined) {
    return { ok: false, code: 'errors.entity.todos.linkedEntityNotFound' };
  }

  // Per-kind table reads stay pure SQL — the validator never touches
  // the per-kind store factory, so it cannot accidentally re-emit a
  // bus event or trigger a lifecycle hook.
  const row = input.db
    .query<
      { layer_id: string; deleted_at: string | null },
      [string]
    >(`SELECT layer_id, deleted_at FROM ${table} WHERE id = ?`)
    .get(ref.entityId);

  if (row === null || row.deleted_at !== null) {
    return { ok: false, code: 'errors.entity.todos.linkedEntityNotFound' };
  }
  if (row.layer_id !== input.layerId) {
    return { ok: false, code: 'errors.entity.todos.linkedEntityNotFound' };
  }
  return { ok: true };
}
