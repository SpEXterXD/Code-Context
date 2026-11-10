/**
 * F12-corrected Git hazard reproduction (dev-time only, git-ignored cache).
 *
 * Each hazard is tested in its OWN fresh victim repo with ONLY that hazard
 * configured, and every measurement has POSITIVE CONTROLS (review fix):
 * - the hazard config + .gitattributes are committed as the BASELINE;
 * - the working file is then modified so the relevant diff is provably
 *   non-empty (asserted per command: exit 0 AND stdout length recorded);
 * - a marker-writing script records whether the hazard EXECUTED — a claim
 *   of "did not execute" is only meaningful after the raw control fired.
 * Every git invocation is awaited sequentially. Command forms per hazard:
 *   raw            — bare git (no mitigations)  [positive control]
 *   safeGit        — the production hardened spawn helper, plain diff
 *   collector form — the exact args the seed collector uses
 *
 * Hazards: diff.external, diff.<driver>.textconv, filter.<name>.clean+smudge.
 * Only harmless marker-writing scripts are configured. Documented residual
 * risk (see ADR-006): clean/smudge filters cannot be disabled by flags —
 * they are mitigated by the workspace-trust gate only.
 *
 * Usage: npm run eval:seed-hazard-repro
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import process from "node:process";

import { safeGit, SafeGitError } from "../../src/git/safeGit";

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), "..", "..");
const DIR = path.join(ROOT, ".eval-cache", "seed-hazard-repro");
const TIMEOUT_MS = 15000;

interface CommandResult {
  label: string;
  exit: number | string;
  stdoutLen: number;
  marker: boolean;
  stderr: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

interface HazardSpec {
  name: string;
  /** Configures ONLY this hazard BEFORE the baseline commit. */
  configurePreCommit: (victim: string, script: string) => void;
}

const HAZARDS: HazardSpec[] = [
  {
    name: "diff.external",
    configurePreCommit: (victim, script) => {
      execFileSync("git", ["config", "diff.external", `sh ${script}`], { cwd: victim });
    },
  },
  {
    name: "textconv",
    configurePreCommit: (victim, script) => {
      execFileSync("git", ["config", "diff.hazard.textconv", `sh ${script}`], { cwd: victim });
      fs.writeFileSync(path.join(victim, ".gitattributes"), "*.txt diff=hazard\n");
    },
  },
  {
    name: "clean/smudge filter",
    configurePreCommit: (victim, script) => {
      execFileSync("git", ["config", "filter.hazard.clean", `sh ${script} clean`], { cwd: victim });
      execFileSync("git", ["config", "filter.hazard.smudge", `sh ${script} smudge`], {
        cwd: victim,
      });
      fs.writeFileSync(path.join(victim, ".gitattributes"), "*.txt filter=hazard\n");
    },
  },
];

