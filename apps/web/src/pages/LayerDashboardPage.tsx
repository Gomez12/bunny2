import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { LayerTypeBadge } from '../components/LayerTypeBadge';
import { useCurrentLayer } from '../lib/use-current-layer';

/**
 * Empty per-layer dashboard.
 *
 * Phase 3.5 ships the route and the empty-state copy only — real
 * widgets land in phase 4+. The `Configure widgets` link routes to
 * `LayerSettingsPage` with `?tab=attachments` so the Attachments tab
 * is selected on arrival. The link is disabled (rendered as a plain
 * span) when the caller doesn't have edit rights, but its label
 * remains visible for discoverability.
 */
export function LayerDashboardPage(): JSX.Element | null {
  const { t } = useTranslation();
  const current = useCurrentLayer();

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const { layer, canEdit } = current;
  const settingsHref = `/l/${layer.slug}/settings?tab=attachments`;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
          <div className="space-y-1">
            <CardTitle>{t('layer.dashboard.title', { name: layer.name })}</CardTitle>
            <div className="flex items-center gap-2">
              <LayerTypeBadge type={layer.type} />
              {layer.description !== null && layer.description.length > 0 ? (
                <p className="text-sm text-muted-foreground">{layer.description}</p>
              ) : null}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {/* TODO(phase-4+): replace this empty grid with the real
              widget surface; phase 3.5 ships the contract only. */}
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-10 text-center">
            <h2 className="text-lg font-medium">{t('layer.dashboard.empty.title')}</h2>
            <p className="mt-2 max-w-md text-sm text-muted-foreground">
              {t('layer.dashboard.empty.description')}
            </p>
            <div className="mt-4">
              {canEdit ? (
                <Link
                  to={settingsHref}
                  className="inline-flex items-center rounded-md border bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t('layer.dashboard.configureWidgets')}
                </Link>
              ) : (
                <span
                  aria-disabled="true"
                  className="inline-flex cursor-not-allowed items-center rounded-md border bg-muted px-3 py-2 text-sm font-medium text-muted-foreground"
                >
                  {t('layer.dashboard.configureWidgets')}
                </span>
              )}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
