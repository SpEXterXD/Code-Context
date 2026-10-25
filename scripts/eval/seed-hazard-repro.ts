/**
 * M4 git-hazard reproduction (dev-time only, git-ignored cache): proves
 * which repo-configured code EXECUTES for the invocations the seed
 * collector makes, raw vs through the hardened safeGit helper.
 *
 * Hazards (each configured to append to a marker file):
 *   - diff.external        (git-config(1): external diff driver command)
 *   - diff.<driver>.textconv (git-config(1): textconv filter command)
 *   - filter.<name>.clean / .smudge (git-config(1): clean/smudge filters)
 *
 * For each hazard, runs `status --porcelain=v1 -z` and
 * `diff --no-ext-diff --no-textconv` (the collector's exact diff form) plus
 * a PLAIN `diff` (no flags) — raw and via safeGit — and reports whether the
 * marker appeared. Usage: npm run eval:seed-hazard-repro
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { safeGit } from "../../src/git/safeGit";

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), "..", "..");
const DIR = path.join(ROOT, ".eval-cache", "seed-hazard-repro");
const VICTIM = path.join(DIR, "victim");
const MARKER = path.join(DIR, "marker.txt");
const SCRIPT = path.join(DIR, "hazard.sh");

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function rawGit(args: string[], cwd: string): { exit: number | string; stderr: string } {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15000, stdio: "pipe" });
    return { exit: 0, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return { exit: e.status ?? "err", stderr: String(e.stderr ?? "").slice(0, 100) };
  }
}

function markerClearedRun(
  label: string,
  run: () => void,
): { label: string; marker: boolean; note: string } {
  fs.rmSync(MARKER, { force: true });
  let note = "";
  try {
    run();
  } catch (error) {
    note = (error as Error).message.slice(0, 90);
  }
  return { label, marker: fs.existsSync(MARKER), note };
}

async function main(): Promise<void> {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  // Victim repo: one tracked file, one committed + one modified so diffs exist.
  rawGit(["init", "-q", "-b", "main", "victim"], DIR);
  rawGit(["config", "user.email", "repro@example.dev"], VICTIM);
  rawGit(["config", "user.name", "repro"], VICTIM);
  fs.mkdirSync(path.join(VICTIM, "src"), { recursive: true });
  fs.writeFileSync(path.join(VICTIM, "src", "a.txt"), "one\ntwo\n");
  rawGit(["add", "-A"], VICTIM);
  rawGit(["commit", "-q", "-m", "init"], VICTIM);
  fs.writeFileSync(path.join(VICTIM, "src", "a.txt"), "one\nTWO modified\n");

  // The hazard script: records every invocation (any command would do).
  fs.writeFileSync(
    SCRIPT,
    ["#!/bin/sh", `printf 'hazard invoked: %s\\n' "$*" >> "${toPosix(MARKER)}"`, "exit 0", ""].join(
      "\n",
    ),
  );
  rawGit(["config", "diff.external", `sh ${toPosix(SCRIPT)}`], VICTIM);
  rawGit(["config", "diff.marker.textconv", `sh ${toPosix(SCRIPT)}`], VICTIM);
  rawGit(["config", "filter.marker.clean", `sh ${toPosix(SCRIPT)} clean`], VICTIM);
  rawGit(["config", "filter.marker.smudge", `sh ${toPosix(SCRIPT)} smudge`], VICTIM);
  fs.writeFileSync(path.join(VICTIM, ".gitattributes"), "*.txt diff=marker filter=marker\n");
  rawGit(["add", "-A"], VICTIM);

  const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  console.log(`${version} — victim at ${toPosix(VICTIM)}`);
  console.log("each hazard command is run with the marker removed first\n");

  const commands: Array<{ label: string; args: string[] }> = [
    { label: "status --porcelain=v1 -z", args: ["status", "--porcelain=v1", "-z"] },
    { label: "diff (plain)", args: ["diff"] },
    { label: "diff --no-ext-diff --no-textconv", args: ["diff", "--no-ext-diff", "--no-textconv"] },
  ];

  const results: Array<{ hazard: string; label: string; marker: boolean; note: string }> = [];
  const hazards = ["diff.external", "textconv", "clean/smudge"];
  for (const hazard of hazards) {
    for (const c of commands) {
      results.push({
        hazard,
        ...markerClearedRun(`raw: ${c.label}`, () => {
          rawGit(c.args, VICTIM);
        }),
      });
      results.push({
        hazard,
        ...markerClearedRun(`safeGit: ${c.label}`, () => {
          const attempt = safeGit({ cwd: VICTIM, args: c.args, timeoutMs: 15000 });
          void attempt;
        }),
      });
    }
  }

  let hazard = "";
  for (const r of results) {
    if (r.hazard !== hazard) {
      hazard = r.hazard;
      console.log(`\n== ${hazard} ==`);
    }
    console.log(
      `${r.marker ? "EXECUTED" : "not executed"} | ${r.label}${r.note ? ` | ${r.note}` : ""}`,
    );
  }
  console.log(
    "\nReading the rows: the seed collector's exact form is 'diff --no-ext-diff --no-textconv' —",
    "those two flags are the mitigation and must show 'not executed' even raw. A PLAIN raw diff",
    "executes repo-configured code (proving the hazard is real). safeGit's global flags (fsmonitor",
    "off, empty hooksPath, no ext transport) do NOT cover diff.external/textconv by themselves — a",
    "plain diff through safeGit may still execute them; production never issues one (the collector",
    "always passes the flags), the feature is trust-gated, and a test asserts untrusted workspaces",
    "never reach the collector.",
  );
}

void main();
