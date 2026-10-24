import { isStopword, tokenizeIdentifier } from "../shared/text";

/** Body-term frequencies for one file (M3/E1). */
export interface BodyTokens {
  /** Top terms by tf (capped, ties broken lexicographically). */
  terms: Array<{ term: string; tf: number }>;
  /** Total token count before capping (document length for BM25F). */
  total: number;
}

/** Per-file cap on stored body terms (index-size guard). */
export const BODY_TOKEN_TOP_N = 192;

/**
 * Extracts body tokens — comments, string literals, prose, identifiers:
 * everything in the raw content — as term frequencies. This is the field
 * plain BM25 ranks over and OCC lacked (Step-0 finding (b): some gold files
 * match the task only through body text). Deterministic: tokenizeIdentifier
 * lowercases and splits camelCase/kebab/snake; single characters and
 * stopwords are dropped; per-term tf is capped.
 */
export function extractBodyTokens(content: string, topN: number, maxTf = 8): BodyTokens {
  const counts = new Map<string, number>();
  let total = 0;
  for (const token of tokenizeIdentifier(content)) {
    if (token.length < 2 || isStopword(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
    total++;
  }
  const terms = [...counts.entries()]
    .map(([term, tf]) => ({ term, tf: Math.min(tf, maxTf) }))
    .sort((a, b) => b.tf - a.tf || (a.term < b.term ? -1 : 1))
    .slice(0, topN);
  return { terms, total };
}
