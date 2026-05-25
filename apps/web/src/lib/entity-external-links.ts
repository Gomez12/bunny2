/**
 * Phase 3 (ui-exposure-gaps) — per-entity-kind helpers for the external-
 * link CRUD affordance on the four non-Company detail pages
 * (`contact`, `calendar_event`, `todo`, `whiteboard`).
 *
 * Three concerns are factored out of the detail pages and into pure
 * functions so the per-kind work is consistent and the tests exercise
 * the branching without a DOM runtime:
 *
 *   1. `externalLinkI18nKeysForKind(kind)` — closed map to the per-kind
 *      `entity.<ns>.externalLinks.*` namespace. Mirrors §8 of the plan:
 *      "each kind keeps its own namespace for clean removal later".
 *   2. `externalLinkTelemetryName(kind, verb)` — stable dotted-name
 *      string used for the `[entity.<kind>.external-link.<verb>]`
 *      console placeholder. The web bundle has no real telemetry sink
 *      today (see Phase 1's matching `restoreTelemetryName`); the
 *      placeholder lets the metric show up in dev logs and stay grep-
 *      able for when the real primitive lands.
 *   3. `linkSyncStateBadgeKey(kind, state)` — closed map to the per-
 *      kind sync-state label key. The Companies pattern uses a single
 *      `linkSyncStateBadgeKey` that hard-codes `entity.companies.*`;
 *      we generalise so each kind keeps its own copy of the same three
 *      labels (idle / syncing / error).
 *
 * Companies is intentionally NOT covered here — non-goal §2 of the
 * plan keeps the Companies external-link block on its KvK-specific
 * helpers + namespace until a follow-up extracts the shared component.
 */

import type { EntitySyncState } from './api-types';

/**
 * The four entity kinds Phase 3 adds external-link CRUD to. Companies
 * is excluded — see the file header.
 */
export type ExternalLinkEntityKind = 'contact' | 'calendar_event' | 'todo' | 'whiteboard';

export interface ExternalLinkI18nKeys {
  readonly title: string;
  readonly empty: string;
  readonly connectorLabel: string;
  readonly addCta: string;
  readonly connectorField: string;
  readonly externalIdField: string;
  readonly remove: string;
  readonly refresh: string;
  readonly added: string;
  readonly removed: string;
  readonly addFailed: string;
  readonly removeFailed: string;
  readonly syncIdle: string;
  readonly syncSyncing: string;
  readonly syncError: string;
  readonly connectorRequired: string;
  readonly externalIdRequired: string;
}

/**
 * Closed per-kind namespace map. Adding a fifth entity kind triggers a
 * TS compile error here — intentional; plan §8 rule is "each kind keeps
 * its own namespace for clean removal later".
 */
export function externalLinkI18nKeysForKind(kind: ExternalLinkEntityKind): ExternalLinkI18nKeys {
  const ns = namespaceForKind(kind);
  return {
    title: `entity.${ns}.externalLinks.title`,
    empty: `entity.${ns}.externalLinks.empty`,
    connectorLabel: `entity.${ns}.externalLinks.connectorLabel`,
    addCta: `entity.${ns}.externalLinks.addCta`,
    connectorField: `entity.${ns}.externalLinks.connectorField`,
    externalIdField: `entity.${ns}.externalLinks.externalIdField`,
    remove: `entity.${ns}.externalLinks.remove`,
    refresh: `entity.${ns}.externalLinks.refresh`,
    added: `entity.${ns}.externalLinks.added`,
    removed: `entity.${ns}.externalLinks.removed`,
    addFailed: `entity.${ns}.externalLinks.addFailed`,
    removeFailed: `entity.${ns}.externalLinks.removeFailed`,
    syncIdle: `entity.${ns}.externalLinks.syncIdle`,
    syncSyncing: `entity.${ns}.externalLinks.syncSyncing`,
    syncError: `entity.${ns}.externalLinks.syncError`,
    connectorRequired: `errors.entity.${ns}.externalLinkConnectorRequired`,
    externalIdRequired: `errors.entity.${ns}.externalLinkExternalIdRequired`,
  };
}

/**
 * The i18n key namespaces use the plural / friendly web segment
 * (`contacts`, `calendar`, `todos`, `whiteboards`) per the existing
 * locale structure, while the API kind uses the singular server-side
 * value (`contact`, `calendar_event`, `todo`, `whiteboard`). Keep the
 * mapping in one place so a rename of either side stays grep-able.
 */
function namespaceForKind(kind: ExternalLinkEntityKind): string {
  if (kind === 'contact') return 'contacts';
  if (kind === 'calendar_event') return 'calendar';
  if (kind === 'todo') return 'todos';
  return 'whiteboards';
}

export type ExternalLinkVerb = 'add' | 'remove';

/**
 * Stable telemetry event name surfaced as a console placeholder. The
 * web bundle has no real telemetry sink today (see Phase 1 helper).
 * When the telemetry primitive lands the placeholder swaps for a real
 * emitter without changing the name.
 */
export function externalLinkTelemetryName(
  kind: ExternalLinkEntityKind,
  verb: ExternalLinkVerb,
): string {
  return `entity.${kind}.external-link.${verb}`;
}

/**
 * Per-kind sync-state badge key. Mirrors
 * `linkSyncStateBadgeKey(state)` in `companies-page-state.ts` but
 * routes through the per-kind namespace so each kind owns its three
 * labels.
 */
export function linkSyncStateBadgeKey(
  kind: ExternalLinkEntityKind,
  state: EntitySyncState,
): string {
  const keys = externalLinkI18nKeysForKind(kind);
  if (state === 'syncing') return keys.syncSyncing;
  if (state === 'error') return keys.syncError;
  return keys.syncIdle;
}
