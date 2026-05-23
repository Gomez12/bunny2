import { z } from 'zod';

/**
 * Cross-package zod schemas for the layer domain (phase 3.1).
 *
 * Server-internal row types live in `apps/server/src/repos/layer-*.ts`;
 * these schemas describe the safe shape that crosses the HTTP boundary
 * and is shared with the web client. Timestamps are ISO-8601 strings —
 * same convention as `packages/shared/src/auth.ts`.
 *
 * The per-type owner CHECK in `0003_layers.sql` is mirrored here via a
 * `superRefine` so callers get a typed error before hitting SQLite.
 */

export const LayerTypeSchema = z.enum(['personal', 'project', 'group', 'everyone']);
export type LayerType = z.infer<typeof LayerTypeSchema>;

export const LayerVisibilityDirectionSchema = z.enum(['top_down', 'bottom_up', 'both']);
export type LayerVisibilityDirection = z.infer<typeof LayerVisibilityDirectionSchema>;

export const LayerAttachmentKindSchema = z.enum(['agent', 'skill', 'mcp_server']);
export type LayerAttachmentKind = z.infer<typeof LayerAttachmentKindSchema>;

export const LayerSchema = z
  .object({
    id: z.string().uuid(),
    type: LayerTypeSchema,
    slug: z.string().min(1),
    name: z.string().min(1),
    description: z.string().nullable().optional(),
    ownerUserId: z.string().uuid().nullable().optional(),
    ownerGroupId: z.string().uuid().nullable().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
    deletedAt: z.string().nullable(),
    version: z.number().int().positive(),
  })
  .superRefine((v, ctx) => {
    const userOwner = v.ownerUserId ?? null;
    const groupOwner = v.ownerGroupId ?? null;
    if (v.type === 'personal') {
      if (userOwner === null || groupOwner !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'personal layer requires ownerUserId and no ownerGroupId',
        });
      }
    } else if (v.type === 'group') {
      if (groupOwner === null || userOwner !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'group layer requires ownerGroupId and no ownerUserId',
        });
      }
    } else if (userOwner !== null || groupOwner !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${v.type} layer must not have ownerUserId or ownerGroupId`,
      });
    }
  });
export type Layer = z.infer<typeof LayerSchema>;

export const LayerVisibilityEdgeSchema = z
  .object({
    parentLayerId: z.string().uuid(),
    childLayerId: z.string().uuid(),
    direction: LayerVisibilityDirectionSchema,
    createdAt: z.string(),
  })
  .refine((v) => v.parentLayerId !== v.childLayerId, {
    message: 'parentLayerId and childLayerId must differ',
  });
export type LayerVisibilityEdge = z.infer<typeof LayerVisibilityEdgeSchema>;

export const LayerUserMemberSchema = z.object({
  layerId: z.string().uuid(),
  userId: z.string().uuid(),
  role: z.string().min(1).default('member'),
  createdAt: z.string(),
});
export type LayerUserMember = z.infer<typeof LayerUserMemberSchema>;

export const LayerGroupMemberSchema = z.object({
  layerId: z.string().uuid(),
  groupId: z.string().uuid(),
  role: z.string().min(1).default('member'),
  createdAt: z.string(),
});
export type LayerGroupMember = z.infer<typeof LayerGroupMemberSchema>;

export const LayerLocaleSchema = z.object({
  layerId: z.string().uuid(),
  locale: z.string().min(1),
  isDefault: z.boolean(),
  createdAt: z.string(),
});
export type LayerLocale = z.infer<typeof LayerLocaleSchema>;

export const LayerAttachmentSchema = z.object({
  id: z.string().uuid(),
  layerId: z.string().uuid(),
  kind: LayerAttachmentKindSchema,
  refId: z.string().min(1),
  config: z.record(z.unknown()),
  createdAt: z.string(),
});
export type LayerAttachment = z.infer<typeof LayerAttachmentSchema>;

export const LayerDashboardWidgetSchema = z.object({
  id: z.string().uuid(),
  layerId: z.string().uuid(),
  widgetKind: z.string().min(1),
  position: z.number().int().nonnegative(),
  layout: z.record(z.unknown()),
  createdAt: z.string(),
});
export type LayerDashboardWidget = z.infer<typeof LayerDashboardWidgetSchema>;

// ---------- HTTP request shapes (phase 3.4) -------------------------------

/**
 * `POST /layers`. Only `project` layers are creatable through the HTTP
 * surface in v1 — the router rejects any other `type` with
 * `errors.layer.typeNotCreatable`.
 */
export const CreateLayerRequestSchema = z.object({
  type: LayerTypeSchema,
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, digits, and dashes'),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).optional(),
});
export type CreateLayerRequest = z.infer<typeof CreateLayerRequestSchema>;

/** `PATCH /layers/:slug` — partial update of human-readable fields. */
export const UpdateLayerRequestSchema = z
  .object({
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(2000).nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, {
    message: 'at least one of name / description must be provided',
  });
export type UpdateLayerRequest = z.infer<typeof UpdateLayerRequestSchema>;

/**
 * `POST /layers/:slug/members` — XOR over `userId` and `groupId`, mirroring
 * `AddGroupMemberRequestSchema` from `auth.ts`. `role` defaults to
 * `'member'`; in v1 only `'member'` and `'owner'` are accepted.
 */
export const AddLayerMemberRequestSchema = z
  .object({
    userId: z.string().uuid().optional(),
    groupId: z.string().uuid().optional(),
    role: z.enum(['member', 'owner']).default('member'),
  })
  .refine((v) => (v.userId === undefined) !== (v.groupId === undefined), {
    message: 'exactly one of userId / groupId must be provided',
  });
export type AddLayerMemberRequest = z.infer<typeof AddLayerMemberRequestSchema>;

/** `POST /layers/:slug/visibility` — v1 only accepts `bottom_up`. */
export const AddLayerVisibilityRequestSchema = z.object({
  parentSlug: z.string().min(1),
  direction: LayerVisibilityDirectionSchema,
});
export type AddLayerVisibilityRequest = z.infer<typeof AddLayerVisibilityRequestSchema>;

/** `POST /layers/:slug/locales` — replaces the entire per-layer locale set. */
export const SetLayerLocalesRequestSchema = z.object({
  locales: z.array(z.string().min(1)).max(64),
  defaultLocale: z.string().min(1).optional(),
});
export type SetLayerLocalesRequest = z.infer<typeof SetLayerLocalesRequestSchema>;

/**
 * `POST /layers/:slug/attachments`. `config` is intentionally typed as
 * `z.unknown()` so the route handler — not the schema — owns the
 * "must be a JSON object" rule. The route rejects arrays / scalars /
 * `null` with `errors.layer.attachmentConfigInvalid`, resolving the
 * 3.1 open question about silently-coerced configs.
 */
export const RegisterLayerAttachmentRequestSchema = z.object({
  kind: LayerAttachmentKindSchema,
  refId: z.string().min(1).max(256),
  config: z.unknown().optional(),
});
export type RegisterLayerAttachmentRequest = z.infer<typeof RegisterLayerAttachmentRequestSchema>;
