/**
 * Baseline retrievers for the M2 eval harness so OCC is never reported in
 * isolation. All are pure functions of (snapshot, task text, seed), all
 * deterministic (ties broken by path order), and none touch OCC code.
 *
 * A snapshot is an in-memory map of path → file content at the task's PARENT
 * commit (materialized by the harness), so no baseline can see the future.
 */
import { pathTokens, tokenize } from "./lib";
import type { RankedFile } from "./metrics";

/** In-memory repo state at one parent commit. */
export type Snapshot = Map<string, string>;

const MAX_CONTENT_TOKENS = 50_000; // cap per file so huge files cannot dominate

/**
 * Baseline (a): tokenize the task and score paths by token-identity overlap.
 * A basename match weighs double, and rarer (more specific) tokens weigh
 * more (inverse document frequency over the snapshot's basenames).
 */
export function filenameBaseline(snapshot: Snapshot, task: string): RankedFile[] {
  const queryTokens = new Set(tokenize(task));
  if (queryTokens.size === 0) return [];
  const paths = [...snapshot.keys()].sort();
  const documents: { path: string; base: Set<string>; full: Set<string> }[] = [];
  const df = new Map<string, number>();
  for (const path of paths) {
    const base = new Set(pathTokens(path.split("/").pop() ?? path));
    const full = new Set(pathTokens(path));
    for (const t of new Set([...base, ...full])) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
    documents.push({ path, base, full });
  }
  const N = Math.max(1, paths.length);
  const scored = documents.map((doc) => {
    let score = 0;
    let hits = 0;
    for (const t of queryTokens) {
      let weight = 0;
      if (doc.base.has(t)) weight += 2;
      else if (doc.full.has(t)) weight += 1;
      if (weight > 0) {
        const idf = Math.log((N + 1) / ((df.get(t) ?? 0) + 1)) + 1;
        score += weight * idf;
        hits++;
      }
    }
    return { path: doc.path, score: hits > 0 ? score : 0 };
  });
  return sortScoredRanked(scored);
}

/**
 * Baseline (b): Okapi BM25 over file *contents* (the plain grep-like lexical
 * floor for retrieval). Files are tokenized with the shared identifier
 * tokenizer; overlapping path tokens add a tiny deterministic tie-break.
 */
const BM25_K1 = 1.2;
const BM25_B = 0.75;

export function bm25Baseline(snapshot: Snapshot, task: string): RankedFile[] {
  const terms = [...new Set(tokenize(task))];
  if (terms.length === 0) return [];
  const paths = [...snapshot.keys()].sort();
  const docTokens = new Map<string, Map<string, number>>();
  const docLen = new Map<string, number>();
  const df = new Map<string, number>();
  let totalLen = 0;
  for (const p of paths) {
    const raw = snapshot.get(p) ?? "";
    const toks = tokenize(raw.slice(0, MAX_CONTENT_TOKENS * 10)).slice(0, MAX_CONTENT_TOKENS);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    docTokens.set(p, tf);
    docLen.set(p, toks.length);
    totalLen += toks.length;
    for (const t of tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const N = Math.max(1, paths.length);
  const avgLen = totalLen / N;
  const termsSet = new Set(terms);
  const scored = paths.map((p) => {
    const tf = docTokens.get(p)!;
    const len = docLen.get(p)!;
    let score = 0;
    for (const term of terms) {
      const f = tf.get(term) ?? 0;
      if (f === 0) continue;
      const dfT = df.get(term) ?? 0;
      const idf = Math.log(1 + (N - dfT + 0.5) / (dfT + 0.5));
      const norm =
        (f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (len / (avgLen || 1))));
      score += idf * norm;
    }
    // Small deterministic tie-break for exact score ties.
    const pathBoost = pathTokens(p).filter((t) => termsSet.has(t)).length * 0.001;
    return { path: p, score: score > 0 ? score + pathBoost : 0 };
  });
  return sortScoredRanked(scored);
}

/**
 * Baseline (c): random ranking — seeded per task (task hash + run seed), a
 * reproducible worst-case floor. Better first is arbitrary; the point is the
 * chance of gold appearing within k without any signal.
 */
export function randomBaseline(snapshot: Snapshot, task: string, seed: number): RankedFile[] {
  const mixed = [...snapshot.keys()].sort();
  let state = (taskHash(task) ^ (seed >>> 0)) >>> 0;
  for (let i = mixed.length - 1; i > 0; i--) {
    const j = Math.floor(nextRandom() * (i + 1));
    const a = mixed[i]!;
    const b = mixed[j]!;
    mixed[i] = b;
    mixed[j] = a;
  }
  return mixed.map((path, i) => ({ path, score: -i }));

  function nextRandom(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

// -- internals ---------------------------------------------------------------

function sortScoredRanked(scored: { path: string; score: number }[]): RankedFile[] {
  return scored
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((s) => ({ path: s.path, score: s.score }));
}

/** FNV-1a — same recipe as lib.hashString, duplicated to avoid the import cycle. */
function taskHash(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
