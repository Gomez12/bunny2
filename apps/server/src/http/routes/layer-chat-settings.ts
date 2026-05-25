/**
 * `/l/:slug/settings/chat` HTTP routes — per-layer chat model +
 * embedding budget.
 *
 * Two endpoints:
 *  - `GET  /l/:slug/settings/chat` — any layer member.
 *  - `PUT  /l/:slug/settings/chat` — admin-only via `canEditLayer`;
 *                                    zod-validated body.
 *
 * Response shape carries:
 *  - `source: 'default' | 'saved'` — lets the UI render a "using
 *    defaults" badge without a second round-trip.
 *  - `settings` — current effective settings (NULL = inherits).
 *  - `spend` — tokens consumed today + over the last 30 days. The UI
 *    surfaces a "today / month so far" readout next to the cap inputs.
 *
 * The route mirrors the shape of `layer-proposal-settings.ts`. No
 * bus event is emitted on PUT — the resolver consults the table per
 * call so changes take effect immediately on the next message.
 */

import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import {
  LayerChatSettingsInputSchema,
  type LayerChatSettings,
  type LayerChatSettingsResponse,
} from '@bunny2/shared';
import { canEditLayer } from '../../layers/authz';
import { createRequireLayer } from '../middleware/layer';
import { ADMIN_GROUP_ID_KEY } from '../../auth/seed';
import { getMeta } from '../../storage/kv-meta';
import type { GroupResolver } from '../../auth/group-resolver';
import type { HonoVariables } from '../types';
import {
  createLayerChatSettingsRepo,
  type LayerChatSettingsRepo,
} from '../../chat/repos/layer-chat-settings-repo';
import {
  createLayerEmbeddingSpendRepo,
  isoDay,
} from '../../chat/repos/layer-embedding-spend-repo';

const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;
const FORBIDDEN = { error: 'errors.layer.forbidden' } as const;
const BAD_REQUEST = { error: 'errors.validation' } as const;

export interface LayerChatSettingsRouteDeps {
  readonly db: Database;
  readonly resolver: GroupResolver;
  readonly now?: () => Date;
}

function rowToWire(layerId: string, row: { readonly model: string | null; readonly embeddingDailyCap: number | null; readonly embeddingMonthlyCap: number | null; readonly createdAt: string; readonly updatedAt: string }): LayerChatSettings {
  return {
    layerId,
    model: row.model,
    embeddingDailyCap: row.embeddingDailyCap,
    embeddingMonthlyCap: row.embeddingMonthlyCap,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function defaults(layerId: string): LayerChatSettings {
  return {
    layerId,
    model: null,
    embeddingDailyCap: null,
    embeddingMonthlyCap: null,
    createdAt: '',
    updatedAt: '',
  };
}

function readSettings(repo: LayerChatSettingsRepo, layerId: string): {
  readonly source: 'default' | 'saved';
  readonly settings: LayerChatSettings;
} {
  const row = repo.find(layerId);
  if (row === null) {
    return { source: 'default', settings: defaults(layerId) };
  }
  return { source: 'saved', settings: rowToWire(layerId, row) };
}

export function registerLayerChatSettingsRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: LayerChatSettingsRouteDeps,
): void {
  const requireLayer = createRequireLayer();
  const clock = deps.now ?? ((): Date => new Date());
  const settingsRepo = createLayerChatSettingsRepo(deps.db);
  const spendRepo = createLayerEmbeddingSpendRepo(deps.db);

  function computeIsSiteAdmin(userId: string): boolean {
    const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY);
    if (adminGroupId === null || adminGroupId === '') return false;
    return deps.resolver.isUserInGroup(userId, adminGroupId);
  }

  app.get('/l/:slug/settings/chat', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const day = isoDay(clock());
    const { source, settings } = readSettings(settingsRepo, layer.id);
    const response: LayerChatSettingsResponse = {
      source,
      settings,
      spend: {
        day,
        tokensToday: spendRepo.getDayTokens(layer.id, day),
        tokensLast30Days: spendRepo.sumLastDays(layer.id, day, 30),
      },
    };
    console.log('[layer-chat-settings.get]', {
      event: 'layer-chat-settings.get',
      layerId: layer.id,
      source,
    });
    return c.json(response);
  });

  app.put('/l/:slug/settings/chat', requireLayer, async (c) => {
    const user = c.get('user');
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    if (!canEditLayer({ user, layer, db: deps.db, isSiteAdmin: computeIsSiteAdmin(user.id) })) {
      return c.json(FORBIDDEN, 403);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(BAD_REQUEST, 400);
    }
    const parsed = LayerChatSettingsInputSchema.safeParse(raw);
    if (!parsed.success) {
      console.log('[layer-chat-settings.put.bad-request]', {
        event: 'layer-chat-settings.put.bad-request',
        layerId: layer.id,
        updatedBy: user.id,
        issues: parsed.error.issues.length,
      });
      return c.json(BAD_REQUEST, 400);
    }
    const nowIso = clock().toISOString();
    try {
      settingsRepo.upsert({
        layerId: layer.id,
        model: parsed.data.model,
        embeddingDailyCap: parsed.data.embeddingDailyCap,
        embeddingMonthlyCap: parsed.data.embeddingMonthlyCap,
        now: nowIso,
      });
    } catch (err) {
      console.error('[layer-chat-settings.put.failed]', {
        event: 'layer-chat-settings.put.failed',
        layerId: layer.id,
        updatedBy: user.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(BAD_REQUEST, 400);
    }
    const { source, settings } = readSettings(settingsRepo, layer.id);
    const day = isoDay(clock());
    const response: LayerChatSettingsResponse = {
      source,
      settings,
      spend: {
        day,
        tokensToday: spendRepo.getDayTokens(layer.id, day),
        tokensLast30Days: spendRepo.sumLastDays(layer.id, day, 30),
      },
    };
    console.log('[layer-chat-settings.put]', {
      event: 'layer-chat-settings.put',
      layerId: layer.id,
      updatedBy: user.id,
      modelOverride: settings.model !== null,
      dailyCapSet: settings.embeddingDailyCap !== null,
      monthlyCapSet: settings.embeddingMonthlyCap !== null,
    });
    return c.json(response);
  });
}
