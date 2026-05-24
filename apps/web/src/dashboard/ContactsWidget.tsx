import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { getContactStats, type ContactStatsResponse } from '../lib/api';
import { errorKeyOf } from '../lib/errors';
import { contactsWidgetView, type ContactsWidgetInput } from './contacts-widget-state';
import { registerWidget, type WidgetProps } from './widget-registry';

/**
 * Phase 4b.4 — Contacts dashboard widget.
 *
 * Second consumer of the §4a.4 `statsProvider` slot. Reads aggregate
 * stats from `GET /l/:slug/contact/_stats`. The endpoint lives behind
 * the generic entity router (singular `/contact` segment per the §4.0
 * router naming — see 4a.1 close-out follow-up); the widget's "View
 * contacts" CTA links to the friendlier plural-segment page that lands
 * in 4b.5. "Import vCard" links to the 4b.2 import page so a fresh
 * layer can populate contacts before the list page even exists.
 *
 * Loading / empty / error / ready branches are projected by the pure
 * reducer in `./contacts-widget-state.ts` so the matrix is testable
 * without a DOM runtime (see `apps/web/tests/contacts-widget.test.ts`).
 *
 * Accessibility:
 *  - The card uses `<section>` semantics via `role="region"` + a
 *    labelled heading hookup (`aria-labelledby`).
 *  - The loading branch sets `role="status" aria-live="polite"`.
 *  - The error branch sets `role="alert"`.
 *  - Every stat line uses `<dt>` / `<dd>` so screen readers announce
 *    the label/value pairing.
 *  - Buttons inherit the shared `<Button>` focus ring.
 */
export function ContactsWidget({ layerSlug }: WidgetProps): JSX.Element {
  const { t } = useTranslation();
  const [input, setInput] = useState<ContactsWidgetInput>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setInput({ status: 'loading' });
    getContactStats(layerSlug)
      .then((stats: ContactStatsResponse) => {
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

  const view = contactsWidgetView(input);
  // The 4b.5 web UI mounts `/l/:slug/contacts` (list + create). Until
  // that ships the link resolves through the App router's 404; the
  // widget never produces a dead link in the loaded-and-ready state
  // because that state implies at least one contact already exists in
  // the layer (which today is only reachable through the 4b.2 import).
  const viewAllHref = `/l/${layerSlug}/contacts`;
  // The 4b.2 import page already lives at `/l/:layerSlug/contacts/import`.
  const importHref = `/l/${layerSlug}/contacts/import`;
  const titleId = `contacts-widget-title-${layerSlug}`;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId}>{t('layer.dashboard.widgets.contacts.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {view.kind === 'loading' ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('layer.dashboard.widgets.contacts.loading')}
          </div>
        ) : null}
        {view.kind === 'error' ? (
          <div role="alert" className="text-sm text-destructive">
            {t('layer.dashboard.widgets.contacts.error')}
            <span className="sr-only">{` (${view.errorKey})`}</span>
          </div>
        ) : null}
        {view.kind === 'empty' ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">
              {t('layer.dashboard.widgets.contacts.empty')}
            </p>
            <Button asChild size="sm" type="button">
              <Link to={importHref}>{t('layer.dashboard.widgets.contacts.importCta')}</Link>
            </Button>
          </div>
        ) : null}
        {view.kind === 'ready' ? (
          <div className="space-y-3">
            <p
              className="text-3xl font-semibold leading-none"
              aria-label={t('layer.dashboard.widgets.contacts.statTotal')}
            >
              {view.stats.total}
            </p>
            <dl className="grid grid-cols-1 gap-1 text-sm">
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.contacts.statWithCompanyLink')}
                </dt>
                <dd className="font-medium">{view.stats.withCompanyLink}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.contacts.statMissingEmail')}
                </dt>
                <dd className="font-medium">{view.stats.missingEmail}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-muted-foreground">
                  {t('layer.dashboard.widgets.contacts.statRecentlyEnriched')}
                </dt>
                <dd className="font-medium">{view.stats.recentlyEnriched}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={viewAllHref}>{t('layer.dashboard.widgets.contacts.viewAllCta')}</Link>
              </Button>
              <Button asChild size="sm" variant="ghost" type="button">
                <Link to={importHref}>{t('layer.dashboard.widgets.contacts.importCta')}</Link>
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
// performs exactly one registry insertion per process. `order: 200`
// puts the Contacts widget right after Companies (`order: 100`); the
// follow-ups Calendar / Todos widgets will pick 300 / 400 in their
// respective sub-phases.
registerWidget({
  kind: 'contacts',
  titleKey: 'layer.dashboard.widgets.contacts.title',
  renderer: ContactsWidget,
  order: 200,
});
