/**
 * Phase 11.5 — pure-logic helpers for the whiteboards list page.
 *
 * Mirrors `companies-page-state.ts` / `calendar-page-state.ts`:
 * the web repo has no DOM runtime, so the reducer is factored into
 * pure functions exercised by `bun test`. The render branches the
 * list page draws are derived here so the test surface stays small.
 *
 * Phase 1 (ui-exposure-gaps) extension — the default branch uses the
 * dedicated `_list-with-thumbnails` endpoint which hard-filters
 * `deleted_at IS NULL`. To surface soft-deleted whiteboards we
 * additionally load the generic `EntitySummary[]` shape from the
 * `/l/:slug/whiteboard?includeDeleted=true` route. The reducer
 * normalizes either shape into the same render branch so the
 * component stays one decision tree.
 */
import type { EntitySummary, WhiteboardListWithThumbnailItem } from '../lib/api-types';

export type WhiteboardsListInput =
  | { readonly status: 'loading' }
  | { readonly status: 'error'; readonly errorKey: string }
  | { readonly status: 'ready'; readonly items: readonly WhiteboardListWithThumbnailItem[] }
  | { readonly status: 'ready-with-deleted'; readonly summaries: readonly EntitySummary[] };

/**
 * Normalised row shape used by the list page render. `deletedAt` is
 * `null` for live rows; `thumbnailBlobBase64` / `elementCount` are
 * absent in the include-deleted branch because the generic list
 * endpoint does not project thumbnails.
 */
export interface WhiteboardsListRow {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly updatedBy: string;
  readonly thumbnailBlobBase64: string | null;
  readonly elementCount: number | null;
  readonly deletedAt: string | null;
}

export type WhiteboardsListView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'ready'; readonly items: readonly WhiteboardsListRow[] };

export function whiteboardsListView(input: WhiteboardsListInput): WhiteboardsListView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') return { kind: 'error', errorKey: input.errorKey };
  if (input.status === 'ready') {
    if (input.items.length === 0) return { kind: 'empty' };
    return {
      kind: 'ready',
      items: input.items.map(
        (item): WhiteboardsListRow => ({
          id: item.id,
          slug: item.slug,
          title: item.title,
          updatedAt: item.updatedAt,
          updatedBy: item.updatedBy,
          thumbnailBlobBase64: item.thumbnailBlobBase64,
          elementCount: item.elementCount,
          deletedAt: null,
        }),
      ),
    };
  }
  if (input.summaries.length === 0) return { kind: 'empty' };
  return {
    kind: 'ready',
    items: input.summaries.map(
      (s): WhiteboardsListRow => ({
        id: s.id,
        slug: s.slug,
        title: s.title,
        updatedAt: s.meta.updatedAt,
        updatedBy: s.meta.updatedBy,
        thumbnailBlobBase64: null,
        elementCount: null,
        deletedAt: s.meta.deletedAt,
      }),
    ),
  };
}
