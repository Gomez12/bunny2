import { describe, expect, it } from 'bun:test';
import {
  LayerAttachmentSchema,
  LayerSchema,
  LayerVisibilityEdgeSchema,
  LayerLocaleSchema,
  LayerDashboardWidgetSchema,
  LayerUserMemberSchema,
} from '@bunny2/shared';

const baseLayer = {
  id: crypto.randomUUID(),
  type: 'project' as const,
  slug: 'p1',
  name: 'P1',
  description: null,
  ownerUserId: null,
  ownerGroupId: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  deletedAt: null,
  version: 1,
};

describe('@bunny2/shared layer schemas', () => {
  it('parses a valid project Layer with no owners', () => {
    expect(LayerSchema.parse(baseLayer)).toMatchObject({ type: 'project' });
  });

  it('parses a valid personal Layer with ownerUserId', () => {
    const parsed = LayerSchema.parse({
      ...baseLayer,
      type: 'personal',
      ownerUserId: crypto.randomUUID(),
    });
    expect(parsed.type).toBe('personal');
  });

  it('rejects a personal Layer without ownerUserId', () => {
    expect(() => LayerSchema.parse({ ...baseLayer, type: 'personal' })).toThrow();
  });

  it('rejects a group Layer without ownerGroupId', () => {
    expect(() => LayerSchema.parse({ ...baseLayer, type: 'group' })).toThrow();
  });

  it('rejects a project Layer that carries an ownerUserId', () => {
    expect(() =>
      LayerSchema.parse({ ...baseLayer, type: 'project', ownerUserId: crypto.randomUUID() }),
    ).toThrow();
  });

  it('rejects an unknown layer type', () => {
    expect(() => LayerSchema.parse({ ...baseLayer, type: 'unknown' })).toThrow();
  });

  it('LayerVisibilityEdge rejects an invalid direction', () => {
    expect(() =>
      LayerVisibilityEdgeSchema.parse({
        parentLayerId: crypto.randomUUID(),
        childLayerId: crypto.randomUUID(),
        direction: 'sideways',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('LayerVisibilityEdge rejects parent == child', () => {
    const id = crypto.randomUUID();
    expect(() =>
      LayerVisibilityEdgeSchema.parse({
        parentLayerId: id,
        childLayerId: id,
        direction: 'bottom_up',
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('LayerAttachment rejects an invalid kind', () => {
    expect(() =>
      LayerAttachmentSchema.parse({
        id: crypto.randomUUID(),
        layerId: crypto.randomUUID(),
        kind: 'plugin',
        refId: 'r1',
        config: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('LayerAttachment parses a valid attachment with a typed config', () => {
    const parsed = LayerAttachmentSchema.parse({
      id: crypto.randomUUID(),
      layerId: crypto.randomUUID(),
      kind: 'mcp_server',
      refId: 'r1',
      config: { url: 'https://example.test' },
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.config).toEqual({ url: 'https://example.test' });
  });

  it("LayerUserMember defaults role to 'member' when omitted", () => {
    const parsed = LayerUserMemberSchema.parse({
      layerId: crypto.randomUUID(),
      userId: crypto.randomUUID(),
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.role).toBe('member');
  });

  it('LayerLocale parses boolean isDefault', () => {
    const parsed = LayerLocaleSchema.parse({
      layerId: crypto.randomUUID(),
      locale: 'en',
      isDefault: true,
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    expect(parsed.isDefault).toBe(true);
  });

  it('LayerDashboardWidget rejects negative position', () => {
    expect(() =>
      LayerDashboardWidgetSchema.parse({
        id: crypto.randomUUID(),
        layerId: crypto.randomUUID(),
        widgetKind: 'notes',
        position: -1,
        layout: {},
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow();
  });
});
