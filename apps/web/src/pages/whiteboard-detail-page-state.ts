/**
 * Phase 11.5 — pure-logic helpers for the whiteboard detail page.
 *
 * The page itself owns the Excalidraw lazy embed + the debounced save
 * machinery; this module isolates the renderable view state so it can
 * be exercised by `bun test` without mounting a DOM. The seven render
 * branches mirror the deliverable list:
 *
 *   loading | error | ready | saving | saveError | locked | tooLarge
 *
 * (`tooLarge` is a special saveError variant — surfaces an inline
 * banner with the localized 413 message.)
 */
import type { Whiteboard } from '../lib/api-types';

export interface WhiteboardDetailLoad {
  readonly status: 'loading' | 'error' | 'ready';
  /** Present when `status === 'error'`. `null` otherwise. */
  readonly errorKey: string | null;
  /** Present when `status === 'ready'`. `null` otherwise. */
  readonly whiteboard: Whiteboard | null;
  /** When `true`, the lock banner is shown. Independent of save
   *  status — the banner is informational, not blocking. */
  readonly locked: boolean;
  /** Last save attempt's error key; `null` when there is no error. */
  readonly saveErrorKey: string | null;
  /** True when a save request is currently inflight. */
  readonly saving: boolean;
}

/**
 * Convenience constructor for the initial loading state — keeps the
 * `null`s and `false`s explicit at every call site so TypeScript's
 * `exactOptionalPropertyTypes` rule stays happy.
 */
export function whiteboardDetailLoadInitial(): WhiteboardDetailLoad {
  return {
    status: 'loading',
    errorKey: null,
    whiteboard: null,
    locked: false,
    saveErrorKey: null,
    saving: false,
  };
}

export type WhiteboardDetailView =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | {
      readonly kind: 'ready';
      readonly whiteboard: Whiteboard;
      readonly saving: boolean;
      readonly saveErrorKey: string | null;
      readonly locked: boolean;
    };

export function whiteboardDetailView(input: WhiteboardDetailLoad): WhiteboardDetailView {
  if (input.status === 'loading') return { kind: 'loading' };
  if (input.status === 'error') {
    return { kind: 'error', errorKey: input.errorKey ?? 'errors.network' };
  }
  if (input.whiteboard === null) {
    return { kind: 'error', errorKey: 'errors.entity.notFound' };
  }
  return {
    kind: 'ready',
    whiteboard: input.whiteboard,
    saving: input.saving,
    saveErrorKey: input.saveErrorKey,
    locked: input.locked,
  };
}

/**
 * Detects a lock condition: the latest server `updatedAt` is newer
 * than the snapshot we loaded AND the editing identity differs. The
 * page polls / focus-rechecks via this helper; absent a polling
 * mechanism the lock is detected on the next manual save attempt.
 *
 * Returns `true` when the banner should be shown.
 */
export function shouldShowLockBanner(args: {
  readonly loadedAt: string;
  readonly loadedBy: string;
  readonly currentUserId: string;
  readonly serverUpdatedAt: string;
  readonly serverUpdatedBy: string;
}): boolean {
  // No banner if the same user touched both versions — the "lock" is
  // about cross-session writes, not the user revisiting their own
  // whiteboard.
  if (args.serverUpdatedBy === args.currentUserId) return false;
  if (args.serverUpdatedBy === args.loadedBy) return false;
  // Banner only when the server is strictly newer.
  return args.serverUpdatedAt > args.loadedAt;
}

/**
 * Map a known ApiError key into the inline save banner key. Defaults
 * to a generic save error when the key is unrecognised.
 */
export function mapSaveErrorKey(errorKey: string): string {
  if (errorKey === 'errors.whiteboards.tooLarge') return errorKey;
  if (errorKey === 'errors.whiteboards.invalidScene') return errorKey;
  return errorKey;
}
