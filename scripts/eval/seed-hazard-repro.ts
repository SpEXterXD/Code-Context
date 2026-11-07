/**
 * F12-corrected Git hazard reproduction (dev-time only, git-ignored cache).
 *
 * Each hazard is tested in its OWN fresh victim repo with ONLY that hazard
 * configured, so marker evidence attributes to the individual hazard.
 * Every git invocation is awaited sequentially; exit status and errors are
 * recorded. Three command forms are tested per hazard:
 *   raw            — bare git (no mitigations)
 *   safeGit        — the production hardened spawn helper
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
  marker: boolean;
  stderr: string;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function rawGit(args: string[], cwd: string): CommandResult {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", timeout: TIMEOUT_MS, stdio: "pipe" });
    return { label: args.join(" "), exit: 0, marker: false, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return {
      label: args.join(" "),
      exit: e.status ?? "err",
      marker: false,
      stderr: String(e.stderr ?? "").slice(0, 120),
    };
  }
}

interface HazardSpec {
  name: string;
  /** Configures ONLY this hazard in the victim repo. */
  configure: (victim: string, script: string) => void;
  /** Removes the hazard config and .gitattributes for a clean next test. */
  cleanup: (victim: string) => void;
}

const HAZARDS: HazardSpec[] = [
  {
    name: "diff.external",
    configure: (victim, script) => {
      execFileSync("git", ["config", "diff.external", `sh ${script}`], { cwd: victim });
    },
    cleanup: (victim) => {
      execFileSync("git", ["config", "--unset", "diff.external"], { cwd: victim });
    },
  },
  {
    name: "textconv",
    configure: (victim, script) => {
      execFileSync("git", ["config", "diff.hazard.textconv", `sh ${script}`], { cwd: victim });
      fs.writeFileSync(path.join(victim, ".gitattributes"), "*.txt diff=hazard\n");
      execFileSync("git", ["add", "-A"], { cwd: victim });
    },
    cleanup: (victim) => {
      execFileSync("git", ["config", "--unset", "diff.hazard.textconv"], { cwd: victim });
      fs.rmSync(path.join(victim, ".gitattributes"));
    },
  },
  {
    name: "clean/smudge filter",
    configure: (victim, script) => {
      execFileSync("git", ["config", "filter.hazard.clean", `sh ${script} clean`], { cwd: victim });
      execFileSync("git", ["config", "filter.hazard.smudge", `sh ${script} smudge`], {
        cwd: victim,
      });
      fs.writeFileSync(path.join(victim, ".gitattributes"), "*.txt filter=hazard\n");
      execFileSync("git", ["add", "-A"], { cwd: victim });
    },
    cleanup: (victim) => {
      execFileSync("git", ["config", "--unset", "filter.hazard.clean"], { cwd: victim });
      execFileSync("git", ["config", "--unset", "filter.hazard.smudge"], { cwd: victim });
      fs.rmSync(path.join(victim, ".gitattributes"));
    },
  },
];

async function main(): Promise<void> {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });
  const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  console.log(`${version} — hazards tested in isolated victim repos under ${toPosix(DIR)}`);

  const markerFile = path.join(DIR, "marker.txt");
  const markerScript = path.join(DIR, "hazard.sh");
  fs.writeFileSync(
    markerScript,
    [
      "#!/bin/sh",
      `printf 'hazard invoked: %s\\n' "$*" >> "${toPosix(markerFile)}"`,
      "exit 0",
      "",
    ].join("\n"),
  );
  const markerScriptPosix = toPosix(markerScript);

  const commands: Array<{ label: string; args: string[] }> = [
    { label: "status --porcelain=v1 -z", args: ["status", "--porcelain=v1", "-z"] },
    { label: "diff (plain)", args: ["diff"] },
    {
      label: "diff --no-ext-diff --no-textconv (collector form)",
      args: ["diff", "--no-ext-diff", "--no-textconv"],
    },
  ];

  const results: Array<{
    hazard: string;
    label: string;
    exit: number | string;
    marker: boolean;
    stderr: string;
  }> = [];

  for (const hazard of HAZARDS) {
    console.log(`\n== ${hazard.name} ==`);
    const victim = path.join(DIR, `victim-${hazard.name.replace(/[^a-z]/gi, "-")}`);
    // Fresh victim repo per hazard: attribution is unambiguous.
    execFileSync("git", ["init", "-q", "-b", "main", victim], { timeout: TIMEOUT_MS });
    const git = (args: string[]): void => {
      execFileSync("git", args, {
        cwd: victim,
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        stdio: "pipe",
      });
    };
    git(["config", "user.email", "repro@example.dev"]);
    git(["config", "user.name", "repro"]);
    fs.mkdirSync(path.join(victim, "src"), { recursive: true });
    fs.writeFileSync(path.join(victim, "src", "a.txt"), "one\ntwo\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);
    fs.writeFileSync(path.join(victim, "src", "a.txt"), "one\nTWO modified\n");
    hazard.configure(victim, markerScriptPosix);

    for (const c of commands) {
      // raw git
      fs.rmSync(markerFile, { force: true });
      const rawResult = rawGit(c.args, victim);
      const rawMarker = fs.existsSync(markerFile);
      results.push({
        hazard: hazard.name,
        label: `raw: ${c.label}`,
        exit: rawResult.exit,
        marker: rawMarker,
        stderr: rawResult.stderr,
      });

      // safeGit (production helper) — properly awaited
      fs.rmSync(markerFile, { force: true });
      let exit: number | string = 0;
      let stderr = "";
      try {
        await safeGit({ cwd: victim, args: c.args, timeoutMs: TIMEOUT_MS });
      } catch (error) {
        exit = error instanceof SafeGitError ? (error.exitCode ?? "err") : "err";
        stderr = (error as Error).message.slice(0, 120);
      }
      results.push({
        hazard: hazard.name,
        label: `safeGit: ${c.label}`,
        exit,
        marker: fs.existsSync(markerFile),
        stderr,
      });
    }
    hazard.cleanup(victim);
  }

  console.log("\nResults (EXECUTED = the hazard script wrote the marker):");
  let hazard = "";
  for (const r of results) {
    if (r.hazard !== hazard) {
      hazard = r.hazard;
      console.log(`\n  -- ${hazard} --`);
    }
    console.log(
      `  ${r.marker ? "EXECUTED     " : "not executed "} | exit=${String(r.exit).padEnd(3)} | ${r.label}${r.stderr ? ` | ${r.stderr}` : ""}`,
    );
  }
  console.log(
    "\nExpected: the collector's exact form (diff --no-ext-diff --no-textconv) does not",
    "execute external diff drivers or textconv filters. Clean/smudge filters CAN still",
    "execute during diff operations even with those flags (no git flag disables them) —",
    "documented residual risk mitigated by the workspace-trust gate only (ADR-006).",
  );
}

void main();
