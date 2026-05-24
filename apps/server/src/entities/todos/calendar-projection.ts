import type { Database } from 'bun:sqlite';
import type { BusEvent, MessageBus, Unsubscribe } from '@bunny2/bus';
import {
  entityEventType,
  type EntityCreatedPayload,
  type EntityDeletedPayload,
  type EntityRestoredPayload,
  type EntityUpdatedPayload,
} from '../events';
import { TODO_KIND } from './module';

/**
 * Phase 4d.6 — todo → calendar projection bridge.
 *
 * Subscribes to `entity.todo.{created,updated,deleted,restored}` and
 * maintains the `calendar_projection_todos` materialized table. The
 * calendar UI fetches this projection via `GET
 * /l/:slug/calendar/_projections/todos` (mounted from
 * `calendar-projection-routes.ts`) alongside the real calendar events,
 * and renders projection rows as read-only events.
 *
 * # Design choices (see §4.3 Q3 of the phase-4 plan + ADR 0017)
 *
 *   - **Option B — stored projection.** The brief explicitly says
 *     "emit a read-only `calendar.projection.todo` row", strongly
 *     implying a stored row. Stored projection survives reloads,
 *     integrates with phase-6 chat retrieval (the calendar layer can
 *     ask "what's on Friday" and get both events and todo
 *     projections), and the SQL stays simple. The "no duplicate
 *     storage" rule is honored because the projection is a derived
 *     index — `todos` is the source of truth and deleting a todo
 *     wipes the projection row immediately.
 *
 *   - **Re-read on every event.** `EntityUpdatedPayload` carries only
 *     `{ref, version, previousVersion, searchableText}` — not the
 *     payload. Rather than diff "previous had dueAt, new doesn't"
 *     from the event itself, the subscriber re-reads the current todo
 *     row via direct SQL on `todos` and decides: present + non-null
 *     `dueAt` + non-deleted → upsert; otherwise → delete. This
 *     collapses every transition (created with dueAt, dueAt added,
 *     dueAt cleared, soft-delete, restore) into a single
 *     read-modify-write path. Idempotent.
 *
 *   - **No feedback loop.** The subscriber NEVER publishes
 *     `entity.todo.*` events back to the bus and NEVER calls
 *     `store.update`. It only writes to `calendar_projection_todos`.
 *     Tests assert this invariant.
 *
 *   - **Failure discipline.** A failed projection write does NOT
 *     propagate. Logs at warn level; the next event for the same
 *     todo retries. Mirrors the dispatcher / enrichment-runner
 *     discipline.
 *
 *   - **`rebuild()`.** Boot-time recovery for missed events. Clears
 *     the projection table and re-projects every non-deleted todo
 *     with a non-null `due_at`. Idempotent. Production boot calls
 *     this once after `start()`; order does not matter — upserts are
 *     idempotent.
 */

export interface TodoCalendarProjectionBridge {
  start(): void;
  stop(): void;
  /**
   * Synchronous full rebuild. Clears the projection table and
   * re-projects every non-deleted todo whose `due_at` is non-null.
   * Safe to call any time; used at boot and in tests.
   */
  rebuild(): void;
  /**
   * Test helper — synchronously evaluate the projection for one todo
   * exactly as a bus event would. Returns true if a row was
   * upserted, false if deleted (or no-op when neither side has data).
   */
  handle(todoId: string): boolean;
}

export interface TodoCalendarProjectionDeps {
  readonly db: Database;
  readonly bus: MessageBus;
  /** Test-only clock override. Default: `new Date()`. */
  readonly clock?: () => Date;
  /**
   * Test-only warn hook. Production omits this; the default writes to
   * `console.warn`. Tests can capture the calls to assert the
   * failure-isolation invariant.
   */
  readonly onWarn?: (message: string, err: unknown) => void;
}

interface TodoRow {
  readonly id: string;
  readonly layer_id: string;
  readonly slug: string;
  readonly title: string;
  readonly due_at: string | null;
  readonly status: string;
  readonly priority: number;
  readonly deleted_at: string | null;
}

