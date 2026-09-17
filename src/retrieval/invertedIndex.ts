import type { FileEntry } from "../domain/model";
import { tokenizeIdentifier, canonicalTerm, compareStrings } from "../shared/text";

/**
 * Field weights for lexical scoring. Documented (ADR-4): symbol names count
 * most, then paths, then imported/exported names, then doc summaries, then
 * raw source identifiers. Folding weights into tf at index time keeps query
 * scoring a single multiply-add chain.
 */
export const FIELD_WEIGHTS = {
  symbol: 3.0,
  path: 2.0,
  io: 2.0, // import/export names
  summary: 1.2,
  identifier: 0.8,
} as const;

const MAX_TF_PER_FIELD = 10;

/**
 * Incremental inverted index over indexed files. Maintained in memory from
 * persisted entries; `applyEntry`/`removeFile` keep it in sync with the
 * index manager so no full rebuild is ever needed after startup.
 *
 * Determinism: postings are plain maps, but every consumer sorts before use.
 */
export class InvertedIndex {
  /** term -> (path -> weighted tf) */
  private readonly postings = new Map<string, Map<string, number>>();
  /** path -> (term -> weighted tf), kept for idf iteration + explanations */
  private readonly docTerms = new Map<string, Map<string, number>>();
  private docCount = 0;

  get size(): number {
    return this.docCount;
  }

  applyEntry(entry: FileEntry): void {
    this.removeFile(entry.meta.path);
    // Pass 1: accumulate raw occurrence counts per field across the whole
    // document. Pass 2: apply field weight + sublinear tf damping once per
    // (field, term), so N distinct symbol names mentioning "rate" count as
    // N occurrences and then damp, instead of compounding linearly.
    const fieldCounts = new Map<keyof typeof FIELD_WEIGHTS, Map<string, number>>();
    const add = (field: keyof typeof FIELD_WEIGHTS, text: string): void => {
      let counts = fieldCounts.get(field);
      if (!counts) {
        counts = new Map();
        fieldCounts.set(field, counts);
      }
      const tokens = field === "identifier" ? splitIdentifiers(text) : tokenizeIdentifier(text);
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1);
      // Multi-token names also index their whole canonical form (marked to
      // skip re-tokenization) so a query for "RateLimiter" hits the symbol
      // field directly, not only via prefix matching over "rate"/"limiter".
      if (field !== "identifier" && tokens.length > 1) {
        const whole = canonicalTerm(text);
        if (whole)
          counts.set(`\u0000whole:${whole}`, (counts.get(`\u0000whole:${whole}`) ?? 0) + 1);
      }
    };

    add("path", entry.meta.path.replace(/[/_.]/g, " "));
    for (const sym of entry.symbols) add("symbol", sym.name);
    for (const imp of entry.imports) add("io", imp.importedNames.join(" "));
    for (const exp of entry.exports) add("io", exp.name);
    if (entry.fileSummary) add("summary", entry.fileSummary);
    for (const id of entry.identifiers ?? []) add("identifier", id);

    const terms = new Map<string, number>();
    for (const [field, counts] of fieldCounts) {
      const weight = FIELD_WEIGHTS[field];
      for (const [token, count] of counts) {
        const isWhole = token.startsWith("\u0000whole:");
        const term = isWhole ? token.slice(7) : canonicalTerm(token);
        if (!term) continue;
        // Sublinear tf damping (1 + ln tf): standard IR practice.
        const contribution = weight * (1 + Math.log(Math.min(count, MAX_TF_PER_FIELD)));
        terms.set(term, (terms.get(term) ?? 0) + contribution);
      }
    }

    for (const [term, tf] of terms) {
      let bag = this.postings.get(term);
      if (!bag) {
        bag = new Map();
        this.postings.set(term, bag);
      }
      bag.set(entry.meta.path, tf);
    }
    this.docTerms.set(entry.meta.path, terms);
    this.docCount++;
  }

  removeFile(path: string): void {
    const terms = this.docTerms.get(path);
    if (!terms) return;
    for (const term of terms.keys()) {
      const bag = this.postings.get(term);
      if (!bag) continue;
      bag.delete(path);
      if (bag.size === 0) this.postings.delete(term);
    }
    this.docTerms.delete(path);
    this.docCount--;
  }

  /** Bulk rebuild from entries (sorted paths for deterministic construction). */
  rebuildAll(entries: Map<string, FileEntry>): void {
    this.postings.clear();
    this.docTerms.clear();
    this.docCount = 0;
    for (const path of [...entries.keys()].sort(compareStrings)) {
      const entry = entries.get(path);
      if (entry) this.applyEntry(entry);
    }
  }

  /** Weighted tf of a term in a doc (0 if absent). */
  tf(term: string, path: string): number {
    return this.postings.get(term)?.get(path) ?? 0;
  }

  /** Documents containing a term, as a sorted path list. */
  docsFor(term: string): string[] {
    return [...(this.postings.get(term)?.keys() ?? [])].sort(compareStrings);
  }

  /**
   * All postings whose key is a prefix of `term` or vice versa (min length 4).
   * Deterministic morphological-lite matching: "authentication" ~ "auth",
   * "limiting" ~ "limit". Pure string rules, no NLP.
   */
  docsForPrefix(term: string): Array<{ key: string; docs: string[] }> {
    const results: Array<{ key: string; docs: string[] }> = [];
    const minLen = Math.min(4, term.length);
    for (const [key, bag] of this.postings) {
      if (key === term) continue;
      const shorter = key.length < term.length ? key : term;
      if (shorter.length < minLen) continue;
      const longer = key.length < term.length ? term : key;
      if (!longer.startsWith(shorter)) continue;
      results.push({ key, docs: [...bag.keys()].sort(compareStrings) });
    }
    return results;
  }

  /** Inverse document frequency: log(1 + N/df). Deterministic per corpus state. */
  idf(term: string): number {
    const df = this.postings.get(term)?.size ?? 0;
    if (df === 0) return 0;
    return Math.log(1 + this.docCount / df);
  }

  /** Max achievable weighted tf for normalization (sum of field weights). */
  get maxTermWeight(): number {
    return Object.values(FIELD_WEIGHTS).reduce((a, b) => a + b, 0);
  }

  /** Terms present in a doc with their weighted tf (for explanation output). */
  termsOf(path: string): Array<[string, number]> {
    return [...(this.docTerms.get(path)?.entries() ?? [])];
  }
}

function splitIdentifiers(text: string): string[] {
  // Identifiers arrive pre-split (one per array element); normalize casing only.
  return [text];
}
