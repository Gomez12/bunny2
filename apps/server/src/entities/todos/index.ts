import type { Database } from 'bun:sqlite';
import type { Hono, MiddlewareHandler } from 'hono';
import type { MessageBus } from '@bunny2/bus';
import type { TodoPayload } from '@bunny2/shared';
import type { HonoVariables } from '../../http/types';
import { createRequireLayer } from '../../http/middleware/layer';
import type { LlmClient } from '../../llm';
import { createEntityStore } from '../store';
import { mountEntityRoutes } from '../router';
import { getEntityModule, registerEntityModule } from '../registry';
import type { EntityModule } from '../module';
import { todoModule, createTodoModule } from './module';
import { todoEnrichmentJobs } from './enrichment';
import { validateTodoLinkedEntity } from './validate-link';

export {
  todoModule,
  createTodoModule,
  TODO_KIND,
  TODO_TABLE,
  type CreateTodoModuleOptions,
} from './module';

export { validateTodoLinkedEntity, type ValidateLinkedEntityResult } from './validate-link';

export { todoAutoPriorityJob, todoAutoDueJob, todoEnrichmentJobs } from './enrichment';

export { todoStatsProvider, type TodoStats } from './stats';

/**
 * Phase 4d.1 — wire-up helper for the todos module.
 *
 * Registers `todoModule` in the process-local entity registry (so
 * phase-5 schedulers and phase-6 chat can enumerate kinds) and mounts
 * the generic per-kind HTTP surface at `/l/:slug/todo/*`. The generic
 * store writes `status`, `priority`, `due_at`, `linked_entity_id`, and
 * `linked_entity_kind` to the per-kind `todos` table via
 * `todoModule.indexedColumns` — no todo-specific SQL lives outside
 * the migration.
 *
 * The wiring is exposed as a function (instead of a top-level side
 * effect on import) so tests can drive the store / module directly
 * without booting the HTTP layer and without colliding on the
 * registry.
 *
 * Cross-kind link validation (POST + PATCH body carrying
 * `payload.linkedEntityRef`) is enforced by a small Hono middleware
 * registered BEFORE `mountEntityRoutes`. The middleware reads the
 * request body via `c.req.json()` (Hono caches the parsed object so
 * the downstream POST/PATCH handler reads the same data), inspects
 * `payload.linkedEntityRef`, and rejects unknown / cross-layer links
 * with `errors.entity.todos.linkedEntityNotFound` (400). The
 * validator is per-kind code — no foundation slot — see
 * `validate-link.ts` and the 4d.1 close-out.
 */
export interface MountTodoRoutesDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  readonly llm: LlmClient;
  /**
   * Optional module override for tests that need a per-fixture variant.
   * Mirrors the companies / contacts / calendar wiring. 4d.2
   * (connector placeholder) and 4d.3 (enrichment) will pass a custom
   * module via `createTodoModule({ ... })` through this slot.
   */
  readonly module?: EntityModule<TodoPayload>;
}

/**
 * Idempotent: safe to call multiple times per process. Mirrors
 * `registerCompanyModule` / `registerContactModule` /
 * `registerCalendarEventModule` — short-circuits when ANY todo
 * module is already registered, so tests that pre-register a fixture
 * variant BEFORE `createApp(...)` runs do not collide with the
 * production default that `createApp` registers a moment later.
 * Production has a single caller (`createApp`), so the short-circuit
 * never fires there.
 *
 * Pass `module` to register a per-test variant. Defaults to the
 * production `todoModule`.
 */
export function registerTodoModule(
  module: EntityModule<TodoPayload> = todoModule,
): EntityModule<TodoPayload> {
  const existing = getEntityModule(module.kind);
  if (existing !== null) return existing as EntityModule<TodoPayload>;
  registerEntityModule(module);
  return module;
}

/**
 * Phase 4d.2 — build the todo module for production. Mirrors
 * `buildProductionCalendarEventModule` from the calendar precedent so
 * the wiring site in `apps/server/src/http/router.ts` calls a uniform
 * `build…` helper per kind. In v1 the body is intentionally empty:
 * NO Trello, Linear, Asana, or Google Tasks connector ships. The
 * helper exists so a future "Trello import" connector can be wired
 * here without touching `module.ts`. Tests bypass this helper and
 * call `createTodoModule({ connectors: [stub] })` directly.
 *
 * Returns a module whose `connectors` field is `undefined` (not
 * `[]`) so the registry's `rebuildConnectorIndex` correctly leaves
 * the `todo` bucket absent — matching `listConnectorsForKind('todo')
 * === []` as a contract assertion.
 */
