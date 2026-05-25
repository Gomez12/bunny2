/**
 * Phase 1 — UI exposure gaps: per-entity-kind helpers for the soft-
 * delete restore affordance.
 *
 * Three concerns are factored out of the five detail pages and into
 * pure functions so the per-kind work is consistent and the tests
 * can exercise the branching without a DOM runtime:
 *
 *  1. `isSoftDeleted(meta)` — single decision point used by both the
 *     list-row "Deleted" badge and the detail-page restore banner.
 *  2. `i18nKeysForKind(kind)` — closed map from `RestorableEntityKind`
 *     to the per-kind i18n key namespace. Each kind gets its own
 *     `entity.<kind>.restore.*` block in `en.json` / `nl.json` per
 *     the plan §8 "parallel per-entity namespaces" rule.
 *  3. `restoreTelemetryName(kind)` — stable dotted-name string used
 *     for the `[entity.<kind>.restore]` console placeholder. The web
 *     bundle has no real telemetry primitive yet (the audit confirms
 *     this); we ship a placeholder console.log next to the analytics
 *     call so the metric name appears in dev logs and is grep-able
 *     when the primitive lands.
 */

import type { EntityMeta } from './api-types';
import type { RestorableEntityKind } from './api';

export function isSoftDeleted(meta: Pick<EntityMeta, 'deletedAt'>): boolean {
  return meta.deletedAt !== null;
}

export interface RestoreI18nKeys {
  readonly deletedBadge: string;
  readonly bannerTitle: string;
  readonly bannerBody: string;
  readonly restoreCta: string;
  readonly confirmTitle: string;
  readonly confirmBody: string;
  readonly cancel: string;
  readonly restored: string;
  readonly toggleShowDeleted: string;
  readonly toggleHideDeleted: string;
}

/**
 * Closed per-kind namespace map. Adding a sixth entity kind triggers
 * a TS compile error here — intentional; the plan §8 rule is "each
 * kind keeps its own namespace for clean removal later".
 */
export function i18nKeysForKind(kind: RestorableEntityKind): RestoreI18nKeys {
  const ns = namespaceForKind(kind);
  return {
    deletedBadge: `entity.${ns}.restore.deletedBadge`,
    bannerTitle: `entity.${ns}.restore.bannerTitle`,
    bannerBody: `entity.${ns}.restore.bannerBody`,
    restoreCta: `entity.${ns}.restore.cta`,
    confirmTitle: `entity.${ns}.restore.confirmTitle`,
    confirmBody: `entity.${ns}.restore.confirmBody`,
    cancel: `entity.${ns}.restore.cancel`,
    restored: `entity.${ns}.restore.restored`,
    toggleShowDeleted: `entity.${ns}.restore.toggleShowDeleted`,
    toggleHideDeleted: `entity.${ns}.restore.toggleHideDeleted`,
  };
}

/**
 * The i18n key namespaces use the plural / friendly web segment
 * (`companies`, `contacts`, `calendar`, `todos`, `whiteboards`) per
 * the existing locale structure, while the API kind uses the singular
 * server-side `RestorableEntityKind` (`company`, `contact`,
 * `calendar_event`, `todo`, `whiteboard`). Keep the mapping in one
 * place so a rename of either side stays grep-able.
 */
function namespaceForKind(kind: RestorableEntityKind): string {
  if (kind === 'company') return 'companies';
  if (kind === 'contact') return 'contacts';
  if (kind === 'calendar_event') return 'calendar';
  if (kind === 'todo') return 'todos';
  return 'whiteboards';
}

/**
 * Stable telemetry event name surfaced as a console placeholder. The
 * web bundle has no real telemetry sink today (see
 * `docs/dev/follow-ups/web-analytics-primitive.md` closure for the
 * analytics equivalent). When the telemetry primitive lands the
 * placeholder swaps for a real emitter without changing the name.
 */
export function restoreTelemetryName(kind: RestorableEntityKind): string {
  return `entity.${kind}.restore`;
}
