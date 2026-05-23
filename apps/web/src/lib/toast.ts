/**
 * Tiny module-level toast store.
 *
 * Phase 3.5 needs a toast for the "layer-not-visible, redirected to
 * personal" fallback and for mutation success / error in
 * LayerSettingsPage. The web app deliberately ships no third-party
 * toast library — `package.json` has no `sonner`/`react-hot-toast`
 * and the AGENTS.md "Dependencies" rule prefers checking for an
 * existing solution first.
 *
 * Built on the same `useSyncExternalStore` + `EventTarget` pattern as
 * `session.ts`. A single `<aria-live="polite">` region in `App.tsx`
 * subscribes via `useToasts()` and renders the queue.
 *
 * Toasts auto-dismiss after a configurable timeout. The store is
 * append-only beyond the dismiss path — callers can't reorder or
 * mutate existing entries.
 */

import { useSyncExternalStore } from 'react';

export type ToastKind = 'info' | 'success' | 'error';

export interface Toast {
  readonly id: string;
  readonly kind: ToastKind;
  readonly message: string;
  /** Auto-dismiss after this many ms; 0 keeps the toast until manual dismiss. */
  readonly ttlMs: number;
}

const DEFAULT_TTL = 4000;

let next: Toast[] = [];
let counter = 0;
const target = new EventTarget();
const EVENT = 'toast-change';

function emit(): void {
  target.dispatchEvent(new Event(EVENT));
}

function snapshot(): readonly Toast[] {
  return next;
}

function subscribe(listener: () => void): () => void {
  target.addEventListener(EVENT, listener);
  return (): void => target.removeEventListener(EVENT, listener);
}

export function useToasts(): readonly Toast[] {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export interface PushToastInput {
  readonly kind?: ToastKind;
  readonly message: string;
  readonly ttlMs?: number;
}

export function pushToast(input: PushToastInput): string {
  counter += 1;
  const id = `toast-${String(counter)}`;
  const toast: Toast = {
    id,
    kind: input.kind ?? 'info',
    message: input.message,
    ttlMs: input.ttlMs ?? DEFAULT_TTL,
  };
  next = [...next, toast];
  emit();
  if (toast.ttlMs > 0 && typeof window !== 'undefined') {
    window.setTimeout(() => {
      dismissToast(id);
    }, toast.ttlMs);
  }
  return id;
}

export function dismissToast(id: string): void {
  const before = next.length;
  next = next.filter((t) => t.id !== id);
  if (next.length !== before) emit();
}

/** Test helper — clear the queue between assertions. */
export function _resetToasts(): void {
  next = [];
  counter = 0;
  emit();
}