export function buildProductionTodoModule(): EntityModule<TodoPayload> {
  // Phase 4d.3 — wire the two production enrichment jobs
  // (`todos.autoPriority`, `todos.autoDue`). Both are deterministic-
  // first; `autoPriority` falls back to the LLM at low confidence,
  // `autoDue` deliberately omits the LLM fallback (date hallucination
  // has user-visible side effects). No `connectors` are wired — v1
  // ships no real todos connector (see 4d.2 close-out).
  return createTodoModule({ enrichmentJobs: todoEnrichmentJobs });
}

const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;

/**
 * Mount the todo routes. The cross-kind link middleware is registered
 * on the kind base path BEFORE `mountEntityRoutes` so it sees POST
 * and PATCH bodies first. The middleware:
 *
 *   1. Runs `requireLayer` so `c.var.layer.id` is available.
 *   2. Skips non-mutation methods (GET / DELETE / OPTIONS).
 *   3. Reads the JSON body via `c.req.json()` — if parsing fails,
 *      hands off to the inner handler which will emit its standard
 *      `errors.layer.badRequest`. Don't duplicate error surfaces.
 *   4. Runs `validateTodoLinkedEntity(...)`. On failure: respond
 *      400 with the validator's localized code. On success: `next()`.
 *
 * Hono caches `c.req.json()` in its body cache, so the downstream
 * POST/PATCH handler in `mountEntityRoutes` reads the same parsed
 * object — no double-parse, no body re-clone needed.
 */
export function mountTodoRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: MountTodoRoutesDeps,
): void {
  const module = deps.module ?? todoModule;
  const store = createEntityStore<TodoPayload>({
    module,
    db: deps.db,
    bus: deps.bus,
    llm: deps.llm,
  });

  const requireLayer = createRequireLayer();
  const linkValidatorPath = `/l/:slug/${module.kind}`;
  const linkValidatorPathSlug = `/l/:slug/${module.kind}/:entitySlug`;

  // Two scoped middleware registrations:
  //   - `/l/:slug/todo`            covers POST (create).
  //   - `/l/:slug/todo/:entitySlug` covers PATCH (update). Hono's
  //     `:param` matches a single segment, so technically `_stats`
  //     and `_ingest/...` parts would ALSO match `:entitySlug` if
  //     they were one segment. In practice the method gate (POST or
  //     PATCH only) and the absence of `payload.linkedEntityRef`
  //     in those request bodies means `next()` always fires on
  //     `_stats` (which is GET-only) and `_ingest` (not present on
  //     todos in 4d.1). Do NOT remove the method gate without
  //     accounting for this — the validator is intentionally
  //     write-only.
  // The validator early-exits on non-POST/PATCH methods so GET /
  // DELETE on either path are no-ops.
  const linkValidator: MiddlewareHandler<{ Variables: HonoVariables }> = async (c, next) => {
    const method = c.req.method;
    if (method !== 'POST' && method !== 'PATCH') {
      await next();
      return;
    }
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);

    let body: { payload?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      // Body unparseable or absent. Defer to the inner handler so the
      // standard `errors.layer.badRequest` surfaces, instead of
      // making the validator double as a JSON-parser error gate.
      await next();
      return;
    }
    const payload = body.payload;
    if (payload === null || payload === undefined || typeof payload !== 'object') {
      await next();
      return;
    }
    const linkedEntityRef = (payload as { linkedEntityRef?: unknown }).linkedEntityRef;
    if (linkedEntityRef === undefined || linkedEntityRef === null) {
      await next();
      return;
    }
    // Coerce into the shape the validator expects. The full zod
    // re-parse runs inside `mountEntityRoutes` — here we only check
    // existence + same-layer, so a structurally-wrong `linkedEntityRef`
    // (e.g. missing `kind`) is left to the inner handler's standard
    // `errors.entity.validation`.
    if (typeof linkedEntityRef !== 'object') {
      await next();
      return;
    }
    const ref = linkedEntityRef as { kind?: unknown; entityId?: unknown };
    if (typeof ref.kind !== 'string' || typeof ref.entityId !== 'string') {
      await next();
      return;
    }
    if (ref.kind !== 'company' && ref.kind !== 'contact') {
      await next();
      return;
    }
    const result = validateTodoLinkedEntity({
      payload: {
        linkedEntityRef: { kind: ref.kind, entityId: ref.entityId },
      },
      layerId: layer.id,
      db: deps.db,
    });
    if (!result.ok) {
      return c.json({ error: result.code }, 400);
    }
    await next();
    return;
  };

  app.use(linkValidatorPath, requireLayer, linkValidator);
  app.use(linkValidatorPathSlug, requireLayer, linkValidator);

  mountEntityRoutes(app, {
    module,
    store,
    bus: deps.bus,
    db: deps.db,
  });
}
