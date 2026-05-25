/**
 * Phase 11.5 — pure-logic tests for the whiteboards list reducer +
 * URL helpers. Mirrors `companies-list-page.test.ts` /
 * `calendar-page.test.ts`: no DOM mount, no canvas — the
 * `WhiteboardsListPage` itself imports React UI primitives that the
 * `bun test` harness can't render, so the contract test is scoped to
 * the reducer + URL helpers per
 * `docs/dev/follow-ups/web-component-tests.md`.
 */
import { describe, expect, it } from 'bun:test';
import type { EntitySummary, WhiteboardListWithThumbnailItem } from '../src/lib/api-types';
import { i18nKeysForKind, isSoftDeleted, restoreTelemetryName } from '../src/lib/entity-restore';
import {
  RESERVED_WHITEBOARD_SLUGS,
  WHITEBOARD_SERVER_KIND,
  WHITEBOARD_WEB_SEGMENT,
  slugifyWhiteboardTitle,
  webWhiteboardNewPath,
  webWhiteboardPath,
  webWhiteboardsPath,
  whiteboardServerBase,
  whiteboardServerCheckpoint,
  whiteboardServerDetail,
  whiteboardServerListWithThumbnails,
} from '../src/lib/whiteboards-routes';
import { whiteboardsListView } from '../src/pages/whiteboards-list-page-state';

function item(
  overrides: Partial<WhiteboardListWithThumbnailItem> = {},
): WhiteboardListWithThumbnailItem {
  return {
    id: '00000000-0000-0000-0000-000000000010',
    slug: 'q3-retro',
    title: 'Q3 retro board',
    updatedAt: '2026-05-24T10:00:00.000Z',
    updatedBy: '00000000-0000-0000-0000-0000000000bb',
    lastCheckpointAt: null,
    elementCount: 3,
    thumbnailBlobBase64: null,
    ...overrides,
  };
}

describe('whiteboardsListView', () => {
  it('returns the loading branch for a loading input', () => {
    expect(whiteboardsListView({ status: 'loading' })).toEqual({ kind: 'loading' });
  });

  it('returns the error branch with the i18n key preserved', () => {
    expect(whiteboardsListView({ status: 'error', errorKey: 'errors.network' })).toEqual({
      kind: 'error',
      errorKey: 'errors.network',
    });
  });

  it('returns the empty branch when the items list is empty', () => {
    expect(whiteboardsListView({ status: 'ready', items: [] })).toEqual({
      kind: 'empty',
    });
  });

  it('returns the ready branch with the array when the list is non-empty', () => {
    const view = whiteboardsListView({ status: 'ready', items: [item()] });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.items).toHaveLength(1);
      expect(view.items[0]?.slug).toBe('q3-retro');
      // The default thumbnail branch carries deletedAt:null and the
      // numeric elementCount.
      expect(view.items[0]?.deletedAt).toBeNull();
      expect(view.items[0]?.elementCount).toBe(3);
    }
  });

  // -------------------------------------------------------------------------
  // Phase 1 (ui-exposure-gaps) — `?includeDeleted=1` path. The list
  // page switches from `_list-with-thumbnails` (which hard-filters
  // `deleted_at IS NULL`) to the generic `EntitySummary[]` endpoint;
  // the reducer flattens both shapes into the same row.

  function summary(overrides: Partial<EntitySummary> = {}): EntitySummary {
    return {
      id: '00000000-0000-0000-0000-000000000010',
      kind: 'whiteboard',
      layerId: '00000000-0000-0000-0000-0000000000aa',
      slug: 'q3-retro',
      title: 'Q3 retro board',
      subtitle: null,
      searchableText: 'q3 retro',
      meta: {
        createdAt: '2026-05-23T00:00:00.000Z',
        createdBy: '00000000-0000-0000-0000-0000000000bb',
        updatedAt: '2026-05-24T10:00:00.000Z',
        updatedBy: '00000000-0000-0000-0000-0000000000bb',
        deletedAt: null,
        deletedBy: null,
        version: 1,
        originalLocale: 'en',
      },
      ...overrides,
    };
  }

  it('returns ready (empty) for the include-deleted branch when no summaries', () => {
    expect(whiteboardsListView({ status: 'ready-with-deleted', summaries: [] })).toEqual({
      kind: 'empty',
    });
  });

  it('flattens summaries into rows with deletedAt and null thumbnail/elementCount', () => {
    const deleted = summary({
      slug: 'old-board',
      title: 'Old board',
      meta: {
        ...summary().meta,
        deletedAt: '2026-05-24T11:00:00.000Z',
        deletedBy: '00000000-0000-0000-0000-0000000000bb',
        version: 2,
      },
    });
    const view = whiteboardsListView({
      status: 'ready-with-deleted',
      summaries: [summary(), deleted],
    });
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.items).toHaveLength(2);
      expect(view.items[0]?.deletedAt).toBeNull();
      expect(view.items[0]?.thumbnailBlobBase64).toBeNull();
      expect(view.items[0]?.elementCount).toBeNull();
      expect(view.items[1]?.slug).toBe('old-board');
      expect(view.items[1]?.deletedAt).toBe('2026-05-24T11:00:00.000Z');
    }
  });
});

