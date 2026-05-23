import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { getCompanyStats, type CompanyStatsResponse } from '../lib/api';
import { errorKeyOf } from '../lib/errors';
import { companiesWidgetView, type CompaniesWidgetInput } from './companies-widget-state';
import { registerWidget, type WidgetProps } from './widget-registry';

/**
 * Phase 4a.4 — Companies dashboard widget.
 *
 * Reads aggregate stats from `GET /l/:slug/company/_stats`. The endpoint
 * lives behind the entity router (singular `/company` segment per the
 * §4.0 router naming — see the 4a.1 close-out follow-up note); the
 * widget's "View companies" / "Create company" CTAs link to the
 * friendlier plural-segment page that lands in 4a.5. Until 4a.5 ships
 * those routes are placeholders pointing at the dashboard itself so the
 * widget never produces a dead link.
 *
 * Loading / empty / error / ready branches are projected by the pure
 * reducer in `./companies-widget-state.ts` so the matrix is testable
 * without a DOM runtime (see `apps/web/tests/companies-widget.test.ts`).
 *
 * Accessibility:
 *  - The card uses `<section>` with a labelled heading for assistive
 *    tech (semantic landmark + h2 hookup).
 *  - The loading branch sets `role="status" aria-live="polite"`.
 *  - The error branch sets `role="alert"`.
 *  - Every stat line uses `<dt>` / `<dd>` so screen readers announce the
 *    label/value pairing.
 *  - Buttons inherit the shared `<Button>` focus ring (visible focus).
 */
export function CompaniesWidget({ layerSlug }: WidgetProps): JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState<CompaniesWidgetInput>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setInput({ status: 'loading' });
    getCompanyStats(layerSlug)
      .then((stats: CompanyStatsResponse) => {
        if (cancelled) return;
        setInput({ status: 'ready', stats });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setInput({ status: 'error', errorKey: errorKeyOf(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [layerSlug]);

  const view = companiesWidgetView(input);
  // Placeholder hrefs — real routes ship in 4a.5.
  const viewAllHref = `/l/${layerSlug}/companies`;
  const createHref = `/l/${layerSlug}/companies?new=1`;
  const titleId = `companies-widget-title-${layerSlug}`;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId}>{t('layer.dashboard.widgets.companies.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {view.kind === 'loading' ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('layer.dashboard.widgets.companies.loading')}
          </div>
        ) : null}
        {view.kind === 'error' ? (
          <div role="alert" className="text-sm text-destructive">
            {t('layer.dashboard.widgets.companies.error')}
            <span className="sr-only">{` (${view.errorKey})`}</span>
          </div>
        ) : null}
        {view.kind === 'empty' ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {t('layer.dashboard.widgets.companies.empty')}
            </p>
            <Button asChild size="sm" type="button">
              <Link to={createHref}>{t('layer.dashboard.widgets.companies.createCta')}</Link>
            </Button>
          </div>
        ) : null}
        {view.kind === 'ready' ? (
          <div className="space-y-3">
            <p
              className="text-3xl font-semibold leading-none"
              aria-label={t('layer.dashboard.widgets.companies.statTotal')}
            >
              {view.stats.total}
            </p>
            <dl className="grid grid-cols-1 gap-1 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.companies.statWithKvk')}
                </dt>
                <dd className="font-medium">{view.stats.withKvk}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.companies.statMissingDescription')}
                </dt>
                <dd className="font-medium">{view.stats.missingDescription}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.companies.statRecentlyEnriched')}
                </dt>
                <dd className="font-medium">{view.stats.recentlyEnriched}</dd>
              </div>
            </dl>
            <div className="pt-1">
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={viewAllHref}>{t('layer.dashboard.widgets.companies.viewAllCta')}</Link>
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

// Side-effect registration on module evaluation. The dashboard imports
// the barrel `./widgets` once, which imports this file once, which
// performs exactly one registry insertion per process.
registerWidget({
  kind: 'companies',
  titleKey: 'layer.dashboard.widgets.companies.title',
  renderer: CompaniesWidget,
  order: 100,
});
