/**
 * Per-model pricing entry. Both rates are USD per **million** tokens, to
 * match how OpenAI / Anthropic publish their pricing pages and to keep the
 * numbers in the config file human-readable (e.g. `2.50` instead of
 * `0.0000025`).
 */
export interface ModelPricing {
  readonly inputPerMTokens: number;
  readonly outputPerMTokens: number;
}

export type PricingMap = Readonly<Record<string, ModelPricing>>;

/**
 * Computes USD cost for a single call.
 *
 * Returns `null` when the model is not in the pricing map — per phase-1
 * plan §11.4, "uncertain values" are stored as NULL in the DB rather than
 * faked with a zero. Callers can fill the pricing config later and rerun
 * a backfill if they need historical numbers.
 */
export function estimateCostUsd(
  model: string,
  tokensIn: number | null,
  tokensOut: number | null,
  pricing: PricingMap,
): number | null {
  const entry = pricing[model];
  if (!entry) return null;
  const inTok = tokensIn ?? 0;
  const outTok = tokensOut ?? 0;
  const inCost = (inTok / 1_000_000) * entry.inputPerMTokens;
  const outCost = (outTok / 1_000_000) * entry.outputPerMTokens;
  return inCost + outCost;
}
