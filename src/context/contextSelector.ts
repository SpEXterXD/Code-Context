import type { FileEntry } from "../domain/model";
import { compareStrings } from "../shared/text";
import type { ScoredFile } from "../retrieval/relevanceScorer";

/**
 * Selection priority policy. Explicit, documented, and enforced in code:
 *
 *   1. USER_SELECTED:      explicitly chosen by the developer (never dropped)
 *   2. EXACT_SYMBOL:       exact symbol-name matches for the task
 *   3. DIRECT_DEPENDENCY:  files that seed files import
 *   4. DIRECT_DEPENDENT:   files that import seed files
 *   5. RELEVANT_TESTS:     naming-convention test files of seeds
 *   6. STRONG_LEXICAL:     lexical/file-name/call/inheritance matches
 *   7. ARCHITECTURAL:      same-directory, recency, structural context
 *   8. LOWER_CONFIDENCE:   anything else that scored > 0
 */
export const SELECTION_TIERS = [
  "USER_SELECTED",
  "EXACT_SYMBOL",
  "DIRECT_DEPENDENCY",
  "DIRECT_DEPENDENT",
  "RELEVANT_TESTS",
  "STRONG_LEXICAL",
  "ARCHITECTURAL",
  "LOWER_CONFIDENCE",
] as const;

export type SelectionTier = (typeof SELECTION_TIERS)[number];

export const TIER_LABELS: Record<SelectionTier, string> = {
  USER_SELECTED: "explicitly selected by user",
  EXACT_SYMBOL: "exact symbol match",
  DIRECT_DEPENDENCY: "direct dependency",
  DIRECT_DEPENDENT: "direct dependent",
  RELEVANT_TESTS: "relevant test",
  STRONG_LEXICAL: "strong lexical match",
  ARCHITECTURAL: "architectural context",
  LOWER_CONFIDENCE: "lower-confidence match",
};

export interface RankedCandidate {
  path: string;
  score: number;
  signals: ScoredFile["signals"];
  tier: SelectionTier;
}

/**
 * Derives the tier from the file's fired signals (strongest wins per the
 * priority order above), then sorts by (tier, score desc, path asc).
 */
export function assignTiers(ranked: ScoredFile[], pinnedPaths: string[]): RankedCandidate[] {
  const pinned = new Set(pinnedPaths);
  const candidates: RankedCandidate[] = ranked.map((r) => {
    if (pinned.has(r.path)) {
      return { ...r, tier: "USER_SELECTED" as const };
    }
    const kinds = new Set(r.signals.map((s) => s.kind));
    let tier: SelectionTier = "LOWER_CONFIDENCE";
    if (kinds.has("EXACT_SYMBOL")) tier = "EXACT_SYMBOL";
    else if (kinds.has("DIRECT_DEPENDENCY")) tier = "DIRECT_DEPENDENCY";
    else if (kinds.has("DIRECT_DEPENDENT")) tier = "DIRECT_DEPENDENT";
    else if (kinds.has("TEST_OF")) tier = "RELEVANT_TESTS";
    else if (
      kinds.has("LEXICAL") ||
      kinds.has("FILE_NAME") ||
      kinds.has("CALL_EDGE") ||
      kinds.has("INHERITANCE") ||
      kinds.has("ENTRY_POINT")
    ) {
      tier = "STRONG_LEXICAL";
    } else if (kinds.has("SAME_DIRECTORY") || kinds.has("RECENCY") || kinds.has("HUB")) {
      tier = "ARCHITECTURAL";
    }
    return { ...r, tier };
  });
  const tierOrder = new Map(SELECTION_TIERS.map((t, i) => [t, i] as const));
  return candidates.sort(
    (a, b) =>
      (tierOrder.get(a.tier) ?? 99) - (tierOrder.get(b.tier) ?? 99) ||
      b.score - a.score ||
      compareStrings(a.path, b.path),
  );
}

/** Entry-point heuristics for Project mode seeds. */
export function findEntryPoints(entries: Map<string, FileEntry>): string[] {
  const results: string[] = [];
  for (const path of [...entries.keys()].sort(compareStrings)) {
    const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
    if (
      /^(index|main|app|server|entry)\.[cm]?[jt]sx?$/.test(base) &&
      !path.includes("node_modules")
    ) {
      results.push(path);
    }
  }
  return results;
}

/** Hub files ranked by total edge degree (deterministic tie-break by path). */
export function findHubFiles(
  graph: { fileDependencies(p: string): string[]; fileDependents(p: string): string[] },
  entries: Map<string, FileEntry>,
  limit: number,
): Array<{ path: string; degree: number }> {
  const scored = [...entries.keys()]
    .filter((p) => !entries.get(p)?.meta.isTest)
    .map((p) => ({
      path: p,
      degree: graph.fileDependencies(p).length + graph.fileDependents(p).length,
    }))
    .filter((f) => f.degree > 0)
    .sort((a, b) => b.degree - a.degree || compareStrings(a.path, b.path));
  return scored.slice(0, limit);
}
