/**
 * M4 seed-simulation pure functions (unit-tested in seeds-sim.test.ts):
 * the gold-subset reveal sampler and the FAIRNESS removal applied to every
 * arm (revealed files are stripped from ranked lists and packages before
 * any hidden-gold metric is computed — ADR-006 amendment 1).
 */
import { hashString, mulberry32 } from "./lib";
import type { RankedFile } from "./metrics";

export interface Reveal {
  revealed: string[];
  hidden: string[];
}

/**
 * Deterministically reveals ceil(k/2) of the task's gold files (k = |gold|),
 * seeded by the task id. Sorted for stability; the remainder is hidden.
 */
export function revealGold(taskId: string, gold: string[]): Reveal {
  const rng = mulberry32(hashString(taskId) ^ 0x5eed);
  const sorted = [...gold].sort();
  const k = sorted.length;
  const take = Math.ceil(k / 2);
  const pool = [...sorted];
  const revealed: string[] = [];
  while (revealed.length < take && pool.length > 0) {
    const idx = Math.floor(rng() * pool.length) % pool.length;
    revealed.push(pool.splice(idx, 1)[0]!);
  }
  const revealedSet = new Set(revealed);
  return { revealed: revealed.sort(), hidden: sorted.filter((g) => !revealedSet.has(g)) };
}

/** FAIRNESS: removes the revealed files from a ranked list (order kept). */
export function stripRevealedRanked(ranked: RankedFile[], revealed: string[]): RankedFile[] {
  const set = new Set(revealed);
  return ranked.filter((r) => !set.has(r.path));
}

/** FAIRNESS: removes the revealed files from a delivered package's file set. */
export function stripRevealedPackage(packageFiles: string[], revealed: string[]): string[] {
  const set = new Set(revealed);
  return packageFiles.filter((p) => !set.has(p));
}

/**
 * Deterministic same-directory decoy pick: files in a revealed gold file's
 * directory (cycling over reveal dirs), excluding gold and the revealed set
 * themselves. Returns up to `count` paths sorted.
 */
export function sameDirDecoys(
  snapshotPaths: string[],
  revealed: string[],
  gold: string[],
  count: number,
  taskId: string,
): string[] {
  const goldSet = new Set(gold);
  const dirs = [
    ...new Set(revealed.map((r) => r.slice(0, Math.max(0, r.lastIndexOf("/"))))),
  ].sort();
  const candidates = snapshotPaths
    .filter((p) => !goldSet.has(p))
    .filter((p) => dirs.includes(p.slice(0, Math.max(0, p.lastIndexOf("/")))))
    .sort();
  if (candidates.length === 0) return [];
  const rng = mulberry32(hashString(taskId) ^ 0xd0c0);
  const out: string[] = [];
  let i = Math.floor(rng() * candidates.length) % candidates.length;
  while (out.length < Math.min(count, candidates.length)) {
    const c = candidates[i % candidates.length]!;
    if (!out.includes(c)) out.push(c);
    i++;
    if (i > candidates.length * 2) break;
  }
  return out.sort();
}

/** Random non-gold decoys (seeded by task id). */
export function randomDecoys(
  snapshotPaths: string[],
  revealed: string[],
  gold: string[],
  count: number,
  taskId: string,
): string[] {
  const exclude = new Set([...gold, ...revealed]);
  const candidates = snapshotPaths.filter((p) => !exclude.has(p)).sort();
  if (candidates.length === 0) return [];
  const rng = mulberry32(hashString(taskId) ^ 0x7de1);
  const out: string[] = [];
  const pool = [...candidates];
  while (out.length < Math.min(count, pool.length)) {
    const idx = Math.floor(rng() * pool.length) % pool.length;
    out.push(pool.splice(idx, 1)[0]!);
  }
  return out.sort();
}
