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
import type { WhiteboardListWithThumbnailItem } from '../src/lib/api-types';
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

function item(overrides: Partial<WhiteboardListWithThumbnailItem> = {}): WhiteboardListWithThumbnailItem {
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
    expect(
      whiteboardsListView({ status: 'error', errorKey: 'errors.network' }),
    ).toEqual({ kind: 'error', errorKey: 'errors.network' });
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
    }
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
    expect(webWhiteboardPath('alpha', 'board-1')).toBe(
      '/l/alpha/whiteboards/board-1',
    );
  });

  it('builds server URLs with the singular segment', () => {
    expect(whiteboardServerBase('alpha')).toBe('/l/alpha/whiteboard');
    expect(whiteboardServerDetail('alpha', 'b1')).toBe('/l/alpha/whiteboard/b1');
    expect(whiteboardServerCheckpoint('alpha', 'b1')).toBe(
      '/l/alpha/whiteboard/b1/_checkpoint',
    );
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
