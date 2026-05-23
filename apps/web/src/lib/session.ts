/**
 * Module-level session store.
 *
 * Keeps the web app's auth state out of any single React component so the
 * top-level state machine in `App.tsx` can read/listen via the standard
 * `useSyncExternalStore` contract. Implemented with `EventTarget` to avoid
 * a third-party state library — phase 2.6 only needs a small reactive
 * pub/sub.
 *
 * State machine (per `docs/dev/plans/done/phase-02-users-and-groups.md` §4.1
 * + phase 3.5 layers extension):
 *
 *   unknown   ─bootstrapSession()─▶ loading
 *   loading   ─200 /auth/me─────▶ loading-layers
 *   loading   ─401 /auth/me─────▶ guest
 *   loading   ─409 (rotate-gate)▶ authenticated (mustChangePassword)
 *   loading   ─network err──────▶ guest (with console.warn)
 *   loading-layers ─/me/layers──▶ authenticated
 *   guest     ─applyLogin()─────▶ loading-layers
 *   *         ─applyLogout()────▶ guest
 *
 * The intermediate `loading-layers` status prevents App.tsx from rendering
 * a layer-scoped route before the personal-layer slug is known — see
 * `personalLayerSlug` on the snapshot.
 *
 * Components never mutate the state object directly — they call the
 * exported transitions or `useSession()` to read.
 */

import { useSyncExternalStore } from 'react';
import { fetchMe, getMyLayers } from './api';
import type { Layer, LoginResponse, SafeUser } from './api-types';

export type SessionStatus = 'unknown' | 'loading' | 'loading-layers' | 'guest' | 'authenticated';

export interface SessionState {
  readonly status: SessionStatus;
  readonly user: SafeUser | null;
  readonly mustChangePassword: boolean;
  readonly isAdmin: boolean;
  readonly sessionExpiresAt: string | null;
  /** Effective-layer set for the current user — empty until /me/layers loads. */
  readonly layers: readonly Layer[];
  /** Slug of the user's personal layer, the default landing target. */
  readonly personalLayerSlug: string | null;
}

const initial: SessionState = {
  status: 'unknown',
  user: null,
  mustChangePassword: false,
  isAdmin: false,
  sessionExpiresAt: null,
  layers: [],
  personalLayerSlug: null,
};

let current: SessionState = initial;

const target = new EventTarget();
const EVENT = 'session-change';

function emit(): void {
  target.dispatchEvent(new Event(EVENT));
}

function setState(next: SessionState): void {
  current = next;
  emit();
}

export function getSessionSnapshot(): SessionState {
  return current;
}

export function subscribeToSession(listener: () => void): () => void {
  target.addEventListener(EVENT, listener);
  return (): void => target.removeEventListener(EVENT, listener);
}

export function useSession(): SessionState {
  return useSyncExternalStore(subscribeToSession, getSessionSnapshot, getSessionSnapshot);
}

/**
 * Find the caller's personal layer in their effective set. There is
 * exactly one per user (seeded in phase 3.2). Returns `null` if the
 * effective set is empty or if seed hasn't propagated yet — App.tsx
 * treats that case by falling back to the `/layers` page rather than
 * forcing a path that would loop.
 */
export function pickPersonalLayer(layers: readonly Layer[], userId: string): Layer | null {
  for (const l of layers) {
    if (l.type === 'personal' && l.ownerUserId === userId) return l;
  }
  return null;
}

async function loadLayersInto(): Promise<void> {
  // Caller has already set the session to `loading-layers` with the user
  // populated. We fetch /me/layers and then flip to `authenticated`.
  try {
    const layers = await getMyLayers();
    const personal = current.user !== null ? pickPersonalLayer(layers, current.user.id) : null;
    setState({
      ...current,
      status: 'authenticated',
      layers,
      personalLayerSlug: personal?.slug ?? null,
    });
  } catch (err) {
    // Even if /me/layers fails we still consider the user authenticated
    // — they can navigate to `/layers` which shows an empty/error state.
    // The forced ChangePasswordPage gate intentionally also lands here:
    // when the auth gate fires on /me/layers, we just skip with empty.
    console.warn('[session] /me/layers failed:', err);
    setState({
      ...current,
      status: 'authenticated',
      layers: [],
      personalLayerSlug: null,
    });
  }
}

export async function bootstrapSession(): Promise<void> {
  setState({ ...current, status: 'loading' });
  try {
    const result = await fetchMe();
    if (result.kind === 'guest') {
      setState({
        status: 'guest',
        user: null,
        mustChangePassword: false,
        isAdmin: false,
        sessionExpiresAt: null,
        layers: [],
        personalLayerSlug: null,
      });
      return;
    }
    if (result.kind === 'gated') {
      // The password-rotation gate is blocking `/me`, but the session
      // cookie IS valid. Preserve whatever we already know (from a
      // prior `applyLogin`) and just make sure the flag is set so the
      // AppShell routes to the forced ChangePasswordPage.
      setState({
        status: 'authenticated',
        user: current.user,
        mustChangePassword: true,
        isAdmin: false,
        sessionExpiresAt: current.sessionExpiresAt,
        layers: [],
        personalLayerSlug: null,
      });
      return;
    }
    const { me } = result;
    setState({
      status: 'loading-layers',
      user: me.user,
      mustChangePassword: me.mustChangePassword,
      isAdmin: me.isAdmin,
      sessionExpiresAt: me.sessionExpiresAt,
      layers: [],
      personalLayerSlug: null,
    });
    await loadLayersInto();
  } catch (err) {
    // Network/parse errors on bootstrap fall back to guest so the UI is
    // still usable (the login form will surface a helpful error on submit).
    console.warn('[session] bootstrap failed, falling back to guest:', err);
    setState({
      status: 'guest',
      user: null,
      mustChangePassword: false,
      isAdmin: false,
      sessionExpiresAt: null,
      layers: [],
      personalLayerSlug: null,
    });
  }
}

/** Re-fetch /me/layers without re-running /auth/me. */
export async function refreshLayers(): Promise<void> {
  if (current.user === null) return;
  try {
    const layers = await getMyLayers();
    const personal = pickPersonalLayer(layers, current.user.id);
    setState({
      ...current,
      layers,
      personalLayerSlug: personal?.slug ?? current.personalLayerSlug,
    });
  } catch (err) {
    console.warn('[session] refreshLayers failed:', err);
  }
}

export function applyLogin(response: LoginResponse): void {
  // `/auth/login` does not currently surface `isAdmin` — we re-bootstrap to
  // pick it up. Setting authenticated optimistically keeps the UI from
  // flashing back to LoginPage between the login response and the /me
  // refresh.
  setState({
    status: 'loading-layers',
    user: response.user,
    mustChangePassword: response.mustChangePassword,
    // Be conservative until /me confirms — admin tabs simply won't render
    // for the few milliseconds it takes the bootstrap to round-trip.
    isAdmin: false,
    sessionExpiresAt: response.sessionExpiresAt,
    layers: [],
    personalLayerSlug: null,
  });
  void bootstrapSession();
}

export function applyLogout(): void {
  setState({
    status: 'guest',
    user: null,
    mustChangePassword: false,
    isAdmin: false,
    sessionExpiresAt: null,
    layers: [],
    personalLayerSlug: null,
  });
}