export function createTodoCalendarProjection(
  deps: TodoCalendarProjectionDeps,
): TodoCalendarProjectionBridge {
  const clock = deps.clock ?? (() => new Date());
  const warn =
    deps.onWarn ??
    ((message: string, err: unknown): void => {
      // Discipline mirrors the dispatcher / enrichment runner:
      // failures log + drop.
      console.warn(`[todo-calendar-projection] ${message}`, err);
    });
  const unsubscribes: Unsubscribe[] = [];
  let started = false;

  function loadTodo(todoId: string): TodoRow | null {
    const row = deps.db
      .query<TodoRow, [string]>(
        `SELECT id, layer_id, slug, title, due_at, status, priority, deleted_at
           FROM todos WHERE id = ?`,
      )
      .get(todoId);
    return row;
  }

  /** Upsert OR delete based on the current state of the todo row. */
  function projectTodo(todoId: string): boolean {
    try {
      const row = loadTodo(todoId);
      if (row === null) {
        // Todo row vanished (rare — soft-delete keeps the row; hard
        // delete is not exposed). Clean up any stale projection just
        // in case.
        deleteProjection(todoId);
        return false;
      }
      // No projection when the row is soft-deleted OR `due_at` is null.
      // This is the single decision point — every transition (create
      // with dueAt, add dueAt, clear dueAt, soft-delete, restore)
      // ends up in either the upsert branch or the delete branch.
      if (row.deleted_at !== null || row.due_at === null || row.due_at === '') {
        deleteProjection(todoId);
        return false;
      }
      upsertProjection(row);
      return true;
    } catch (err) {
      warn(`failed to project todo ${todoId}`, err);
      return false;
    }
  }

  function upsertProjection(row: TodoRow): void {
    const nowIso = clock().toISOString();
    deps.db
      .query<unknown, [string, string, string, string, string, number, string, string]>(
        `INSERT INTO calendar_projection_todos (
           todo_id, layer_id, todo_slug, title, due_at, priority, status, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(todo_id) DO UPDATE SET
           layer_id = excluded.layer_id,
           todo_slug = excluded.todo_slug,
           title = excluded.title,
           due_at = excluded.due_at,
           priority = excluded.priority,
           status = excluded.status,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.id,
        row.layer_id,
        row.slug,
        row.title,
        row.due_at as string,
        row.priority,
        row.status,
        nowIso,
      );
  }

  function deleteProjection(todoId: string): void {
    deps.db
      .query<unknown, [string]>(`DELETE FROM calendar_projection_todos WHERE todo_id = ?`)
      .run(todoId);
  }

  function onCreated(event: BusEvent<EntityCreatedPayload>): void {
    projectTodo(event.payload.ref.id);
  }

  function onUpdated(event: BusEvent<EntityUpdatedPayload>): void {
    projectTodo(event.payload.ref.id);
  }

  function onDeleted(event: BusEvent<EntityDeletedPayload>): void {
    // The store has marked the row soft-deleted; `projectTodo` reads
    // the row and DELETEs the projection because `deleted_at !== null`.
    projectTodo(event.payload.ref.id);
  }

  function onRestored(event: BusEvent<EntityRestoredPayload>): void {
    projectTodo(event.payload.ref.id);
  }

  function start(): void {
    if (started) return;
    started = true;
    unsubscribes.push(
      deps.bus.subscribe<EntityCreatedPayload>(entityEventType(TODO_KIND, 'created'), async (e) =>
        onCreated(e),
      ),
    );
    unsubscribes.push(
      deps.bus.subscribe<EntityUpdatedPayload>(entityEventType(TODO_KIND, 'updated'), async (e) =>
        onUpdated(e),
      ),
    );
    unsubscribes.push(
      deps.bus.subscribe<EntityDeletedPayload>(entityEventType(TODO_KIND, 'deleted'), async (e) =>
        onDeleted(e),
      ),
    );
    unsubscribes.push(
      deps.bus.subscribe<EntityRestoredPayload>(entityEventType(TODO_KIND, 'restored'), async (e) =>
        onRestored(e),
      ),
    );
  }

  function stop(): void {
    for (const u of unsubscribes) u();
    unsubscribes.length = 0;
    started = false;
  }

  function rebuild(): void {
    try {
      const tx = deps.db.transaction(() => {
        deps.db.exec(`DELETE FROM calendar_projection_todos`);
        const rows = deps.db
          .query<TodoRow, []>(
            `SELECT id, layer_id, slug, title, due_at, status, priority, deleted_at
               FROM todos
              WHERE deleted_at IS NULL
                AND due_at IS NOT NULL
                AND due_at <> ''`,
          )
          .all();
        for (const row of rows) {
          upsertProjection(row);
        }
      });
      tx();
    } catch (err) {
      warn(`rebuild failed`, err);
    }
  }

  function handle(todoId: string): boolean {
    return projectTodo(todoId);
  }

  return { start, stop, rebuild, handle };
}

/**
 * Phase 4d.6 — projection row shape as returned by the list endpoint
 * `GET /l/:slug/calendar/_projections/todos`. Mirrors the columns of
 * `calendar_projection_todos`; serialised camelCase as is convention
 * elsewhere in the HTTP API.
 */
export interface TodoCalendarProjectionRow {
  readonly todoId: string;
  readonly layerId: string;
  readonly todoSlug: string;
  readonly title: string;
  readonly dueAt: string;
  readonly priority: number;
  readonly status: string;
}

/**
 * Read all projection rows for a layer. Stable order by `due_at`
 * ascending then `priority` ascending so the calendar UI's merged
 * feed is deterministic.
 */
export function listTodoProjectionsForLayer(
  db: Database,
  layerId: string,
): readonly TodoCalendarProjectionRow[] {
  interface SqlRow {
    readonly todo_id: string;
    readonly layer_id: string;
    readonly todo_slug: string;
    readonly title: string;
    readonly due_at: string;
    readonly priority: number;
    readonly status: string;
  }
  const rows = db
    .query<SqlRow, [string]>(
      `SELECT todo_id, layer_id, todo_slug, title, due_at, priority, status
         FROM calendar_projection_todos
        WHERE layer_id = ?
        ORDER BY due_at ASC, priority ASC, todo_slug ASC`,
    )
    .all(layerId);
  return rows.map((r) => ({
    todoId: r.todo_id,
    layerId: r.layer_id,
    todoSlug: r.todo_slug,
    title: r.title,
    dueAt: r.due_at,
    priority: r.priority,
    status: r.status,
  }));
}