describe('soft-delete restore (whiteboards)', () => {
  it('isSoftDeleted is true when deletedAt is set', () => {
    expect(isSoftDeleted({ deletedAt: '2026-05-24T11:00:00.000Z' })).toBe(true);
    expect(isSoftDeleted({ deletedAt: null })).toBe(false);
  });

  it('i18nKeysForKind("whiteboard") returns the entity.whiteboards.restore.* namespace', () => {
    const keys = i18nKeysForKind('whiteboard');
    expect(keys.deletedBadge).toBe('entity.whiteboards.restore.deletedBadge');
    expect(keys.bannerTitle).toBe('entity.whiteboards.restore.bannerTitle');
    expect(keys.restoreCta).toBe('entity.whiteboards.restore.cta');
    expect(keys.confirmBody).toBe('entity.whiteboards.restore.confirmBody');
    expect(keys.toggleHideDeleted).toBe('entity.whiteboards.restore.toggleHideDeleted');
  });

  it('restoreTelemetryName uses the singular kind segment', () => {
    expect(restoreTelemetryName('whiteboard')).toBe('entity.whiteboard.restore');
  });
});

describe('whiteboards-routes helpers', () => {
  it('exposes the singular server kind and plural web segment', () => {
    expect(WHITEBOARD_SERVER_KIND).toBe('whiteboard');
    expect(WHITEBOARD_WEB_SEGMENT).toBe('whiteboards');
  });

  it('reserves the new slug', () => {
    expect(RESERVED_WHITEBOARD_SLUGS.has('new')).toBe(true);
  });

  it('builds web URLs with the plural segment', () => {
    expect(webWhiteboardsPath('alpha')).toBe('/l/alpha/whiteboards');
    expect(webWhiteboardNewPath('alpha')).toBe('/l/alpha/whiteboards/new');
    expect(webWhiteboardPath('alpha', 'board-1')).toBe('/l/alpha/whiteboards/board-1');
  });

  it('builds server URLs with the singular segment', () => {
    expect(whiteboardServerBase('alpha')).toBe('/l/alpha/whiteboard');
    expect(whiteboardServerDetail('alpha', 'b1')).toBe('/l/alpha/whiteboard/b1');
    expect(whiteboardServerCheckpoint('alpha', 'b1')).toBe('/l/alpha/whiteboard/b1/_checkpoint');
    expect(whiteboardServerListWithThumbnails('alpha')).toBe(
      '/l/alpha/whiteboard/_list-with-thumbnails',
    );
  });

  it('slugifies titles to lowercase-dashed and rewrites reserved slugs', () => {
    expect(slugifyWhiteboardTitle('Q3 retro board')).toBe('q3-retro-board');
    expect(slugifyWhiteboardTitle('  Spaces  Around  ')).toBe('spaces-around');
    expect(slugifyWhiteboardTitle('New')).toBe('new-whiteboard');
  });
});
