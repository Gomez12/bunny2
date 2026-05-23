/**
 * Phase 3.2 — layer-domain bus event contracts.
 *
 * The 3.4 HTTP routes will publish the same event types from their own
 * mutations, so the payload shapes are pinned here once. Keep them
 * minimal: subscribers cache-invalidate or re-seed on layer.* and only
 * need `layerId` / `slug` / `type` plus the optional `seeded` boolean
 * (mirrors the phase-2 admin-seed convention in `auth/seed.ts`).
 *
 * NOTE: when adding fields, prefer additive optional properties so the
 * 3.4 routes and any future subscriber stay forward-compatible without
 * a schema migration.
 */

import type { LayerType, LayerVisibilityDirection } from '@bunny2/shared';

export const LAYER_EVENT_TYPES = {
  Created: 'layer.created',
  Updated: 'layer.updated',
  Deleted: 'layer.deleted',
  VisibilityAdded: 'layer.visibility.added',
  VisibilityRemoved: 'layer.visibility.removed',
  MemberAdded: 'layer.member.added',
  MemberRemoved: 'layer.member.removed',
  LocaleSet: 'layer.locale.set',
  AttachmentRegistered: 'layer.attachment.registered',
  AttachmentRemoved: 'layer.attachment.removed',
} as const;

export type LayerEventType = (typeof LAYER_EVENT_TYPES)[keyof typeof LAYER_EVENT_TYPES];

/** Every `layer.*` event type, exported as a readonly array for subscribers. */
export const ALL_LAYER_EVENT_TYPES: readonly LayerEventType[] = Object.values(
  LAYER_EVENT_TYPES,
) as readonly LayerEventType[];

export interface LayerCreatedPayload {
  readonly layerId: string;
  readonly type: LayerType;
  readonly slug: string;
  readonly name: string;
  readonly ownerUserId?: string | null;
  readonly ownerGroupId?: string | null;
  readonly seeded?: true;
}

export interface LayerUpdatedPayload {
  readonly layerId: string;
  readonly slug: string;
}

export interface LayerDeletedPayload {
  readonly layerId: string;
  readonly slug: string;
  readonly type: LayerType;
  readonly ownerUserId?: string | null;
  readonly ownerGroupId?: string | null;
}

export interface LayerVisibilityAddedPayload {
  readonly parentLayerId: string;
  readonly childLayerId: string;
  readonly direction: LayerVisibilityDirection;
  readonly seeded?: true;
}

export interface LayerVisibilityRemovedPayload {
  readonly parentLayerId: string;
  readonly childLayerId: string;
}

// ---------- Phase 3.4 — payloads emitted from the HTTP routes ------------

export interface LayerMemberAddedPayload {
  readonly layerId: string;
  readonly kind: 'user' | 'group';
  readonly role: string;
  readonly userId?: string;
  readonly groupId?: string;
}

export interface LayerMemberRemovedPayload {
  readonly layerId: string;
  readonly kind: 'user' | 'group';
  readonly userId?: string;
  readonly groupId?: string;
}

export interface LayerLocaleSetPayload {
  readonly layerId: string;
  readonly locales: readonly string[];
  readonly defaultLocale: string | null;
}

export interface LayerAttachmentRegisteredPayload {
  readonly layerId: string;
  readonly attachmentId: string;
  readonly kind: 'agent' | 'skill' | 'mcp_server';
  readonly refId: string;
  /**
   * Stringified JSON config, truncated to ≤500 chars in the route
   * handler before publish. Full row stays in the DB; subscribers that
   * need the full config should read it from `layer_attachments` via
   * the repo, not the bus.
   */
  readonly configPreview: string;
}

export interface LayerAttachmentRemovedPayload {
  readonly layerId: string;
  readonly attachmentId: string;
  readonly kind: 'agent' | 'skill' | 'mcp_server';
  readonly refId: string;
}
