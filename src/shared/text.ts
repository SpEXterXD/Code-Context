/**
 * Deterministic identifier normalization. Splits camelCase, PascalCase,
 * snake_case, kebab-case, dotted and slashed identifiers into lowercase word
 * tokens so `rate-limiting`, `rate_limit`, `rateLimit` and `RateLimiter` are
 * treated as related terms. No NLP is involved, just character rules.
 */

const WORD_RE = /[A-Z]+(?![a-z])|[A-Z][a-z0-9]*|[a-z0-9]+/g;

/** Splits an identifier into lowercase word tokens. */
export function tokenizeIdentifier(identifier: string): string[] {
  const cleaned = identifier.replace(/[^A-Za-z0-9]+/g, " ").trim();
  if (!cleaned) return [];
  const tokens: string[] = [];
  for (const chunk of cleaned.split(/\s+/)) {
    const matches = chunk.match(WORD_RE);
    if (!matches) continue;
    for (const m of matches) tokens.push(m.toLowerCase());
  }
  return tokens;
}

/** Produces the distinct normalization variants of an identifier (lowercased joined forms). */
export function identifierVariants(identifier: string): string[] {
  const tokens = tokenizeIdentifier(identifier);
  if (tokens.length === 0) return [];
  const joined = tokens.join("");
  const snake = tokens.join("_");
  const kebab = tokens.join("-");
  return [...new Set([joined, snake, kebab])];
}

/**
 * Normalizes a query term to its canonical token stream joined form
 * (e.g. "RateLimiter" -> "rate", "limiter" -> "ratelimiter").
 */
export function canonicalTerm(term: string): string {
  return tokenizeIdentifier(term).join("");
}

/** Expands a query term into all token variants used for matching. */
export function expandQueryTerm(term: string): { canonical: string; tokens: string[] } {
  const tokens = tokenizeIdentifier(term);
  return { canonical: tokens.join(""), tokens };
}

/** Very small stopword list for natural-language queries (not for identifiers). */
const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "and",
  "or",
  "not",
  "it",
  "this",
  "that",
  "these",
  "those",
  "at",
  "by",
  "from",
  "as",
  "into",
  "where",
  "how",
  "what",
  "when",
  "which",
  "who",
  "whom",
  "does",
  "do",
  "add",
  "fix",
  "make",
  "use",
  "using",
  "my",
  "our",
  "your",
  "i",
  "we",
  "handled",
  "handle",
  "implement",
  "implemented",
  "implementing",
  "create",
  "created",
  "creating",
  "should",
  "would",
  "could",
  "can",
  "need",
  "needs",
  "want",
  "please",
  "some",
  "any",
  "all",
  "there",
]);

export function isStopword(word: string): boolean {
  return STOPWORDS.has(word.toLowerCase());
}

export function stripStopwords(words: string[]): string[] {
  return words.filter((w) => !isStopword(w));
}

/** Compares two strings with standard lexicographic ordering; used everywhere for stable sorts. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
