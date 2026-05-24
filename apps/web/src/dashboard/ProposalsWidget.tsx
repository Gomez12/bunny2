/**
 * Phase 7.6 — "Improvement proposals" dashboard widget.
 *
 * Mirrors `RecentChatsWidget` (phase 6.6): shows the latest 5 `new`
 * proposals for the layer with a click-through to the per-proposal
 * detail page. Loading / empty / error branches; `aria-live` on the
 * async state.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { errorKeyOf } from '../lib/errors';
import { fetchLayerProposals, type ProposalSummary } from '../lib/api';
import { registerWidget, type WidgetProps } from './widget-registry';

const WIDGET_LIMIT = 5;

type WidgetState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly errorKey: string }
  | { readonly kind: 'ready'; readonly items: readonly ProposalSummary[] };

export function ProposalsWidget({ layerSlug }: WidgetProps): JSX.Element {
  const { t } = useTranslation();
  const [state, setState] = useState<WidgetState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchLayerProposals(layerSlug, { status: 'new', sort: 'newest', limit: WIDGET_LIMIT })
      .then((res) => {
        if (!cancelled) setState({ kind: 'ready', items: res.items });
      })
      .catch((err: unknown) => {
        if (!cancelled) setState({ kind: 'error', errorKey: errorKeyOf(err) });
      });
    return (): void => {
      cancelled = true;
    };
  }, [layerSlug]);

  const titleId = `proposals-widget-title-${layerSlug}`;
  const href = `/l/${layerSlug}/proposals`;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId}>{t('layer.dashboard.widgets.proposals.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        {state.kind === 'loading' ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('layer.dashboard.widgets.proposals.loading')}
          </div>
        ) : null}
        {state.kind === 'error' ? (
          <div role="alert" className="text-sm text-destructive">
            {t('layer.dashboard.widgets.proposals.errorLoadFailed')}
            <span className="sr-only">{` (${state.errorKey})`}</span>
          </div>
        ) : null}
        {state.kind === 'ready' && state.items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('layer.dashboard.widgets.proposals.emptyDescription')}
          </p>
        ) : null}
        {state.kind === 'ready' && state.items.length > 0 ? (
          <ul className="space-y-1 text-sm">
            {state.items.map((p) => (
              <li key={p.id}>
                <Link
                  to={`/l/${layerSlug}/proposals/${p.id}`}
                  className="hover:underline"
                  title={p.problemSummary}
                >
                  {p.problemSummary.slice(0, 80)}
                </Link>{' '}
                <span className="text-xs text-muted-foreground">
                  ({t(`proposals.kind.${p.artifactKind}`)})
                </span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3">
          <Button asChild size="sm" variant="ghost" type="button">
            <Link to={href}>{t('layer.dashboard.widgets.proposals.linkOpen')}</Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

registerWidget({
  kind: 'proposals',
  titleKey: 'layer.dashboard.widgets.proposals.title',
  renderer: ProposalsWidget,
  order: 700,
});
