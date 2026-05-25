/**
 * Phase 11.5 — pure-logic tests for the whiteboard detail reducer.
 *
 * The detail page itself mounts the lazy-loaded `@excalidraw/excalidraw`
 * canvas, which the web `bun test` harness cannot drive (see
 * `docs/dev/follow-ups/web-component-tests.md`). The contract test is
 * therefore scoped to the seven render branches the page distinguishes
 * (loading / error / ready / saving / saveError / locked / readyAfter
 * save) and the lock-banner trigger predicate.
 */
import { describe, expect, it } from 'bun:test';
import type { Whiteboard } from '../src/lib/api-types';
import {
  shouldShowLockBanner,
  whiteboardDetailLoadInitial,
  whiteboardDetailView,
  type WhiteboardDetailLoad,
} from '../src/pages/whiteboard-detail-page-state';

function whiteboard(overrides: Partial<Whiteboard> = {}): Whiteboard {
  const base: Whiteboard = {
    id: '00000000-0000-0000-0000-000000000020',
    kind: 'whiteboard',
    layerId: '00000000-0000-0000-0000-0000000000aa',
    slug: 'q3-retro',
    title: 'Q3 retro',
    subtitle: null,
    searchableText: '',
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
    payload: {
      scene: { elements: [] },
      files: {},
    },
    externalLinks: [],
    ...overrides,
  };
  return base;
}

function ready(overrides: Partial<WhiteboardDetailLoad> = {}): WhiteboardDetailLoad {
  return {
    status: 'ready',
    whiteboard: whiteboard(),
    errorKey: null,
    locked: false,
    saveErrorKey: null,
    saving: false,
    ...overrides,
  };
}

describe('whiteboardDetailLoadInitial', () => {
  it('returns a loading state with every optional field nulled / false', () => {
    const initial = whiteboardDetailLoadInitial();
    expect(initial.status).toBe('loading');
    expect(initial.whiteboard).toBeNull();
    expect(initial.errorKey).toBeNull();
    expect(initial.saveErrorKey).toBeNull();
    expect(initial.locked).toBe(false);
    expect(initial.saving).toBe(false);
  });
});

describe('whiteboardDetailView', () => {
  it('returns the loading branch on the initial state', () => {
    expect(whiteboardDetailView(whiteboardDetailLoadInitial())).toEqual({
      kind: 'loading',
    });
  });

  it('returns the error branch with the i18n key preserved', () => {
    const view = whiteboardDetailView({
      status: 'error',
      errorKey: 'errors.network',
      whiteboard: null,
      locked: false,
      saveErrorKey: null,
      saving: false,
    });
    expect(view).toEqual({ kind: 'error', errorKey: 'errors.network' });
  });

  it('falls back to errors.entity.notFound when ready without a whiteboard', () => {
    const view = whiteboardDetailView({
      status: 'ready',
      errorKey: null,
      whiteboard: null,
      locked: false,
      saveErrorKey: null,
      saving: false,
    });
    expect(view).toEqual({ kind: 'error', errorKey: 'errors.entity.notFound' });
  });

  it('returns the ready branch with the saving flag preserved', () => {
    const view = whiteboardDetailView(ready({ saving: true }));
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.saving).toBe(true);
      expect(view.saveErrorKey).toBeNull();
    }
  });

  it('returns the ready branch with the saveErrorKey preserved', () => {
    const view = whiteboardDetailView(
      ready({ saveErrorKey: 'errors.whiteboards.tooLarge' }),
    );
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.saveErrorKey).toBe('errors.whiteboards.tooLarge');
    }
  });

  it('returns the ready branch with the locked flag preserved', () => {
    const view = whiteboardDetailView(ready({ locked: true }));
    expect(view.kind).toBe('ready');
    if (view.kind === 'ready') {
      expect(view.locked).toBe(true);
    }
  });
});

describe('shouldShowLockBanner', () => {
  const baseArgs = {
    loadedAt: '2026-05-24T10:00:00.000Z',
    loadedBy: 'user-a',
    currentUserId: 'user-a',
    serverUpdatedAt: '2026-05-24T11:00:00.000Z',
    serverUpdatedBy: 'user-b',
  };

  it('shows the banner when another user wrote a newer revision', () => {
    expect(shouldShowLockBanner(baseArgs)).toBe(true);
  });

  it('does not show the banner when the same user wrote the new revision', () => {
    expect(
      shouldShowLockBanner({ ...baseArgs, serverUpdatedBy: 'user-a' }),
    ).toBe(false);
  });

  it('does not show the banner when the editor wrote the new revision', () => {
    expect(
      shouldShowLockBanner({
        ...baseArgs,
        loadedBy: 'user-b',
        serverUpdatedBy: 'user-b',
      }),
    ).toBe(false);
  });

  it('does not show the banner when the server timestamp is not strictly newer', () => {
    expect(
      shouldShowLockBanner({
        ...baseArgs,
        serverUpdatedAt: baseArgs.loadedAt,
      }),
    ).toBe(false);
  });
});
