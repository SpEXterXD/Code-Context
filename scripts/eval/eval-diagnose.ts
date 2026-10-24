/**
 * M3 Step-0 diagnostics (analysis only; never changes retrieval behavior).
 * For every task of the requested split (default: tuning) it runs the OCC
 * pipeline headlessly and classifies EVERY gold file by where it is lost:
 *
 *   delivered | not-in-candidates | ranked-outside-top8 | top8-not-packaged
 *   | packaged-metadata-only | security-withheld
 *
 * plus three focused probes:
 *   (b) for gold missing from OCC's candidates but top-10 in BM25: does the
 *       task text overlap the file's INDEXED fields (symbol/path/io/summary/
 *       identifier — the exact fields invertedIndex.applyEntry indexes) or
 *       only body/comment/string text?
 *   (c) test-file gold: "tests" edge present in the entry? TEST_OF signal
 *       fired? tier assigned? score? — with counts and examples.
 *   (d) candidate-cap probe: the same task answered again with
 *       maxFiles=500 (candidateLimit ⇒ 1000) on the same persisted index;
 *       reports not-in-candidates and Recall@8 before/after.
 *
 * Output: .eval-cache/diagnostics/step0-<split>.json + console summary.
 * The JSON records the OCC commit and the working-tree-clean flag.
 *
 * Usage: npm run eval:diagnose [-- [--split tuning|eval] [--repos id1,id2]]
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

import { DEFAULT_CONFIG, OccApplication } from "../../src/application/contextService";
import { CancellationSource } from "../../src/shared/cancellation";
import { canonicalTerm, tokenizeIdentifier } from "../../src/shared/text";

import { bm25Baseline } from "./baselines";
import type { DatasetTask } from "./dataset";
import { cloneDirFor, materializeSnapshot, verifyPinnedCommit } from "./gitminer";
import { contentWords, isTestPath, tokenize } from "./lib";
import { recallAtK } from "./metrics";
import {
  buildTuningDataset,
  loadEvalDataset,
  loadReposFile,
  readSnapshot,
  type DatasetFile,
} from "./splitLoader";

const ROOT = path.resolve(import.meta.dirname ?? path.join(process.cwd()), "../..");
const SCRATCH_ROOT = path.join(ROOT, ".eval-cache", "diag");
const OUT_DIR = path.join(ROOT, ".eval-cache", "diagnostics");
const TOP_N = 8;
const BM25_HIGH_RANK = 10;
const BIG_CAP_MAX_FILES = 500;

type Stage =
  | "delivered"
  | "not-in-candidates"
  | "ranked-outside-top8"
  | "top8-not-packaged"
  | "packaged-metadata-only"
  | "security-withheld"
  | "not-indexed";
const STAGES: Stage[] = [
  "delivered",
  "not-in-candidates",
  "ranked-outside-top8",
  "top8-not-packaged",
  "packaged-metadata-only",
  "security-withheld",
  "not-indexed",
];

interface GoldRecord {
  task: string;
  repoId: string;
  path: string;
  isTest: boolean;
  stage: Stage;
  /** 1-based rank in OCC's untruncated ranking, null when absent. */
  occRank: number | null;
  /** 1-based rank under the widened candidate cap, null when absent. */
  occRankBigCap: number | null;
  tier: string | null;
  score: number | null;
  /** Mentioned in the payload's WHY section at all. */
  whyMentioned: boolean;
  /** "tests" naming-convention edge present in the indexed entry. */
  testsEdge: boolean;
  /** TEST_OF structural signal fired in the ranking (when ranked). */
  testOfSignal: boolean;
  /** Stage (b) field-overlap verdict for BM25-high misses. */
  fieldOverlap?: "indexed-overlap" | "body-only" | "neither" | "not-indexed";
}

function argSplit(): "eval" | "tuning" {
  const i = process.argv.indexOf("--split");
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  if (value === "eval") return "eval";
  if (value !== undefined && value !== "tuning") {
    console.error(`--split must be "tuning" or "eval" (got ${value})`);
    process.exit(1);
  }
  return "tuning";
}

/** The candidate-cap probe doubles runtime; skip it when not needed. */
const capProbe = !process.argv.includes("--no-cap-probe");

