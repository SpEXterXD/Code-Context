/**
 * Paired old-vs-new comparison of two eval-retrieval results files (same
 * split, same dataset). Joins OCC per-task metric values on task id and runs
 * the seeded PAIRED bootstrap (metrics.pairedDiffCi) for every metric on
 * both gold slices — this is the M3 keep/revert gate: a change is kept only
 * if package recall or AllGold@10 improves with a CI excluding 0 in the
 * right direction and Top-1/MRR do not significantly regress.
 *
 * Usage: npx tsx scripts/eval/eval-compare.ts <old-results.json> <new-results.json>
 */
import * as fs from "node:fs";

import { pairedDiffCi } from "./metrics";

interface PerTask {
  id: string;
  full: Record<MetricKey, number>;
  sourceOnly: Record<MetricKey, number>;
}

type MetricKey = "top1" | "recall5" | "recall10" | "allGoldAcc10" | "mrr" | "packageRecall";
const METRICS: MetricKey[] = [
  "top1",
  "recall5",
  "recall10",
  "allGoldAcc10",
  "mrr",
  "packageRecall",
];

interface ResultsShape {
  split: string;
  occCommit: string;
  ablations?: string[];
  datasetHash: string;
  perTask?: PerTask[];
}

function load(file: string): ResultsShape {
  const r = JSON.parse(fs.readFileSync(file, "utf8")) as ResultsShape;
  if (!r.perTask) {
    throw new Error(`${file} has no perTask section (produced before the M3 compare tooling)`);
  }
  return r;
}

function main(): void {
  const [oldFile, newFile] = process.argv.slice(2);
  if (!oldFile || !newFile) {
    console.error("usage: npx tsx scripts/eval/eval-compare.ts <old.json> <new.json>");
    process.exit(1);
  }
  const oldR = load(oldFile);
  const newR = load(newFile);
  if (oldR.datasetHash !== newR.datasetHash) {
    console.error(
      `dataset hashes differ (${oldR.datasetHash} vs ${newR.datasetHash}) — tasks are not comparable`,
    );
    process.exit(1);
  }
  const oldById = new Map(oldR.perTask!.map((t) => [t.id, t] as const));
  const joined = newR.perTask!.filter((t) => oldById.has(t.id));
  console.log(
    `old ${oldFile} (${oldR.occCommit.slice(0, 12)}${oldR.ablations?.length ? " ablated:" + oldR.ablations.join(",") : ""})` +
      ` vs new ${newFile} (${newR.occCommit.slice(0, 12)}${newR.ablations?.length ? " ablated:" + newR.ablations.join(",") : ""})` +
      ` — ${joined.length} paired tasks, dataset ${oldR.datasetHash}`,
  );
  for (const slice of ["full", "sourceOnly"] as const) {
    console.log(`\n== ${slice} (new − old, paired 95% CI) ==`);
    for (const m of METRICS) {
      const d = pairedDiffCi(
        joined.map((t) => t[slice][m]),
        joined.map((t) => oldById.get(t.id)![slice][m]),
        20260918,
      );
      const sign = d.meanDiff > 0 ? "+" : "";
      console.log(
        `${m.padEnd(14)} ${sign}${d.meanDiff.toFixed(3)} [${d.ciLow.toFixed(3)}, ${d.ciHigh.toFixed(3)}] ${d.excludesZero ? (d.meanDiff > 0 ? "EXCLUDES 0 (better)" : "EXCLUDES 0 (WORSE)") : "n.s."}`,
      );
    }
  }
}

main();
