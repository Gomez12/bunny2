/**
 * Phase 7.6 — pure-logic helpers backing `LayerProposalsListPage` /
 * `LayerProposalDetailPage`. Mirrors the shape of
 * `layer-chat-page-state.ts`: a tiny module of pure functions + a
 * narrow hook so the React component stays focused on rendering.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  fetchLayerProposalDetail,
  fetchLayerProposals,
  type ProposalDetailResponse,
  type ProposalListParams,
  type ProposalListResponse,
  type ProposalStatus,
} from '../lib/api';
import { errorKeyOf } from '../lib/errors';

export const PROPOSAL_STATUS_FILTERS: readonly (ProposalStatus | 'all')[] = [
  'all',
  'new',
  'approved',
  'rejected',
  'superseded',
  'activated',
];

export const PROPOSAL_SORT_OPTIONS: readonly ('newest' | 'impact' | 'threshold')[] = [
  'newest',
  'impact',
  'threshold',
];

export interface ListState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly data: ProposalListResponse | null;
  readonly errorKey: string | null;
}

export function useLayerProposalsList(
  layerSlug: string,
  filter: {
    readonly status: ProposalStatus | 'all';
    readonly sort: 'newest' | 'impact' | 'threshold';
  },
): ListState {
  const [state, setState] = useState<ListState>({
    status: 'loading',
    data: null,
    errorKey: null,
  });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null, errorKey: null });
    const params: ProposalListParams = {
      sort: filter.sort,
      ...(filter.status !== 'all' ? { status: filter.status } : {}),
    };
    fetchLayerProposals(layerSlug, params)
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'ready', data, errorKey: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', data: null, errorKey: errorKeyOf(err) });
      });
    return (): void => {
      cancelled = true;
    };
  }, [layerSlug, filter.status, filter.sort]);
  return state;
}

export interface DetailState {
  readonly status: 'loading' | 'ready' | 'error';
  readonly data: ProposalDetailResponse | null;
  readonly errorKey: string | null;
  readonly reload: () => void;
}

export function useLayerProposalDetail(layerSlug: string, proposalId: string): DetailState {
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<Omit<DetailState, 'reload'>>({
    status: 'loading',
    data: null,
    errorKey: null,
  });
  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading', data: null, errorKey: null });
    fetchLayerProposalDetail(layerSlug, proposalId)
      .then((data) => {
        if (cancelled) return;
        setState({ status: 'ready', data, errorKey: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ status: 'error', data: null, errorKey: errorKeyOf(err) });
      });
    return (): void => {
      cancelled = true;
    };
  }, [layerSlug, proposalId, version]);
  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { ...state, reload };
}

/**
 * Trim the problem summary to ~60 chars with an ellipsis for the
 * table cell. The full text stays in the `title` attribute so the
 * tooltip shows the whole sentence.
 */
export const PROBLEM_SUMMARY_MAX_LEN = 60;

export function truncateProblem(summary: string): string {
  if (summary.length <= PROBLEM_SUMMARY_MAX_LEN) return summary;
  return `${summary.slice(0, PROBLEM_SUMMARY_MAX_LEN - 1)}…`;
}

/**
 * Map a `ProposalSummary.thumbsUpDelta` (a fraction like 0.18) to a
 * displayable percentage string (`+18%`). Negative deltas keep their
 * minus sign; zero renders as `±0%`.
 */
export function formatImpactDelta(delta: number): string {
  if (delta === 0) return '±0%';
  const pct = Math.round(delta * 100);
  if (pct > 0) return `+${pct}%`;
  return `${pct}%`;
}