function argReposFilter(): string[] | undefined {
  const i = process.argv.indexOf("--repos");
  const value = i >= 0 ? process.argv[i + 1] : undefined;
  return value ? value.split(",").filter((s) => s.length > 0) : undefined;
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
    return execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" })
      .trim()
      .split(/\r?\n/)
      .every((l) => l.length === 0);
  } catch {
    return false;
  }
}

/** Parses the WHY section: path -> { notIncluded, tier, score, securityNote }. */
function parseWhySection(
  payload: string,
): Map<
  string,
  { notIncluded: boolean; tier: string | null; score: number | null; withheld: boolean }
> {
  const start = payload.indexOf("## WHY THESE FILES WERE SELECTED");
  const end = payload.indexOf("## SOURCE");
  const section = start >= 0 && end > start ? payload.slice(start, end) : "";
  const out = new Map<
    string,
    { notIncluded: boolean; tier: string | null; score: number | null; withheld: boolean }
  >();
  let current: string | null = null;
  for (const line of section.split(/\r?\n/)) {
    const m = /^### (.+?)( \[source not included\])?$/.exec(line);
    if (m) {
      current = m[1]!;
      out.set(current, {
        notIncluded: m[2] !== undefined,
        tier: null,
        score: null,
        withheld: false,
      });
      continue;
    }
    if (!current) continue;
    const entry = out.get(current)!;
    const tier = /^- Tier: (.+) \(score (-?[\d.]+)\)$/.exec(line);
    if (tier) {
      entry.tier = tier[1]!;
      entry.score = Number(tier[2]!);
    }
    if (/- Note: .*withheld by security policy/.test(line)) entry.withheld = true;
  }
  return out;
}

