import { canonicalTerm, tokenizeIdentifier, isStopword } from "../shared/text";

export interface QueryAnalysis {
  /** Original whitespace-separated words (stopwords removed). */
  words: string[];
  /** Canonical (joined, lowercased) forms used for lexical matching. */
  terms: string[];
  /** camelCase / PascalCase / snake_case / quoted identifier candidates. */
  identifierCandidates: string[];
  /** Canonical forms of identifier candidates (for exact symbol matching). */
  exactCandidates: string[];
  /** Tokens that look like file names or extensions. */
  fileHints: string[];
  /** Quoted phrases, verbatim. */
  quotedPhrases: string[];
}

const QUOTED_RE = /"([^"]+)"|'([^']+)'/g;
const IDENTIFIERISH_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

/**
 * Deterministic, purely lexical query analysis: words, identifier candidates
 * (any token that is a legal identifier, casing variants included), file
 * name/extension hints, and quoted phrases. No NLP, no embeddings.
 */
export function analyzeQuery(rawQuery: string): QueryAnalysis {
  const quotedPhrases: string[] = [];
  let working = rawQuery;
  for (const match of rawQuery.matchAll(QUOTED_RE)) {
    const phrase = match[1] ?? match[2];
    if (phrase && phrase.trim()) quotedPhrases.push(phrase.trim());
  }
  working = working.replace(QUOTED_RE, " ");

  const words = working
    .split(/[\s,;:!?()\[\]{}]+/)
    .map((w) => w.trim())
    // Strip trailing/leading punctuation so "login." classifies as an identifier.
    .map((w) => w.replace(/^[^\w$@/]+|[^\w$./]+$/g, ""))
    .filter((w) => w.length > 0 && !isStopword(w.toLowerCase()));

  const identifierCandidates: string[] = [];
  const fileHints: string[] = [];
  for (const word of words) {
    if (/\.[A-Za-z0-9]+$/.test(word)) {
      fileHints.push(word.toLowerCase());
      continue;
    }
    // Strip trailing punctuation ("login." → "login") before identifier checks.
    const cleaned = word.replace(/^[^A-Za-z0-9_$]+|[^A-Za-z0-9_$]+$/g, "");
    if (cleaned.length > 0 && IDENTIFIERISH_RE.test(cleaned)) identifierCandidates.push(cleaned);
  }

  const terms: string[] = [];
  for (const word of words) {
    for (const token of tokenizeIdentifier(word)) {
      const canonical = canonicalTerm(token);
      if (canonical && !terms.includes(canonical)) terms.push(canonical);
    }
  }
  for (const phrase of quotedPhrases) {
    for (const token of tokenizeIdentifier(phrase)) {
      const canonical = canonicalTerm(token);
      if (canonical && !terms.includes(canonical)) terms.push(canonical);
    }
  }

  const exactCandidates = [...new Set(identifierCandidates.map((c) => canonicalTerm(c)))].filter(
    (c) => c.length > 0,
  );

  return { words, terms, identifierCandidates, exactCandidates, fileHints, quotedPhrases };
}
