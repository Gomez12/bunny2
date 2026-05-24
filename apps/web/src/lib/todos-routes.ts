/**
 * Phase 4d.5 — URL helpers for the todos surface.
 *
 * Same singular ↔ plural seam as Companies (`companies-routes.ts`),
 * Contacts (`contacts-routes.ts`), and Calendar (`calendar-routes.ts`):
 * the server-side entity router (§4.0) mounts the singular per-kind
 * segment (`/l/:slug/todo/...`) while the web URLs the user sees use
 * the friendlier plural `/todos/...` segment. The 4a.1 close-out
 * deferred a `routeSegment` override on `EntityModule` until a second
 * entity needed a different mapping; todos intentionally reuses the
 * same convention so no foundation change is required.
 *
 * Web URLs:
 *   /l/:layerSlug/todos                       — list (with view toggle)
 *   /l/:layerSlug/todos/new                   — create-dialog deep link
 *   /l/:layerSlug/todos/:todoSlug             — detail / edit
 *
 * Server URLs every helper hits underneath:
 *   /l/:layerSlug/todo
 *   /l/:layerSlug/todo/:todoSlug
 */

export const TODOS_SERVER_KIND = 'todo';
export const TODOS_WEB_SEGMENT = 'todos';

/**
 * Slugs that collide with static sub-routes mounted under
 * `/l/:layerSlug/todos/*`. React Router v6 ranks routes by specificity
 * so `/new` always wins over `/:todoSlug`, but a todo titled "New"
 * would slugify to `new` and then become unreachable through the
 * detail link. Mirrors `RESERVED_CALENDAR_SLUGS` in
 * `calendar-routes.ts`.
 */
export const RESERVED_TODO_SLUGS: ReadonlySet<string> = new Set(['new']);

export function webTodosPath(layerSlug: string): string {
  return `/l/${layerSlug}/${TODOS_WEB_SEGMENT}`;
}

export function webTodoPath(layerSlug: string, todoSlug: string): string {
  return `/l/${layerSlug}/${TODOS_WEB_SEGMENT}/${todoSlug}`;
}

export function webTodoNewPath(layerSlug: string): string {
  return `/l/${layerSlug}/${TODOS_WEB_SEGMENT}/new`;
}

export function todosServerBase(layerSlug: string): string {
  return `/l/${encodeURIComponent(layerSlug)}/${TODOS_SERVER_KIND}`;
}

export function todoServerDetail(layerSlug: string, todoSlug: string): string {
  return `${todosServerBase(layerSlug)}/${encodeURIComponent(todoSlug)}`;
}

/**
 * Lowercase, dash-only slug derivation matching `CreateTodoRequestSchema`
 * (`^[a-z0-9-]+$`). Mirrors `slugifyContactTitle` /
 * `slugifyCompanyTitle` / `slugifyCalendarEventTitle` so the creation
 * surfaces feel identical, with one todos-specific twist: reserved
 * slugs (currently just `new`) are suffixed with `-todo` so they do
 * not collide with the static `/new` sub-route.
 */
export function slugifyTodoTitle(input: string): string {
  const base = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  if (RESERVED_TODO_SLUGS.has(base)) {
    return `${base}-todo`;
  }
  return base;
}
