/**
 * Phase 8.4 — `/l/:slug/settings/proposals` HTTP routes.
 *
 * Two endpoints:
 *  - `GET  /l/:slug/settings/proposals`  — any layer member (mirrors
 *                                          the proposals list / detail
 *                                          read policy in 7.6).
 *  - `PUT  /l/:slug/settings/proposals`  — admin-only via `canEditLayer`;
 *                                          zod-validated body; emits the
 *                                          new `layer.proposal-settings.
 *                                          updated` bus event with the
 *                                          closed-set list of changed
 *                                          field names (no values per
 *                                          plan §10 privacy guard).
 *
 * Response shape carries a `source: 'default' | 'saved'` discriminator
 * so the settings tab can render the "using defaults" badge without a
 * second round-trip (plan §4.4).
 *
 * Cross-layer probes return 404 via `requireLayer` — mirrors
 * `layer-proposals.ts` and `layer-capabilities.ts`. Logging follows
 * the per-route `event` pattern those sibling files established.
 */

import type { Hono } from 'hono';
import type { Database } from 'bun:sqlite';
import type { MessageBus } from '@bunny2/bus';
import { LayerProposalSettingsInputSchema, type LayerProposalSettings } from '@bunny2/shared';
import { canEditLayer } from '../../layers/authz';
import { createRequireLayer } from '../middleware/layer';
import { ADMIN_GROUP_ID_KEY } from '../../auth/seed';
import { getMeta } from '../../storage/kv-meta';
import type { GroupResolver } from '../../auth/group-resolver';
import type { HonoVariables } from '../types';
import { LayerProposalSettingsRepo } from '../../proposals/repos/layer-proposal-settings-repo';
import {
  LAYER_PROPOSAL_SETTINGS_UPDATED_EVENT_TYPE,
  type LayerProposalSettingsUpdatedPayload,
} from '../../proposals/events';

const NOT_VISIBLE = { error: 'errors.layer.notVisible' } as const;
const FORBIDDEN = { error: 'errors.layer.forbidden' } as const;
const BAD_REQUEST = { error: 'errors.validation' } as const;

export interface LayerProposalSettingsRouteDeps {
  readonly bus: MessageBus;
  readonly db: Database;
  readonly resolver: GroupResolver;
  readonly now?: () => Date;
}

interface LayerProposalSettingsResponse {
  readonly source: 'default' | 'saved';
  readonly settings: LayerProposalSettings;
}

/**
 * Field names — kept in lockstep with `LayerProposalSettingsInputSchema`.
 * Used for the `changedFields` diff in the bus payload; no values
 * cross the wire (plan §10).
 */
const SETTINGS_FIELD_NAMES = [
  'autoActivationEnabled',
  'thresholdCutoff',
  'cooldownHours',
  'requireThumbsUpDeltaPositive',
  'maxTokensDelta',
] as const;

function diffChangedFields(
  prev: LayerProposalSettings | null,
  next: {
    readonly autoActivationEnabled: boolean;
    readonly thresholdCutoff: number;
    readonly cooldownHours: number;
    readonly requireThumbsUpDeltaPositive: boolean;
    readonly maxTokensDelta: number | null;
  },
): readonly string[] {
  if (prev === null) {
    // First save — flag every field so subscribers can react.
    return SETTINGS_FIELD_NAMES.slice();
  }
  const out: string[] = [];
  if (prev.autoActivationEnabled !== next.autoActivationEnabled) {
    out.push('autoActivationEnabled');
  }
  if (prev.thresholdCutoff !== next.thresholdCutoff) {
    out.push('thresholdCutoff');
  }
  if (prev.cooldownHours !== next.cooldownHours) {
    out.push('cooldownHours');
  }
  if (prev.requireThumbsUpDeltaPositive !== next.requireThumbsUpDeltaPositive) {
    out.push('requireThumbsUpDeltaPositive');
  }
  if (prev.maxTokensDelta !== next.maxTokensDelta) {
    out.push('maxTokensDelta');
  }
  return out;
}

export function registerLayerProposalSettingsRoutes(
  app: Hono<{ Variables: HonoVariables }>,
  deps: LayerProposalSettingsRouteDeps,
): void {
  const requireLayer = createRequireLayer();
  const clock = deps.now ?? ((): Date => new Date());
  const settingsRepo = new LayerProposalSettingsRepo(deps.db);

  function computeIsSiteAdmin(userId: string): boolean {
    const adminGroupId = getMeta(deps.db, ADMIN_GROUP_ID_KEY);
    if (adminGroupId === null || adminGroupId === '') return false;
    return deps.resolver.isUserInGroup(userId, adminGroupId);
  }

  // ---------- GET /l/:slug/settings/proposals -----------------------------

  app.get('/l/:slug/settings/proposals', requireLayer, (c) => {
    const layer = c.get('layer');
    if (layer === undefined) return c.json(NOT_VISIBLE, 404);
    const row = settingsRepo.find(layer.id);
    const response: LayerProposalSettingsResponse =
      row === null
        ? { source: 'default', settings: settingsRepo.getOrDefault(layer.id) }
        : { source: 'saved', settings: row };
    console.log('[layer-proposal-settings.get]', {
      event: 'layer-proposal-settings.get',
      layerId: layer.id,
      source: response.source,
    });
    return c.json(response);
  });

  // ---------- PUT /l/:slug/settings/proposals -----------------------------

  app.put('/l/:slug/settings/proposals', requireLayer, async (c) => {
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
    const parsed = LayerProposalSettingsInputSchema.safeParse(raw);
    if (!parsed.success) {
      console.log('[layer-proposal-settings.put.bad-request]', {
        event: 'layer-proposal-settings.put.bad-request',
        layerId: layer.id,
        updatedBy: user.id,
        issues: parsed.error.issues.length,
      });
      return c.json(BAD_REQUEST, 400);
    }
    const prev = settingsRepo.find(layer.id);
    const nowIso = clock().toISOString();
    let settings: LayerProposalSettings;
    try {
      settings = settingsRepo.upsert({
        layerId: layer.id,
        autoActivationEnabled: parsed.data.autoActivationEnabled,
        thresholdCutoff: parsed.data.thresholdCutoff,
        cooldownHours: parsed.data.cooldownHours,
        requireThumbsUpDeltaPositive: parsed.data.requireThumbsUpDeltaPositive,
        maxTokensDelta: parsed.data.maxTokensDelta,
        updatedBy: user.id,
        now: nowIso,
      });
    } catch (err) {
      // The repo's CHECK constraints can only trip if zod missed
      // something — defensive belt + braces; surfaced as 400.
      console.error('[layer-proposal-settings.put.failed]', {
        event: 'layer-proposal-settings.put.failed',
        layerId: layer.id,
        updatedBy: user.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json(BAD_REQUEST, 400);
    }
    const changedFields = diffChangedFields(prev, parsed.data);
    const payload: LayerProposalSettingsUpdatedPayload = {
      layerId: layer.id,
      updatedBy: user.id,
      changedFields,
    };
    void deps.bus.publish({
      type: LAYER_PROPOSAL_SETTINGS_UPDATED_EVENT_TYPE,
      payload,
    });
    console.log('[layer-proposal-settings.put]', {
      event: 'layer-proposal-settings.put',
      layerId: layer.id,
      updatedBy: user.id,
      changedFieldCount: changedFields.length,
    });
    const response: LayerProposalSettingsResponse = { source: 'saved', settings };
    return c.json(response);
  });
}
