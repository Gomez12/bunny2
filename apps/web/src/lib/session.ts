/**
 * Module-level session store.
 *
 * Keeps the web app's auth state out of any single React component so the
 * top-level state machine in `App.tsx` can read/listen via the standard
 * `useSyncExternalStore` contract. Implemented with `EventTarget` to avoid
 * a third-party state library — phase 2.6 only needs a small reactive
 * pub/sub.
 *
 * State machine (per `docs/dev/plans/phase-02-users-and-groups.md` §4.1):
 *
 *   unknown ─bootstrapSession()─▶ loading
 *   loading ─200 /auth/me──────▶ authenticated
 *   loading ─401 /auth/me──────▶ guest
 *   loading ─network err───────▶ guest (with console.warn)
 *   guest   ─applyLogin()──────▶ authenticated
 *   *       ─applyLogout()─────▶ guest
 *
 * Components never mutate the state object directly — they call the
 * exported transitions or `useSession()` to read.
 */

import { useSyncExternalStore } from 'react';
import { fetchMe } from './api';
import type { LoginResponse, SafeUser } from './api-types';

export type SessionStatus = 'unknown' | 'loading' | 'guest' | 'authenticated';

export interface SessionState {
  readonly status: SessionStatus;
  readonly user: SafeUser | null;
  readonly mustChangePassword: boolean;
  readonly isAdmin: boolean;
  readonly sessionExpiresAt: string | null;
}

const initial: SessionState = {
  status: 'unknown',
  user: null,
  mustChangePassword: false,
  isAdmin: false,
  sessionExpiresAt: null,
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
      });
      return;
    }
    const { me } = result;
    setState({
      status: 'authenticated',
      user: me.user,
      mustChangePassword: me.mustChangePassword,
      isAdmin: me.isAdmin,
      sessionExpiresAt: me.sessionExpiresAt,
    });
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
    });
  }
}

export function applyLogin(response: LoginResponse): void {
  // `/auth/login` does not currently surface `isAdmin` — we re-bootstrap to
  // pick it up. Setting authenticated optimistically keeps the UI from
  // flashing back to LoginPage between the login response and the /me
  // refresh.
  setState({
    status: 'authenticated',
    user: response.user,
    mustChangePassword: response.mustChangePassword,
    // Be conservative until /me confirms — admin tabs simply won't render
    // for the few milliseconds it takes the bootstrap to round-trip.
    isAdmin: false,
    sessionExpiresAt: response.sessionExpiresAt,
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
  });
}