/** Paths rendered in ## SOURCE split into files with vs without source blocks. */
function parseSourceSections(payload: string): {
  withSource: Set<string>;
  metadataOnly: Set<string>;
} {
  const withSource = new Set<string>();
  const metadataOnly = new Set<string>();
  const matches = [...payload.matchAll(/^### FILE: (.+)$/gm)];
  for (let i = 0; i < matches.length; i++) {
    const from = (matches[i]!.index ?? 0) + matches[i]![0].length;
    const to = i + 1 < matches.length ? (matches[i + 1]!.index ?? payload.length) : payload.length;
    const body = payload.slice(from, to);
    (body.includes("### LINES:") ? withSource : metadataOnly).add(matches[i]![1]!);
  }
  return { withSource, metadataOnly };
}

/** Token set of the exact fields invertedIndex.applyEntry indexes for a file. */
function indexedFieldTokens(entry: {
  meta: { path: string };
  symbols: Array<{ name: string }>;
  imports: Array<{ importedNames: string[] }>;
  exports: Array<{ name: string }>;
  fileSummary?: string;
  identifiers?: string[];
}): Set<string> {
  const out = new Set<string>();
  const addText = (text: string): void => {
    for (const t of tokenizeIdentifier(text)) out.add(canonicalTerm(t) ?? t);
    const whole = canonicalTerm(text);
    if (whole) out.add(whole);
  };
  addText(entry.meta.path.replace(/[/_.]/g, " "));
  for (const sym of entry.symbols) addText(sym.name);
  for (const imp of entry.imports) for (const n of imp.importedNames) addText(n);
  for (const exp of entry.exports) addText(exp.name);
  if (entry.fileSummary) addText(entry.fileSummary);
  for (const id of entry.identifiers ?? []) addText(id);
  return out;
}

async function main(): Promise<void> {
  const split = argSplit();
  const filter = argReposFilter();
  const repos = loadReposFile();
  const dataset: DatasetFile =
    split === "tuning" ? buildTuningDataset(repos, filter) : loadEvalDataset();
  const tasks = filter ? dataset.tasks.filter((t) => filter.includes(t.repoId)) : dataset.tasks;
  const repoIds = [...new Set(tasks.map((t) => t.repoId))].sort();
  for (const repoId of repoIds) {
    const repo = repos.repos.find((r) => r.id === repoId);
    if (!repo) throw new Error(`repos.json has no entry for dataset repo ${repoId}`);
    verifyPinnedCommit(cloneDirFor(repoId), repo.pinnedCommit);
  }
  fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  console.log(
    `diagnose: split=${split} tasks=${tasks.length} commit=${occHeadCommit().slice(0, 12)} clean=${occWorkingTreeClean()}`,
  );

  const records: GoldRecord[] = [];
  const skippedTasks: Array<{ task: string; phase: string; error: string }> = [];
  const perTask: Array<{
    task: string;
    repoId: string;
    goldCount: number;
    rankedRecall8: number;
    packageRecall: number;
    bm25Recall8: number;
    rankedRecall8BigCap: number;
    goldNewlyInTop8BigCap: number;
    /** Step-0 (b): where the delivered package files came from. */
    pkgFromTop8: number;
    pkgRankedDeeper: number;
    pkgNotRanked: number;
    pkgMetadataOnly: number;
  }> = [];
  /** Step-0 (a): top-8-ranked gold that did not make the package, with why. */
  const top8Losses: Array<{
    task: string;
    repoId: string;
    path: string;
    rank: number;
    tier: string | null;
    reason: "not-in-payload" | "budget-degraded" | "security-withheld";
    /** Package slots taken by files ranked below this gold / not ranked at all. */
    displacedByLowerRanked: number;
    displacedByUnranked: number;
  }> = [];
  const fieldOverlapExamples: Array<{
    task: string;
    path: string;
    verdict: string;
    indexedTokens: string[];
    bodyOnlyTokens: string[];
  }> = [];
  // Per-task checkpoint: a stall or crash never costs more than one task.
  const checkpointFile = path.join(OUT_DIR, `step0-${split}.records.jsonl`);
  const doneTasks = new Set<string>();
  if (fs.existsSync(checkpointFile)) {
    const lines = fs.readFileSync(checkpointFile, "utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim().length === 0) continue;
      let c: {
        task: string;
        perTask: (typeof perTask)[number];
        records: GoldRecord[];
        skipped?: Array<{ task: string; phase: string; error: string }>;
      };
      try {
        c = JSON.parse(line);
      } catch {
        // A hard kill can truncate the final append. Only a TRAILING partial
        // line is tolerable (that task simply re-runs); corruption elsewhere
        // means the file is untrustworthy.
        const moreAfter = lines.slice(i + 1).some((l) => l.trim().length > 0);
        if (moreAfter) {
          throw new Error(
            `corrupt checkpoint line ${i + 1} in ${checkpointFile} — delete the file and start fresh`,
          );
        }
        console.warn("resuming: ignoring truncated final checkpoint line (task re-runs)");
        break;
      }
      doneTasks.add(c.task);
      perTask.push(c.perTask);
      records.push(...c.records);
      skippedTasks.push(...(c.skipped ?? []));
    }
    console.log(`resuming: ${doneTasks.size} tasks already checkpointed`);
  }

  const checkpoint = (
    t: DatasetTask,
    entry: (typeof perTask)[number] | null,
    taskRecords: GoldRecord[],
    skipped?: Array<{ task: string; phase: string; error: string }>,
  ): void => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(
      checkpointFile,
      `${JSON.stringify({ task: t.id, perTask: entry, records: taskRecords, skipped })}\n`,
    );
  };

  for (const repoId of repoIds) {
    for (const t of tasks.filter((x) => x.repoId === repoId) as DatasetTask[]) {
      if (doneTasks.has(t.id)) continue;
      const taskRecords: GoldRecord[] = [];
      const taskSkips: Array<{ task: string; phase: string; error: string }> = [];
      const clonePath = cloneDirFor(repoId);
      const snapKey = `diag-${repoId}-${t.sha.slice(0, 12)}`;
      const snapDir = materializeSnapshot(clonePath, t.parentSha, SCRATCH_ROOT, snapKey);
      const store = path.join(SCRATCH_ROOT, "store");
      const app = new OccApplication(snapDir, store);
      app.initialize();
      const indexResult = await app.indexing.indexWorkspace(CancellationSource.never());
      if (indexResult.cancelled || app.indexing.getEntries().size === 0) {
        console.error(`  ${t.id}: indexing produced no entries — skipping task`);
        const skipped = { task: t.id, phase: "index", error: "no entries" };
        skippedTasks.push(skipped);
        taskSkips.push(skipped);
        checkpoint(t, null, taskRecords, taskSkips);
        fs.rmSync(snapDir, { recursive: true, force: true });
        continue;
      }
      for (const g of t.gold) {
        if (!fs.statSync(path.join(snapDir, g), { throwIfNoEntry: false })?.isFile()) {
          throw new Error(`${t.id}: gold file missing from snapshot: ${g}`);
        }
      }

      let context: ReturnType<OccApplication["buildContext"]>;
      try {
        context = app.buildContext("task", { taskText: t.task });
      } catch (error) {
        // e.g. CONTEXT_BUDGET_UNREACHABLE when static sections alone exceed
        // the budget on very large snapshots — record and move on.
        const skipped = { task: t.id, phase: "build", error: (error as Error).message };
        skippedTasks.push(skipped);
        taskSkips.push(skipped);
        console.error(`  ${t.id}: SKIPPED (${skipped.error.slice(0, 90)})`);
        checkpoint(t, null, taskRecords, taskSkips);
        fs.rmSync(snapDir, { recursive: true, force: true });
        continue;
      }
      const ranked = context.retrieval?.ranked ?? [];
      const rankOf = new Map(ranked.map((r, i) => [r.path, i + 1] as const));
      const signalsOf = new Map(ranked.map((r) => [r.path, r.signals.map((s) => s.kind)] as const));
      const why = parseWhySection(context.payload);
      const source = parseSourceSections(context.payload);
      const snapshotMap = readSnapshot(snapDir);
      const bm25Ranking = bm25Baseline(snapshotMap, t.task).slice(0, TOP_N);
      const bm25RankOf = new Map(
        bm25Baseline(snapshotMap, t.task)
          .slice(0, 50)
          .map((r, i) => [r.path, i + 1] as const),
      );

      // (d) same persisted index, candidate limit widened via maxFiles.
      // Skippable (--no-cap-probe) when the probe is not needed.
      let bigRanked = ranked;
      let bigRankOf = rankOf;
      if (capProbe) {
        const appBig = new OccApplication(snapDir, store, {
          ...DEFAULT_CONFIG,
          maxFiles: BIG_CAP_MAX_FILES,
        });
        appBig.initialize();
        let bigContext: ReturnType<OccApplication["buildContext"]>;
        try {
          bigContext = appBig.buildContext("task", { taskText: t.task });
        } catch (error) {
          bigContext = context; // cap probe unavailable; fall back to normal ranking
          const skip = { task: t.id, phase: "build-bigcap", error: (error as Error).message };
          skippedTasks.push(skip);
          taskSkips.push(skip);
        }
        bigRanked = bigContext.retrieval?.ranked ?? [];
        bigRankOf = new Map(bigRanked.map((r, i) => [r.path, i + 1] as const));
      }

      const taskTokens = new Set(contentWords(t.task));
      let goldNewlyInTop8 = 0;
      for (const g of t.gold) {
        const entry = app.indexing.getEntries().get(g);
        const rank = rankOf.get(g) ?? null;
        const whyEntry = why.get(g);
        const testsEdge = entry?.internalRelations?.some((r) => r.kind === "tests") ?? false;
        const testOfSignal = signalsOf.get(g)?.includes("TEST_OF") ?? false;

        let stage: Stage;
        if (!entry) stage = "not-indexed";
        else if (whyEntry?.withheld) stage = "security-withheld";
        else if (source.withSource.has(g)) stage = "delivered";
        else if (rank === null) stage = "not-in-candidates";
        else if (rank > TOP_N) stage = "ranked-outside-top8";
        else if (whyEntry) stage = "packaged-metadata-only";
        else stage = "top8-not-packaged";

        const record: GoldRecord = {
          task: t.id,
          repoId,
          path: g,
          isTest: isTestPath(g),
          stage,
          occRank: rank,
          occRankBigCap: bigRankOf.get(g) ?? null,
          tier: whyEntry?.tier ?? null,
          score: whyEntry?.score ?? null,
          /** Mentioned in WHY even when ranked outside the top-8. */
          whyMentioned: whyEntry !== undefined,
          testsEdge,
          testOfSignal,
        };

        // (b) field overlap for BM25-high candidate-set misses.
        if (stage === "not-in-candidates" && (bm25RankOf.get(g) ?? 99) <= BM25_HIGH_RANK) {
          if (!entry) {
            record.fieldOverlap = "not-indexed";
          } else {
            const indexedTokens = indexedFieldTokens(entry);
            const body = snapshotMap.get(g) ?? "";
            const bodyTokens = new Set([...tokenize(body), ...tokenizeIdentifier(body)]);
            const hitIndexed = [...taskTokens].filter((w) => indexedTokens.has(w));
            const hitBodyOnly = [...taskTokens].filter(
              (w) => !indexedTokens.has(w) && bodyTokens.has(w),
            );
            record.fieldOverlap =
              hitIndexed.length > 0
                ? "indexed-overlap"
                : hitBodyOnly.length > 0
                  ? "body-only"
                  : "neither";
            if (fieldOverlapExamples.length < 8) {
              fieldOverlapExamples.push({
                task: t.id,
                path: g,
                verdict: record.fieldOverlap,
                indexedTokens: hitIndexed.slice(0, 5),
                bodyOnlyTokens: hitBodyOnly.slice(0, 5),
              });
            }
          }
        }
        if (rank === null || rank > TOP_N) {
          const bigRank = bigRankOf.get(g) ?? null;
          if (bigRank !== null && bigRank <= TOP_N) goldNewlyInTop8++;
        }
        // M3b Step-0 (a): top-8-ranked gold missing from the package — why,
        // and what took its slots.
        if (rank !== null && rank <= TOP_N && stage !== "delivered" && stage !== "not-indexed") {
          const reason =
            stage === "security-withheld"
              ? "security-withheld"
              : whyEntry
                ? "budget-degraded"
                : "not-in-payload";
          let lower = 0;
          let unranked = 0;
          for (const p of source.withSource) {
            const r = rankOf.get(p);
            if (r === undefined) unranked++;
            else if (r > rank) lower++;
          }
          top8Losses.push({
            task: t.id,
            repoId,
            path: g,
            rank,
            tier: whyEntry?.tier ?? null,
            reason,
            displacedByLowerRanked: lower,
            displacedByUnranked: unranked,
          });
        }
        records.push(record);
        taskRecords.push(record);
      }

      // M3b Step-0 (b): composition of the delivered package.
      let fromTop8 = 0;
      let rankedDeeper = 0;
      let notRanked = 0;
      for (const p of source.withSource) {
        const r = rankOf.get(p);
        if (r === undefined) notRanked++;
        else if (r <= TOP_N) fromTop8++;
        else rankedDeeper++;
      }

      const perTaskEntry = {
        task: t.id,
        repoId,
        goldCount: t.gold.length,
        rankedRecall8: recallAtK(
          ranked.map((r) => ({ path: r.path, score: r.score })),
          t.gold,
          TOP_N,
        ),
        packageRecall:
          t.gold.filter((g) => source.withSource.has(g)).length / Math.max(1, t.gold.length),
        bm25Recall8: recallAtK(bm25Ranking, t.gold, TOP_N),
        rankedRecall8BigCap: recallAtK(
          bigRanked.map((r) => ({ path: r.path, score: r.score })),
          t.gold,
          TOP_N,
        ),
        goldNewlyInTop8BigCap: goldNewlyInTop8,
        pkgFromTop8: fromTop8,
        pkgRankedDeeper: rankedDeeper,
        pkgNotRanked: notRanked,
        pkgMetadataOnly: source.metadataOnly.size,
      };
      perTask.push(perTaskEntry);
      checkpoint(t, perTaskEntry, taskRecords, taskSkips.length > 0 ? taskSkips : undefined);
      fs.rmSync(snapDir, { recursive: true, force: true });
      console.log(`  ${t.id}: done (${records.length} gold records)`);
    }
  }

  // ---- aggregates ----
  const stageLoss: Record<string, { all: number; test: number; nonTest: number }> = {};
  for (const s of STAGES) stageLoss[s] = { all: 0, test: 0, nonTest: 0 };
  for (const r of records) {
    stageLoss[r.stage]!.all++;
    stageLoss[r.stage]![r.isTest ? "test" : "nonTest"]++;
  }
  const mean = (xs: number[]): number =>
    xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const overlapCounts = { "indexed-overlap": 0, "body-only": 0, neither: 0, "not-indexed": 0 };
  for (const r of records) if (r.fieldOverlap) overlapCounts[r.fieldOverlap]++;
  const testGold = records.filter((r) => r.isTest);
  const testMissed = testGold.filter((r) => r.stage !== "delivered");
  const tierOfMissedTests: Record<string, number> = {};
  for (const r of testMissed) {
    const k = r.tier ?? "(no WHY entry)";
    tierOfMissedTests[k] = (tierOfMissedTests[k] ?? 0) + 1;
  }

  // ---- M3b Step-0 aggregates ----
  const composition = {
    meanFilesWithSource: mean(
      perTask.map((p) => p.pkgFromTop8 + p.pkgRankedDeeper + p.pkgNotRanked),
    ),
    meanFromTop8: mean(perTask.map((p) => p.pkgFromTop8)),
    meanRankedDeeper: mean(perTask.map((p) => p.pkgRankedDeeper)),
    meanNotRanked: mean(perTask.map((p) => p.pkgNotRanked)),
    meanMetadataOnly: mean(perTask.map((p) => p.pkgMetadataOnly)),
    packagesWithUnrankedFiles: perTask.filter((p) => p.pkgNotRanked > 0).length,
    packagesWithDeeperRanked: perTask.filter((p) => p.pkgRankedDeeper > 0).length,
    packagesWithTop8GoldMissed: perTask.filter((p) => p.rankedRecall8 > p.packageRecall).length,
  };
  const top8LossByReason: Record<string, number> = {};
  for (const l of top8Losses) top8LossByReason[l.reason] = (top8LossByReason[l.reason] ?? 0) + 1;
  const top8LossSummary = {
    total: top8Losses.length,
    byReason: top8LossByReason,
    meanDisplacedByLowerRanked: mean(top8Losses.map((l) => l.displacedByLowerRanked)),
    meanDisplacedByUnranked: mean(top8Losses.map((l) => l.displacedByUnranked)),
    examples: top8Losses.slice(0, 8),
  };
  const gapBucket = (
    keyOf: (p: (typeof perTask)[number]) => string,
  ): Record<string, { tasks: number; occRanked8: number; occPkg: number; bm25Top8: number }> => {
    const acc: Record<
      string,
      { tasks: number; occRanked8: number; occPkg: number; bm25Top8: number }
    > = {};
    for (const p of perTask) {
      const k = keyOf(p);
      const r = (acc[k] ??= { tasks: 0, occRanked8: 0, occPkg: 0, bm25Top8: 0 });
      r.tasks++;
      r.occRanked8 += p.rankedRecall8;
      r.occPkg += p.packageRecall;
      r.bm25Top8 += p.bm25Recall8;
    }
    for (const r of Object.values(acc)) {
      r.occRanked8 /= r.tasks;
      r.occPkg /= r.tasks;
      r.bm25Top8 /= r.tasks;
    }
    return Object.fromEntries(Object.entries(acc).sort(([a], [b]) => a.localeCompare(b)));
  };
  const gapByRepo = gapBucket((p) => p.repoId);
  const gapByGoldCount = gapBucket((p) =>
    p.goldCount === 1 ? "1" : p.goldCount === 2 ? "2" : p.goldCount === 3 ? "3" : "4+",
  );

  const out = {
    split,
    occCommit: occHeadCommit(),
    workingTreeClean: occWorkingTreeClean(),
    tasks: tasks.length,
    skippedTasks,
    goldFiles: records.length,
    stageLoss,
    recall: {
      rankedRecall8Mean: mean(perTask.map((p) => p.rankedRecall8)),
      packageRecallMean: mean(perTask.map((p) => p.packageRecall)),
      bm25Recall8Mean: mean(perTask.map((p) => p.bm25Recall8)),
      rankedRecall8BigCapMean: mean(perTask.map((p) => p.rankedRecall8BigCap)),
    },
    packageComposition: composition,
    top8Loss: top8LossSummary,
    gapByRepo,
    gapByGoldCount,
    candidateCap: {
      goldNotInCandidates: records.filter((r) => r.stage === "not-in-candidates").length,
      goldNotInCandidatesBigCap: records.filter((r) => r.occRankBigCap === null).length,
      goldNewlyInTop8BigCap: perTask.reduce((a, p) => a + p.goldNewlyInTop8BigCap, 0),
    },
    fieldOverlap: { counts: overlapCounts, examples: fieldOverlapExamples },
    testGold: {
      total: testGold.length,
      delivered: testGold.filter((r) => r.stage === "delivered").length,
      testsEdgePresent: testGold.filter((r) => r.testsEdge).length,
      testOfSignalFired: testGold.filter((r) => r.testOfSignal).length,
      tierOfMissed: tierOfMissedTests,
      missedExamples: testMissed.slice(0, 5).map((r) => ({
        task: r.task,
        path: r.path,
        stage: r.stage,
        occRank: r.occRank,
        tier: r.tier,
        score: r.score,
        testsEdge: r.testsEdge,
      })),
    },
    perTask,
    records,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `step0-${split}.json`);
  fs.writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);
  fs.rmSync(checkpointFile, { force: true }); // complete: a fresh run starts clean
  console.log(`\n=== Stage-loss (${records.length} gold files, ${tasks.length} tasks) ===`);
  for (const s of STAGES) {
    const row = stageLoss[s]!;
    console.log(
      `${s.padEnd(22)} ${String(row.all).padStart(4)}  (test ${row.test}, non-test ${row.nonTest})`,
    );
  }
  console.log(`\nranked Recall@8 mean: ${out.recall.rankedRecall8Mean.toFixed(3)}`);
  console.log(`package recall mean:  ${out.recall.packageRecallMean.toFixed(3)}`);
  console.log(`bm25 top-8 recall mean: ${out.recall.bm25Recall8Mean.toFixed(3)}`);
  console.log(
    `ranked Recall@8 with ${BIG_CAP_MAX_FILES}-maxFiles cap: ${out.recall.rankedRecall8BigCapMean.toFixed(3)}`,
  );
  console.log(`gold newly in top-8 under big cap: ${out.candidateCap.goldNewlyInTop8BigCap}`);
  console.log(
    `\npackage composition (mean per package): ${composition.meanFilesWithSource.toFixed(2)} files with source = top8 ${composition.meanFromTop8.toFixed(2)} + ranked-deeper ${composition.meanRankedDeeper.toFixed(2)} + not-ranked ${composition.meanNotRanked.toFixed(2)}; metadata-only ${composition.meanMetadataOnly.toFixed(2)}; packages with unranked files ${composition.packagesWithUnrankedFiles}/${perTask.length}, with deeper-ranked ${composition.packagesWithDeeperRanked}, with top8-gold missed ${composition.packagesWithTop8GoldMissed}`,
  );
  console.log(
    `top-8-ranked gold lost from package: ${top8LossSummary.total} (${JSON.stringify(top8LossByReason)}), mean displaced by lower-ranked ${top8LossSummary.meanDisplacedByLowerRanked.toFixed(2)} / unranked ${top8LossSummary.meanDisplacedByUnranked.toFixed(2)}`,
  );
  console.log(`\ngap by repo (occRanked8 / occPkg / bm25Top8):`);
  for (const [repo, g] of Object.entries(gapByRepo)) {
    console.log(
      `  ${repo.padEnd(8)} ${g.occRanked8.toFixed(3)} / ${g.occPkg.toFixed(3)} / ${g.bm25Top8.toFixed(3)}  (${g.tasks} tasks)`,
    );
  }
  console.log(`gap by gold-file count (occRanked8 / occPkg / bm25Top8):`);
  for (const [k, g] of Object.entries(gapByGoldCount)) {
    console.log(
      `  ${k.padEnd(8)} ${g.occRanked8.toFixed(3)} / ${g.occPkg.toFixed(3)} / ${g.bm25Top8.toFixed(3)}  (${g.tasks} tasks)`,
    );
  }
  console.log(`\nfield overlap (BM25-high candidate misses): ${JSON.stringify(overlapCounts)}`);
  for (const e of fieldOverlapExamples.slice(0, 4)) {
    console.log(
      `  ${e.task} ${e.path} -> ${e.verdict} indexed=[${e.indexedTokens}] bodyOnly=[${e.bodyOnlyTokens}]`,
    );
  }
  console.log(
    `\ntest gold: ${out.testGold.delivered}/${out.testGold.total} delivered; tests-edge ${out.testGold.testsEdgePresent}; TEST_OF fired ${out.testGold.testOfSignalFired}; tiers of missed: ${JSON.stringify(out.testGold.tierOfMissed)}`,
  );
  console.log(`written: ${outFile}`);
}

main().catch((error) => {
  console.error(`eval-diagnose failed: ${(error as Error).message}`);
  process.exit(1);
});
