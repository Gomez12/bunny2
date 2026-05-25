import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';

/**
 * Phase 1 — UI exposure gaps: visible "Deleted" badge surfaced on
 * list rows and detail pages when the entity is soft-deleted.
 *
 * The label key is per-entity-kind (`entity.<kind>.restore.deletedBadge`)
 * per the plan's "parallel per-entity namespace" rule — passed in by
 * the caller so the badge has no hardcoded kind. Server soft-delete
 * marks `deleted_at`; the UI surfaces the badge so the operator sees
 * at a glance which rows are recoverable from the restore banner on
 * the detail page.
 *
 * Visual: outline pill in the destructive colour. The badge is purely
 * informational — it has no on-click affordance; the actual restore
 * happens from the detail page banner (see `<RestoreBanner>`).
 */
export interface DeletedBadgeProps {
  /**
   * Translation key for the badge label. The caller passes a per-kind
   * key (e.g. `entity.companies.restore.deletedBadge`) so the badge
   * itself stays kind-agnostic.
   */
  readonly labelKey: string;
  readonly className?: string;
}

export function DeletedBadge(props: DeletedBadgeProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <span
      data-deleted-badge
      className={cn(
        'inline-flex items-center rounded-full border border-destructive bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive',
        props.className,
      )}
    >
      {t(props.labelKey)}
    </span>
  );
}
