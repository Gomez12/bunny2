import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { LayerTypeBadge } from '../components/LayerTypeBadge';
import { useCurrentLayer } from '../lib/use-current-layer';
import { listDashboardWidgets } from '../dashboard/widgets';

/**
 * Per-layer dashboard.
 *
 * Phase 3.5 shipped the route + empty-state copy only. Phase 4a.4
 * introduces a minimal client-side widget registry
 * (`apps/web/src/dashboard/widget-registry.ts`) and starts rendering
 * every registered widget unconditionally — `layer_dashboard_widgets`
 * persistence is a later concern. Subsequent per-kind sub-phases
 * (4b.4 / 4c.4 / 4d.4) add their widget by importing it from the
 * `dashboard/widgets` barrel and calling `registerWidget`.
 *
 * The "no widgets yet" empty state is preserved as the fallback when
 * the registry is empty (e.g. in tests that reset the registry). The
 * "Configure widgets" link to `LayerSettingsPage?tab=attachments` still
 * sits at the top of the page so the configure surface stays
 * discoverable.
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
  const widgets = listDashboardWidgets();

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
          <div>
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
        </CardHeader>
      </Card>

      {widgets.length === 0 ? (
        <Card>
          <CardContent>
            <div className="flex flex-col items-center justify-center rounded-md border border-dashed py-10 text-center">
              <h2 className="text-lg font-medium">{t('layer.dashboard.empty.title')}</h2>
              <p className="mt-2 max-w-md text-sm text-muted-foreground">
                {t('layer.dashboard.empty.description')}
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {widgets.map((w) => {
            const Renderer = w.renderer;
            return <Renderer key={w.kind} layerSlug={layer.slug} />;
          })}
        </div>
      )}
    </div>
  );
}
