/**
 * Token estimation. Estimates only, never exact counts (documented
 * limitation): the classic ~4 characters per token heuristic, deterministic
 * and model-independent by design.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

/** Rounds to the nearest 10 for the "~N" display form. */
export function estimateTokensApprox(chars: number): number {
  return Math.max(10, Math.round(estimateTokens(chars) / 10) * 10);
}
