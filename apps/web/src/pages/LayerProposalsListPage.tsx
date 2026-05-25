/**
 * Phase 7.6 — `/l/:layerSlug/proposals` list page.
 *
 * Mirrors the ASCII wireframe in plan §4.6:
 *   - Status filter strip (radio-group semantics).
 *   - Sort dropdown (newest / impact / threshold).
 *   - Data table (kind / problem / impact / threshold / status).
 *   - Loading + empty + error states.
 *
 * Open to any layer member; the mutation surface lives on the detail
 * page.
 */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Button } from '../components/ui/button';
import { trackEvent } from '../lib/analytics';
import { useCurrentLayer } from '../lib/use-current-layer';
import type { ProposalStatus, ProposalSummary } from '../lib/api';
import {
  PROPOSAL_SORT_OPTIONS,
  PROPOSAL_STATUS_FILTERS,
  formatImpactDelta,
  truncateProblem,
  useLayerProposalsList,
} from './layer-proposals-page-state';

export function LayerProposalsListPage(): JSX.Element {
  const { t } = useTranslation();
  const current = useCurrentLayer();
  const [statusFilter, setStatusFilter] = useState<ProposalStatus | 'all'>('all');
  const [sort, setSort] = useState<'newest' | 'impact' | 'threshold'>('newest');
  const layerSlug = current.status === 'ready' ? current.layer.slug : null;
  const state = useLayerProposalsList(layerSlug ?? '', {
    status: statusFilter,
    sort,
  });

  // Page-opened analytics (placeholder primitive per AGENTS.md +
  // plan §4.7). Fired once per slug change.
  useMemo(() => {
    if (layerSlug === null) return;
    trackEvent('proposals_page_opened', { layerSlug });
  }, [layerSlug]);

  if (current.status !== 'ready') {
    return (
      <div role="status" aria-live="polite" className="p-4 text-sm text-muted-foreground">
        {t('common.loading')}
      </div>
    );
  }

  const titleId = `proposals-list-title-${current.layer.slug}`;

  return (
    <Card aria-labelledby={titleId} role="region">
      <CardHeader>
        <CardTitle id={titleId}>{t('proposals.list.title')}</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="mb-4 flex flex-wrap items-center gap-4">
          <div
            role="radiogroup"
            aria-label={t('proposals.list.statusFilter')}
            className="flex flex-wrap gap-2"
          >
            {PROPOSAL_STATUS_FILTERS.map((s) => {
              const labelKey = s === 'all' ? 'proposals.list.filterAll' : `proposals.status.${s}`;
              const checked = statusFilter === s;
              return (
                <Button
                  key={s}
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  variant={checked ? 'default' : 'ghost'}
                  size="sm"
                  onClick={() => setStatusFilter(s as ProposalStatus | 'all')}
                >
                  {t(labelKey)}
                </Button>
              );
            })}
          </div>
          <label className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">{t('proposals.list.sortBy')}</span>
            <select
              className="rounded-md border bg-background px-2 py-1 text-sm"
              value={sort}
              onChange={(e) => setSort(e.target.value as typeof sort)}
            >
              {PROPOSAL_SORT_OPTIONS.map((s) => (
                <option key={s} value={s}>
                  {t(`proposals.list.sort${s.charAt(0).toUpperCase()}${s.slice(1)}`)}
                </option>
              ))}
            </select>
          </label>
        </div>
        {state.status === 'loading' ? (
          <div role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {t('proposals.list.loading')}
          </div>
        ) : null}
        {state.status === 'error' ? (
          <div role="alert" className="text-sm text-destructive">
            {t('proposals.list.errorLoadFailed')}
            <span className="sr-only">{` (${state.errorKey ?? ''})`}</span>
          </div>
        ) : null}
        {state.status === 'ready' && state.data !== null ? (
          state.data.items.length === 0 ? (
            <div className="flex flex-col items-start gap-2">
              <p className="text-sm font-medium">{t('proposals.list.emptyTitle')}</p>
              <p className="text-sm text-muted-foreground">
                {t('proposals.list.emptyDescription')}
              </p>
            </div>
          ) : (
            <ProposalsTable items={state.data.items} layerSlug={current.layer.slug} />
          )
        ) : null}
      </CardContent>
    </Card>
  );
}

function ProposalsTable({
  items,
  layerSlug,
}: {
  readonly items: readonly ProposalSummary[];
  readonly layerSlug: string;
}): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b text-left">
            <th scope="col" className="py-2 pr-4">
              {t('proposals.list.kindHeader')}
            </th>
            <th scope="col" className="py-2 pr-4">
              {t('proposals.list.problemHeader')}
            </th>
            <th scope="col" className="py-2 pr-4">
              {t('proposals.list.impactHeader')}
            </th>
            <th scope="col" className="py-2 pr-4">
              {t('proposals.list.thresholdHeader')}
            </th>
            <th scope="col" className="py-2 pr-4">
              {t('proposals.list.sourceHeader')}
            </th>
            <th scope="col" className="py-2 pr-4">
              {t('proposals.list.statusHeader')}
            </th>
          </tr>
        </thead>
        <tbody>
          {items.map((row) => (
            <tr key={row.id} className="border-b last:border-0">
              <td className="py-2 pr-4">{t(`proposals.kind.${row.artifactKind}`)}</td>
              <td className="py-2 pr-4">
                <Link
                  to={`/l/${layerSlug}/proposals/${row.id}`}
                  title={row.problemSummary}
                  className="hover:underline"
                  onClick={() =>
                    trackEvent('proposal_detail_opened', {
                      layerSlug,
                      proposalId: row.id,
                    })
                  }
                >
                  {truncateProblem(row.problemSummary)}
                </Link>
              </td>
              <td className="py-2 pr-4 tabular-nums">{formatImpactDelta(row.thumbsUpDelta)}</td>
              <td className="py-2 pr-4 tabular-nums">{row.threshold.toFixed(2)}</td>
              <td className="py-2 pr-4">
                <SourceChip row={row} />
              </td>
              <td className="py-2 pr-4">
                <span className="rounded-full border px-2 py-0.5 text-xs uppercase">
                  {t(`proposals.status.${row.status}`)}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Phase 8.4 — Source chip: `auto` when the proposal was activated by
 * the `proposals.auto-activate` job (audit `autoActivatedBy === 'system'`),
 * `manual` when an admin approved it (audit `approvedBy !== null`),
 * and an em-dash for everything else (new / rejected / superseded
 * proposals that never reached an activated state). Visible text
 * (not icon-only) per plan §9 accessibility note.
 */
function SourceChip({ row }: { readonly row: ProposalSummary }): JSX.Element {
  const { t } = useTranslation();
  if (row.autoActivatedBy === 'system') {
    const label = t('proposals.source.auto');
    return (
      <span
        title={label}
        aria-label={label}
        className="rounded-full border px-2 py-0.5 text-xs uppercase"
      >
        {label}
      </span>
    );
  }
  if (row.status === 'activated') {
    const label = t('proposals.source.manual');
    return (
      <span
        title={label}
        aria-label={label}
        className="rounded-full border px-2 py-0.5 text-xs uppercase"
      >
        {label}
      </span>
    );
  }
  return <span aria-hidden="true">—</span>;
}
