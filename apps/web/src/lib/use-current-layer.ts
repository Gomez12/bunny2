/**
 * `useCurrentLayer()` — resolves the URL's `:layerSlug` param against
 * the caller's `effectiveLayers` (from `session.ts`), and computes a
 * best-effort `canEdit` UI hint.
 *
 * ⚠️  `canEdit` is a UI affordance, NOT a security gate. Every mutation
 * still hits the server, which re-checks `canEditLayer` per the §4.4
 * authorization table. The server's 403 lands in each form's
 * error region.
 *
 * Project-layer membership roles are NOT included in `/me/layers`
 * (the route returns `Layer[]` only). For project layers we therefore
 * render edit controls optimistically — a non-owner will see them but
 * any mutation comes back with `errors.layer.forbidden`, which the
 * forms surface verbatim.
 */

import { useEffect, useMemo } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import type { Layer } from './api-types';
import { useSession } from './session';
import { pushToast } from './toast';

export interface CurrentLayer {
  readonly layer: Layer;
  readonly canEdit: boolean;
  readonly isPersonal: boolean;
  readonly isProject: boolean;
  readonly isGroup: boolean;
  readonly isEveryone: boolean;
}

export type CurrentLayerResult =
  | { readonly status: 'loading' }
  | { readonly status: 'fallback' }
  | ({ readonly status: 'ready' } & CurrentLayer);

/**
 * Subpath after `/l/:layerSlug` — i.e. `/dashboard` or `/settings`.
 * Used when redirecting the caller to a slug that IS visible so they
 * stay on the same logical page.
 */
export function subpathFromLocation(pathname: string, slug: string): string {
  const prefix = `/l/${slug}`;
  if (!pathname.startsWith(prefix)) return '/dashboard';
  const rest = pathname.slice(prefix.length);
  if (rest.length === 0 || rest === '/') return '/dashboard';
  return rest;
}

export function computeCanEdit(layer: Layer, userId: string | null, isAdmin: boolean): boolean {
  if (userId === null) return false;
  if (isAdmin) return true;
  if (layer.type === 'personal') return layer.ownerUserId === userId;
  if (layer.type === 'everyone') return false;
  if (layer.type === 'group') return false; // group-admin role lives in phase 2.4 follow-up
  // project — optimistic. Server validates on every mutation.
  return true;
}

export function useCurrentLayer(): CurrentLayerResult {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams<{ layerSlug: string }>();
  const slug = params.layerSlug ?? '';

  const match = useMemo<Layer | null>(() => {
    for (const l of session.layers) {
      if (l.slug === slug) return l;
    }
    return null;
  }, [session.layers, slug]);

  // Redirect: slug not in the user's effective set → bounce to personal
  // layer + toast. Run in an effect so we don't navigate during render.
  useEffect(() => {
    if (session.status !== 'authenticated') return;
    if (slug === '') return;
    if (match !== null) return;
    const personal = session.personalLayerSlug;
    if (personal === null) {
      // No personal layer to fall back to — send to /layers list.
      navigate('/layers', { replace: true });
      pushToast({
        kind: 'error',
        message: t('layer.switcher.fallback.noPersonal'),
      });
      return;
    }
    const sub = subpathFromLocation(location.pathname, slug);
    navigate(`/l/${personal}${sub}`, { replace: true });
    pushToast({
      kind: 'info',
      message: t('layer.switcher.fallback.notVisible'),
    });
  }, [session.status, session.personalLayerSlug, slug, match, navigate, location.pathname, t]);

  if (session.status !== 'authenticated') {
    return { status: 'loading' };
  }
  if (match === null) {
    return { status: 'fallback' };
  }
  const canEdit = computeCanEdit(match, session.user?.id ?? null, session.isAdmin);
  return {
    status: 'ready',
    layer: match,
    canEdit,
    isPersonal: match.type === 'personal',
    isProject: match.type === 'project',
    isGroup: match.type === 'group',
    isEveryone: match.type === 'everyone',
  };
}
