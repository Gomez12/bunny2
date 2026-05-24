/**
 * Phase 7.6 — pure-logic tests for `LayerProposalsListPage`'s state
 * helpers. The widget itself wires `useState`/`useEffect` around
 * these, so we exercise the helpers directly.
 */
import { describe, expect, it } from 'bun:test';
import {
  PROBLEM_SUMMARY_MAX_LEN,
  PROPOSAL_SORT_OPTIONS,
  PROPOSAL_STATUS_FILTERS,
  formatImpactDelta,
  truncateProblem,
} from '../src/pages/layer-proposals-page-state';

describe('truncateProblem', () => {
  it('returns the input untouched when it fits the cap', () => {
    expect(truncateProblem('hello')).toBe('hello');
  });

  it('truncates with an ellipsis when over the cap', () => {
    const long = 'x'.repeat(PROBLEM_SUMMARY_MAX_LEN + 10);
    const trimmed = truncateProblem(long);
    expect(trimmed.length).toBe(PROBLEM_SUMMARY_MAX_LEN);
    expect(trimmed.endsWith('…')).toBe(true);
  });
});

describe('formatImpactDelta', () => {
  it('formats positive deltas with a leading plus and percent sign', () => {
    expect(formatImpactDelta(0.18)).toBe('+18%');
    expect(formatImpactDelta(0.5)).toBe('+50%');
  });

  it('formats zero as the neutral marker', () => {
    expect(formatImpactDelta(0)).toBe('±0%');
  });

  it('formats negative deltas with the minus sign retained', () => {
    expect(formatImpactDelta(-0.07)).toBe('-7%');
  });
});

describe('filter / sort enums', () => {
  it('keeps the status filter set stable for the radio-group order', () => {
    expect(PROPOSAL_STATUS_FILTERS).toEqual([
      'all',
      'new',
      'approved',
      'rejected',
      'superseded',
      'activated',
    ]);
  });

  it('exposes the three documented sort options', () => {
    expect(PROPOSAL_SORT_OPTIONS).toEqual(['newest', 'impact', 'threshold']);
  });
});
