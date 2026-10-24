/**
 * M4 seed-simulation runner (tuning split; the final confirmation runs this
 * in `--pool` mode against pools A/B). For every qualifying task (gold with
 * k>=2) it reveals ceil(k/2) gold as "already edited" seeds, runs the arms,
 * strips the revealed files from EVERY arm (fairness, ADR-006 amendment 1)
 * and scores the HIDDEN gold only.
 *
 * Arms: unseeded | seeded (DIFF_TOUCHED, weight from --weight) |
 * bm25names | decoy-samedir | mixed | random-decoy | realdiff (adds the
 * revealed files' REAL commit diff as CURRENT CHANGES).
 *
 * Usage:
 *   npm run eval:seeds-sim -- --split tuning [--weight 0.6] [--limit N]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { OccApplication } from "../src/application/contextService";
import { CancellationSource } from "../src/shared/cancellation";

import type { Snapshot } from "./eval/baselines";
import { bm25Baseline } from "./eval/baselines";
import { cloneDirFor, materializeSnapshot, verifyPinnedCommit } from "./eval/gitminer";
import { pairedDiffCi, taskMetrics, type PairedDiff, type RankedFile } from "./eval/metrics";
import { hashString } from "./eval/lib";
import {
  buildTuningDataset,
  loadEvalDataset,
  loadReposFile,
  readSnapshot,
  type DatasetFile,
  type ReposFile,
} from "./eval/splitLoader";
import type { DatasetTask } from "./eval/dataset";
import {
  randomDecoys,
  revealGold,
  sameDirDecoys,
  stripRevealedPackage,
  stripRevealedRanked,
} from "./eval/seedsSim";
import { isOccParsedPath } from "./eval/lib";

const ROOT = path.resolve(import.meta.dirname ?? path.join(process.cwd(), "scripts"), "..");
const SCRATCH_ROOT = path.join(ROOT, ".eval-cache", "seeds-sim");
const SEED = 20260918;

type Arm =
  "unseeded" | "seeded" | "bm25names" | "decoy-samedir" | "mixed" | "random-decoy" | "realdiff";
const ARMS: Arm[] = [
  "unseeded",
  "seeded",
  "bm25names",
  "decoy-samedir",
  "mixed",
  "random-decoy",
  "realdiff",
];

interface TaskOut {
  task: string;
  hidden: string[];
  revealedCount: number;
  arms: Record<Arm, { ranked: RankedFile[]; packageFiles: string[]; tokens: number }>;
}

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function occHeadCommit(): string {
  try {
    return execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function occWorkingTreeClean(): boolean {
  try {
    return (
      execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).trim() === ""
    );
  } catch {
    return false;
  }
}

function loadDataset(split: string, repos: ReposFile): DatasetFile {
  if (split === "tuning") return buildTuningDataset(repos, undefined);
  if (split === "eval") return loadEvalDataset();
  throw new Error(`unknown split ${split}`);
}

function realDiffFor(clonePath: string, parentSha: string, sha: string, paths: string[]): string {
  if (paths.length === 0) return "";
  try {
    return execFileSync(
      "git",
      [
        "-C",
        clonePath,
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        `${parentSha}..${sha}`,
        "--",
        ...paths,
      ],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60000 },
    );
  } catch {
    return "";
  }
}

async function main(): Promise<void> {
  const split = argValue("--split") ?? "tuning";
  const weight = Number(argValue("--weight") ?? "0.6");
  const limit = Number(argValue("--limit") ?? "0");
  const repos = loadReposFile();
  const dataset = loadDataset(split, repos);
  const qualifying = dataset.tasks.filter((t) => t.gold.length >= 2);
  const tasks = limit > 0 ? qualifying.slice(0, limit) : qualifying;
  const repoIds = [...new Set(tasks.map((t) => t.repoId))].sort();
  for (const repoId of repoIds) {
    const repo = repos.repos.find((r) => r.id === repoId);
    if (!repo) throw new Error(`repos.json has no entry for ${repoId}`);
    verifyPinnedCommit(cloneDirFor(repoId), repo.pinnedCommit);
  }
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  console.log(
    `seeds-sim: split=${split} qualifying=${qualifying.length} running=${tasks.length} weight=${weight} commit=${occHeadCommit().slice(0, 12)} clean=${occWorkingTreeClean()}`,
  );

  // Per-arm per-task record; checkpoint/resume like the other runners.
  const outFile = path.join(ROOT, ".eval-cache", "seeds-sim", `sim-${split}-w${weight}.jsonl`);
  const done = new Map<string, TaskOut>();
  if (fs.existsSync(outFile)) {
    for (const line of fs.readFileSync(outFile, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const t = JSON.parse(line) as TaskOut;
        done.set(t.task, t);
      } catch {
        break; // truncated tail
      }
    }
    console.log(`resuming: ${done.size} tasks checkpointed`);
  }

  let byPathOf: Map<string, Set<string>> | null = null;
  for (const repoId of repoIds) {
    const clonePath = cloneDirFor(repoId);
    for (const t of tasks.filter((x) => x.repoId === repoId) as DatasetTask[]) {
      if (done.has(t.id)) continue;
      const { revealed, hidden } = revealGold(t.id, t.gold);
      if (hidden.length === 0) continue; // fully revealed (k=2 edge): nothing to score
      const snapKey = `sim-${repoId}-${t.sha.slice(0, 12)}`;
      const snapDir = materializeSnapshot(clonePath, t.parentSha, SCRATCH_ROOT, snapKey);
      const app = new OccApplication(snapDir, path.join(SCRATCH_ROOT, "store"));
      app.initialize();
      const indexResult = await app.indexing.indexWorkspace(CancellationSource.never());
      if (indexResult.cancelled || app.indexing.getEntries().size === 0) {
        fs.rmSync(snapDir, { recursive: true, force: true });
        continue;
      }
      const snapshot: Snapshot = readSnapshot(snapDir);
      const snapshotPaths = [...snapshot.keys()].sort();
      const seedFor = (
        paths: string[],
      ): {
        changedPaths: { path: string; state: "unstaged" }[];
        diffSections: { path: string; diff: string }[];
        openEditors: { path: string; active: boolean }[];
        diagnostics: { path: string; message: string }[];
        stackFrames: { path: string; line: number }[];
        notes: string[];
      } => ({
        changedPaths: paths.map((p) => ({ path: p, state: "unstaged" as const })),
        diffSections: [],
        openEditors: [],
        diagnostics: [],
        stackFrames: [],
        notes: [],
      });
      const build = (
        seedPaths: string[],
        diff?: { sections: Array<{ path: string; diff: string }> },
      ) =>
        app.buildContext("task", {
          taskText: t.task,
          seedSet: {
            ...seedFor(seedPaths),
            diffSections: diff?.sections ?? [],
          },
        });

      const arms = {} as TaskOut["arms"];
      // unseeded + seeded + decoys + mixed
      const samedir = sameDirDecoys(snapshotPaths, revealed, t.gold, revealed.length, t.id);
      const mixed = [
        ...revealed.slice(0, Math.ceil(revealed.length / 2)),
        ...samedir.slice(0, Math.floor(revealed.length / 2)),
      ];
      const rnd = randomDecoys(snapshotPaths, revealed, t.gold, revealed.length, t.id);
      const plan: Array<{
        arm: Arm;
        seeds: string[];
        diff?: { sections: Array<{ path: string; diff: string }> };
      }> = [
        { arm: "unseeded", seeds: [] },
        { arm: "seeded", seeds: revealed },
        { arm: "decoy-samedir", seeds: samedir },
        { arm: "mixed", seeds: mixed },
        { arm: "random-decoy", seeds: rnd },
      ];
      for (const p of plan) {
        const ctx = build(p.seeds);
        arms[p.arm] = {
          ranked: (ctx.retrieval?.ranked ?? []).map((r) => ({ path: r.path, score: r.score })),
          packageFiles: [
            ...new Set([...ctx.payload.matchAll(/^### FILE: (.+)$/gm)].map((m) => m[1]!)),
          ],
          tokens: ctx.estimatedTokens,
        };
      }
      // bm25names: revealed names appended to the query text; its "package"
      // is the top-8 (the convention for baselines without packaging).
      const bm25Ranking = bm25Baseline(snapshot, `${t.task} ${revealed.join(" ")}`).map((r) => ({
        path: r.path,
        score: r.score,
      }));
      arms.bm25names = {
        ranked: bm25Ranking,
        packageFiles: bm25Ranking.slice(0, 8).map((r) => r.path),
        tokens: 0,
      };
      // realdiff: seeds + REAL commit diff of the revealed files
      const diffText = realDiffFor(clonePath, t.parentSha, t.sha, revealed);
      const rdCtx = build(revealed, {
        sections: [{ path: revealed[0] ?? "CHANGES.diff", diff: diffText }],
      });
      arms.realdiff = {
        ranked: (rdCtx.retrieval?.ranked ?? []).map((r) => ({ path: r.path, score: r.score })),
        packageFiles: [
          ...new Set([...rdCtx.payload.matchAll(/^### FILE: (.+)$/gm)].map((m) => m[1]!)),
        ],
        tokens: rdCtx.estimatedTokens,
      };

      const out: TaskOut = { task: t.id, hidden, revealedCount: revealed.length, arms };
      done.set(t.id, out);
      fs.appendFileSync(outFile, `${JSON.stringify(out)}\n`);
      fs.rmSync(snapDir, { recursive: true, force: true });
      console.log(`  ${t.id}: done (hidden ${hidden.length})`);
    }
  }

  // ---- scoring: fairness strip, hidden-gold metrics, paired CIs ----
  const hiddenByTask = new Map<string, string[]>();
  const revealedCountByTask = new Map<string, number>();
  for (const t of done.values()) {
    hiddenByTask.set(t.task, t.hidden);
    revealedCountByTask.set(t.task, t.revealedCount);
  }
  const goldOfSlice = (hidden: string[], slice: "full" | "sourceOnly"): string[] =>
    slice === "full" ? hidden : hidden.filter(isOccParsedPath);
  const score = (arm: Arm, slice: "full" | "sourceOnly") => {
    const values: Array<ReturnType<typeof taskMetrics> & { packageRecall: number }> = [];
    for (const t of done.values()) {
      const hidden = goldOfSlice(t.hidden, slice);
      if (hidden.length === 0) continue;
      const stripped = stripRevealedRanked(
        t.arms[arm].ranked,
        revealedCountByTask.has(t.task) ? revealedOf(t) : [],
      );
      const pkg = new Set(stripRevealedPackage(t.arms[arm].packageFiles, revealedOf(t)));
      const m = taskMetrics(stripped, hidden);
      values.push({
        ...m,
        packageRecall: hidden.filter((g) => pkg.has(g)).length / Math.max(1, hidden.length),
      });
    }
    return values;
  };
  const revealedOf = (t: TaskOut): string[] => {
    // recover the revealed set from the record's complement: not stored —
    // recompute from the dataset (deterministic).
    void t;
    return dataset.tasks.find((d) => d.id === t.task)
      ? revealGold(t.task, (dataset.tasks.find((d) => d.id === t.task) as DatasetTask).gold)
          .revealed
      : [];
  };

  const summary: Record<string, unknown> = {
    split,
    weight,
    occCommit: occHeadCommit(),
    workingTreeClean: occWorkingTreeClean(),
    tasksScored: done.size,
    arms: {},
  };
  for (const slice of ["full", "sourceOnly"] as const) {
    const perArm: Record<
      string,
      { mean: Record<string, number>; pairedVsUnseeded: Record<string, PairedDiff> }
    > = {};
    for (const arm of ARMS) {
      const vals = score(arm, slice);
      const mean = {
        top1: avg(vals.map((v) => v.top1)),
        recall8: avg(vals.map((v) => v.recall5)),
        recall10: avg(vals.map((v) => v.recall10)),
        mrr: avg(vals.map((v) => v.mrr)),
        packageRecall: avg(vals.map((v) => v.packageRecall)),
      };
      const paired: Record<string, PairedDiff> = {};
      if (arm !== "unseeded") {
        const base = score("unseeded", slice);
        paired.packageRecall = pairedDiffCi(
          vals.map((v) => v.packageRecall),
          base.map((v) => v.packageRecall),
          SEED + hashString(`${arm}:${slice}:pkg`),
        );
        paired.recall10 = pairedDiffCi(
          vals.map((v) => v.recall10),
          base.map((v) => v.recall10),
          SEED + hashString(`${arm}:${slice}:r10`),
        );
        paired.top1 = pairedDiffCi(
          vals.map((v) => v.top1),
          base.map((v) => v.top1),
          SEED + hashString(`${arm}:${slice}:top1`),
        );
      }
      perArm[arm] = { mean, pairedVsUnseeded: paired };
    }
    summary[`${slice}Slice`] = perArm;
  }
  const outDir = path.join(ROOT, "docs", "eval");
  fs.mkdirSync(outDir, { recursive: true });
  const summaryFile = path.join(outDir, `results-seeds-sim-${split}-w${weight}.json`);
  fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`summary written: ${path.relative(ROOT, summaryFile)}`);
  const full = (
    summary as {
      fullSlice: Record<
        string,
        { mean: Record<string, number>; pairedVsUnseeded: Record<string, PairedDiff> }
      >;
    }
  ).fullSlice;
  const tokenMeans: Record<string, number> = {};
  for (const arm of ARMS) {
    const toks = [...done.values()].map((t) => t.arms[arm].tokens);
    tokenMeans[arm] = avg(toks);
  }
  (summary as { meanTokensPerArm: Record<string, number> }).meanTokensPerArm = tokenMeans;
  for (const arm of ARMS) {
    const m = full[arm]!.mean;
    const p = full[arm]!.pairedVsUnseeded;
    console.log(
      `${arm.padEnd(14)} top1 ${m.top1.toFixed(3)} r8 ${m.recall8.toFixed(3)} r10 ${m.recall10.toFixed(3)} mrr ${m.mrr.toFixed(3)} pkgR ${m.packageRecall.toFixed(3)} tok~${tokenMeans[arm]!.toFixed(0)}`,
      arm !== "unseeded" && p.packageRecall
        ? `| dPkg ${p.packageRecall.meanDiff.toFixed(3)} [${p.packageRecall.ciLow.toFixed(3)},${p.packageRecall.ciHigh.toFixed(3)}]${p.packageRecall.excludesZero ? "*" : ""}`
        : "",
    );
  }
}

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

void main();