async function main(): Promise<void> {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  console.log(
    `${version} — hazards tested in isolated victim repos with positive controls under ${toPosix(DIR)}`,
  );

  const markerFile = path.join(DIR, "marker.txt");
  const markerScript = path.join(DIR, "hazard.sh");
  // The hazard script records execution AND passes content through, so the
  // clean/textconv drivers never neutralize the measured diff (an empty
  // filter output erases the file content and with it the positive control).
  fs.writeFileSync(
    markerScript,
    [
      "#!/bin/sh",
      `printf 'hazard invoked: %s\\n' "$*" >> "${toPosix(markerFile)}"`,
      'case "$1" in',
      "  clean|smudge) cat ;;",
      '  *) [ -f "$1" ] && cat "$1" ;;',
      "esac",
      "exit 0",
      "",
    ].join("\n"),
  );
  const markerScriptPosix = toPosix(markerScript);

  const commands: Array<{ label: string; args: string[] }> = [
    {
      label: "diff --no-ext-diff --no-textconv (collector form)",
      args: ["diff", "--no-ext-diff", "--no-textconv"],
    },
    { label: "safeGit plain diff", args: ["diff"] },
    { label: "raw plain diff (control)", args: ["diff"] },
  ];

  const results: CommandResult[] = [];
  let controlFailures = 0;

  for (const hazard of HAZARDS) {
    console.log(`\n== ${hazard.name} ==`);
    const victim = path.join(DIR, `victim-${hazard.name.replace(/[^a-z]/gi, "-")}`);
    execFileSync("git", ["init", "-q", "-b", "main", victim], { timeout: TIMEOUT_MS });
    const git = (args: string[]): string =>
      execFileSync("git", args, {
        cwd: victim,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        stdio: "pipe",
      });
    git(["config", "user.email", "repro@example.dev"]);
    git(["config", "user.name", "repro"]);
    // Hazard config + attributes land in the BASELINE commit (nothing is
    // staged after the measurement file changes — the flagged setup flaw).
    hazard.configurePreCommit(victim, markerScriptPosix);
    fs.mkdirSync(path.join(victim, "src"), { recursive: true });
    fs.writeFileSync(path.join(victim, "src", "a.txt"), "one\ntwo\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "baseline"]);
    // Confirmed working-tree change: the measured diff is non-empty.
    fs.writeFileSync(path.join(victim, "src", "a.txt"), "one\nTWO modified\n");

    // Positive control 1: a relevant diff EXISTS.
    const stat = git(["diff", "--stat"]);
    const relevantDiff = stat.trim().length > 0;
    if (!relevantDiff) controlFailures++;
    console.log(`  control: nonempty relevant diff = ${relevantDiff}`);

    for (const c of commands) {
      const raw = c.label.startsWith("raw");
      fs.rmSync(markerFile, { force: true });
      let exit: number | string = 0;
      let stdout = "";
      let stderr = "";
      try {
        if (raw) {
          stdout = git(c.args);
        } else {
          const r = await safeGit({ cwd: victim, args: c.args, timeoutMs: TIMEOUT_MS });
          stdout = r.stdout;
        }
      } catch (error) {
        exit = error instanceof SafeGitError ? (error.exitCode ?? "err") : "err";
        stderr = (error as Error).message.slice(0, 120);
      }
      const marker = fs.existsSync(markerFile);
      // Positive control 2: the RAW control command must succeed AND either
      // produce diff output or fire the marker (an external diff driver
      // REPLACES the diff text, so the marker is its positive signal).
      if (raw && (exit !== 0 || (stdout.length === 0 && !marker))) controlFailures++;
      results.push({
        label: c.label,
        exit,
        stdoutLen: stdout.length,
        marker,
        stderr,
      });
      console.log(
        `  ${marker ? "EXECUTED     " : "not executed "} | exit=${String(exit).padEnd(3)} | stdout=${String(stdout.length).padStart(6)}B | ${c.label}${stderr ? ` | ${stderr}` : ""}`,
      );
    }
    // Remove hazard config for a clean scratch state (repos stay for inspection).
    try {
      execFileSync("git", ["config", "--unset", "diff.external"], { cwd: victim });
    } catch {
      /* not set */
    }
    try {
      execFileSync("git", ["config", "--unset", "diff.hazard.textconv"], { cwd: victim });
    } catch {
      /* not set */
    }
    try {
      execFileSync("git", ["config", "--unset", "filter.hazard.clean"], { cwd: victim });
      execFileSync("git", ["config", "--unset", "filter.hazard.smudge"], { cwd: victim });
    } catch {
      /* not set */
    }
  }

  console.log(
    `\nPositive-control failures: ${controlFailures}` +
      `${controlFailures === 0 ? " (all controls fired)" : " — treat the run as INVALID"}`,
  );
  console.log(
    "\nExpected: the collector's exact form (diff --no-ext-diff --no-textconv) does not",
    "execute external diff drivers or textconv filters, and still returns the nonempty",
    "diff. Clean/smudge filters CAN still execute during diff operations even with those",
    "flags (no git flag disables them) — documented residual risk mitigated by the",
    "workspace-trust gate only (ADR-006). Platform: " + `${os.platform()} ${os.release()}.`,
  );
}

void main();
