/**
 * Tiny in-memory cache of `groupId → { slug, name }`.
 *
 * Used by the admin users table to render each user's direct group
 * membership without making N round-trips. Backed by a single
 * `GET /admin/groups` call, refreshed on demand. Any admin mutation
 * (create/edit/delete user or group, member add/remove) must call
 * `invalidate()` so the next render fetches fresh data.
 *
 * Not reactive — callers render via a `useEffect` + state, exactly like
 * other list pages in phase 2.6.
 */

import { listAdminGroups } from './api';
import type { AdminGroupRow } from './api-types';

interface GroupBrief {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

let cache: Map<string, GroupBrief> | null = null;
let inflight: Promise<Map<string, GroupBrief>> | null = null;

function build(rows: readonly AdminGroupRow[]): Map<string, GroupBrief> {
  const map = new Map<string, GroupBrief>();
  for (const g of rows) {
    map.set(g.id, { id: g.id, slug: g.slug, name: g.name });
  }
  return map;
}

export async function ensureGroupsCache(): Promise<Map<string, GroupBrief>> {
  if (cache !== null) return cache;
  if (inflight !== null) return inflight;
  inflight = (async () => {
    const rows = await listAdminGroups();
    cache = build(rows);
    inflight = null;
    return cache;
  })();
  return inflight;
}

export function invalidateGroupsCache(): void {
  cache = null;
  inflight = null;
}
