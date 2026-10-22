/**
 * Retrieval metrics used by the M2 evaluation harness, following the
 * conventions described in docs/eval/README.md (SWE-bench-style file
 * localization: Acc@k / Recall@k / MRR, plus seeded bootstrap CIs).
 *
 * Every function is pure and takes fixed inputs, so metrics.test.ts pins the
 * exact arithmetic. Ranking arrays MUST be pre-sorted best-first; ties are
 * broken by the caller (we use path order after scores, matching the
 * deterministic-retrieval ADR).
 */

/** One ranked candidate file the system produced for a task. */
export interface RankedFile {
  path: string;
  /** Better-ranked files sort first; same rank ⇒ same position. */
  score: number;
}

/** Aggregated means for one metric family, with a bootstrap CI on the mean. */
export interface MetricSummary {
  /** Number of tasks contributing to this summary. */
  n: number;
  mean: number;
  ciLow: number;
  ciHigh: number;
}

export interface RunMetrics {
  top1: MetricSummary;
  recall5: MetricSummary;
  recall10: MetricSummary;
  /** Every gold file appears within the top 10 (SWE-bench "all-gold Acc@10"). */
  allGoldAcc10: MetricSummary;
  mrr: MetricSummary;
}

const BINDING_COUNT = 1000;
const CI_ALPHA = 0.05;

// ---------------------------------------------------------------------------
// Per-task metrics
// ---------------------------------------------------------------------------

/** Rank (1-based) of the best-ranked gold file, or null when none are ranked. */
export function bestGoldRank(ranked: RankedFile[], gold: string[]): number | null {
  const goldSet = new Set(gold);
  for (let i = 0; i < ranked.length; i++) {
    if (goldSet.has(ranked[i]!.path)) return i + 1;
  }
  return null;
}

/** Fraction of gold files present in the top k of the ranking. */
export function recallAtK(ranked: RankedFile[], gold: string[], k: number): number {
  if (gold.length === 0) return 1; // vacuously perfect; filtered out upstream anyway
  const top = new Set(ranked.slice(0, k).map((r) => r.path));
  let hits = 0;
  for (const g of gold) if (top.has(g)) hits++;
  return hits / gold.length;
}

/** 1 when every gold file appears in the top k, else 0. */
export function allGoldAccAtK(ranked: RankedFile[], gold: string[], k: number): number {
  if (gold.length === 0) return 1;
  return recallAtK(ranked, gold, k) === 1 ? 1 : 0;
}

/** 1 when the top-ranked file is a gold file. */
export function top1Hit(ranked: RankedFile[], gold: string[]): number {
  return gold.includes(ranked[0]?.path ?? "") ? 1 : 0;
}

/** Reciprocal rank of the best gold file (0 when none appear). */
export function reciprocalRank(ranked: RankedFile[], gold: string[]): number {
  const rank = bestGoldRank(ranked, gold);
  return rank === null ? 0 : 1 / rank;
}

// ---------------------------------------------------------------------------
// Aggregation + bootstrap CI (seeded)
// ---------------------------------------------------------------------------

/** Seeded percentile bootstrap of the mean, resampling with replacement. */
export function bootstrapMeanCi(
  values: number[],
  seed: number,
  draws = BINDING_COUNT,
  alpha = CI_ALPHA,
): { mean: number; ciLow: number; ciHigh: number } {
  if (values.length === 0) return { mean: 0, ciLow: 0, ciHigh: 0 };
  const sortedErrors: number[] = [];
  let rngState = seed >>> 0;
  const next = (): number => {
    // mulberry32 inline: same PRNG as the lib module, without an import cycle.
    rngState = (rngState + 0x6d2b79f5) | 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / values.length;
  for (let d = 0; d < draws; d++) {
    let s = 0;
    for (let i = 0; i < values.length; i++) {
      s += values[Math.floor(next() * values.length)]!;
    }
    sortedErrors.push(s / values.length);
  }
  sortedErrors.sort((a, b) => a - b);
  const lo = sortedErrors[Math.floor((alpha / 2) * draws)]!;
  const hi = sortedErrors[Math.ceil((1 - alpha / 2) * draws) - 1]!;
  return { mean, ciLow: lo, ciHigh: hi };
}

export function summarize(values: number[], seed: number): MetricSummary {
  const { mean, ciLow, ciHigh } = bootstrapMeanCi(values, seed);
  return { n: values.length, mean, ciLow, ciHigh };
}

/**
 * Computes the full metric family for one ranked list against gold.
 * Returns the raw per-task values so the harness can also report worst/best.
 */
export function taskMetrics(ranked: RankedFile[], gold: string[]): {
  top1: number;
  recall5: number;
  recall10: number;
  allGoldAcc10: number;
  mrr: number;
} {
  return {
    top1: top1Hit(ranked, gold),
    recall5: recallAtK(ranked, gold, 5),
    recall10: recallAtK(ranked, gold, 10),
    allGoldAcc10: allGoldAccAtK(ranked, gold, 10),
    mrr: reciprocalRank(ranked, gold),
  };
}

/** Aggregates per-task metric values into the reportable summaries. */
export function aggregateRuns(perTask: Array<ReturnType<typeof taskMetrics>>, seed: number): RunMetrics {
  return {
    top1: summarize(perTask.map((m) => m.top1), seed),
    recall5: summarize(perTask.map((m) => m.recall5), seed),
    recall10: summarize(perTask.map((m) => m.recall10), seed),
    allGoldAcc10: summarize(perTask.map((m) => m.allGoldAcc10), seed),
    mrr: summarize(perTask.map((m) => m.mrr), seed),
  };
}
