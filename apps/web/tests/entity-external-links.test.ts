/**
 * Phase 3 (ui-exposure-gaps) — pure-logic smoke for the shared
 * external-link block consumed by the contact / calendar / todo /
 * whiteboard detail pages.
 *
 * The component itself is exercised by the manual smoke flow (the repo
 * has no DOM runtime yet — see `docs/dev/follow-ups/web-component-tests.md`);
 * this file pins the per-kind branching that drives:
 *
 *  - i18n key namespaces (one per kind, parallel — plan §8).
 *  - Telemetry placeholder names (`entity.<kind>.external-link.<verb>`).
 *  - Sync-state badge keys (per kind).
 *
 * One smoke `describe` block per kind so a per-kind regression
 * (e.g. accidentally pointing whiteboards at the calendar namespace)
 * fails the matching block, not a mixed-fixture block.
 */
import { describe, expect, it } from 'bun:test';
import {
  externalLinkI18nKeysForKind,
  externalLinkTelemetryName,
  linkSyncStateBadgeKey,
  type ExternalLinkEntityKind,
} from '../src/lib/entity-external-links';

const KINDS: readonly ExternalLinkEntityKind[] = [
  'contact',
  'calendar_event',
  'todo',
  'whiteboard',
];

function namespaceForKind(kind: ExternalLinkEntityKind): string {
  if (kind === 'contact') return 'contacts';
  if (kind === 'calendar_event') return 'calendar';
  if (kind === 'todo') return 'todos';
  return 'whiteboards';
}

describe('externalLinkI18nKeysForKind', () => {
  for (const kind of KINDS) {
    const ns = namespaceForKind(kind);
    describe(`kind=${kind}`, () => {
      it('returns the per-kind externalLinks namespace for the user-facing keys', () => {
        const keys = externalLinkI18nKeysForKind(kind);
        expect(keys.title).toBe(`entity.${ns}.externalLinks.title`);
        expect(keys.empty).toBe(`entity.${ns}.externalLinks.empty`);
        expect(keys.connectorLabel).toBe(`entity.${ns}.externalLinks.connectorLabel`);
        expect(keys.addCta).toBe(`entity.${ns}.externalLinks.addCta`);
        expect(keys.remove).toBe(`entity.${ns}.externalLinks.remove`);
        expect(keys.refresh).toBe(`entity.${ns}.externalLinks.refresh`);
        expect(keys.added).toBe(`entity.${ns}.externalLinks.added`);
        expect(keys.removed).toBe(`entity.${ns}.externalLinks.removed`);
      });

      it('routes the inline validation messages through the errors.entity namespace', () => {
        const keys = externalLinkI18nKeysForKind(kind);
        expect(keys.connectorRequired).toBe(`errors.entity.${ns}.externalLinkConnectorRequired`);
        expect(keys.externalIdRequired).toBe(`errors.entity.${ns}.externalLinkExternalIdRequired`);
      });
    });
  }
});

describe('externalLinkTelemetryName', () => {
  for (const kind of KINDS) {
    it(`uses the stable dotted name for kind=${kind}/add`, () => {
      expect(externalLinkTelemetryName(kind, 'add')).toBe(`entity.${kind}.external-link.add`);
    });
    it(`uses the stable dotted name for kind=${kind}/remove`, () => {
      expect(externalLinkTelemetryName(kind, 'remove')).toBe(`entity.${kind}.external-link.remove`);
    });
  }
});

describe('linkSyncStateBadgeKey', () => {
  for (const kind of KINDS) {
    const ns = namespaceForKind(kind);
    it(`maps each sync state to the per-kind label for kind=${kind}`, () => {
      expect(linkSyncStateBadgeKey(kind, 'idle')).toBe(`entity.${ns}.externalLinks.syncIdle`);
      expect(linkSyncStateBadgeKey(kind, 'syncing')).toBe(`entity.${ns}.externalLinks.syncSyncing`);
      expect(linkSyncStateBadgeKey(kind, 'error')).toBe(`entity.${ns}.externalLinks.syncError`);
    });
  }
});
