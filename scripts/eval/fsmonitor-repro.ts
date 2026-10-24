/**
 * Reproduction (not citation) of the untrusted-workspace git-config risk.
 * Dev-time only; everything lives under the git-ignored
 * .eval-cache/fsmonitor-repro/. Creates a throwaway repo whose .git/config
 * points core.fsmonitor at a shell script that appends to a marker file,
 * then runs the EXACT OCC git invocation (src/git/gitMetadata.ts:
 * `git log --name-only --pretty=format:__COMMIT__%ct` via execFileSync with
 * cwd=rootPath), plus `git status` and `git diff --name-only`, and reports
 * whether the marker file appeared per command. Each command is repeated
 * with the proposed mitigation (`-c core.fsmonitor=false`) as a control.
 *
 * Usage: npm run eval:fsmonitor-repro
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import process from "node:process";

const ROOT = path.resolve(import.meta.dirname ?? process.cwd(), "..", "..");
const DIR = path.join(ROOT, ".eval-cache", "fsmonitor-repro");
const VICTIM = path.join(DIR, "victim");
const HOOK = path.join(DIR, "fsmonitor-hook.sh");
const MARKER = path.join(DIR, "marker.txt");

function git(args: string[], cwd = VICTIM): { ok: boolean; exit: number | string; stderr: string } {
  try {
    execFileSync("git", args, { cwd, encoding: "utf8", timeout: 15000, stdio: "pipe" });
    return { ok: true, exit: 0, stderr: "" };
  } catch (error) {
    const e = error as { status?: number; stderr?: string };
    return { ok: false, exit: e.status ?? "signal/none", stderr: String(e.stderr ?? "").trim() };
  }
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

interface CommandResult {
  label: string;
  args: string[];
  mitigated: boolean;
  exit: number | string;
  markerAppeared: boolean;
  stderr: string;
}

function runOnce(label: string, args: string[], mitigated: boolean): CommandResult {
  fs.rmSync(MARKER, { force: true });
  const full = mitigated ? ["-c", "core.fsmonitor=false", ...args] : args;
  const r = git(full);
  return {
    label,
    args: full,
    mitigated,
    exit: r.exit,
    markerAppeared: fs.existsSync(MARKER),
    stderr: r.stderr.split(/\r?\n/)[0]?.slice(0, 120) ?? "",
  };
}

function main(): void {
  fs.rmSync(DIR, { recursive: true, force: true });
  fs.mkdirSync(DIR, { recursive: true });

  // Throwaway repo with one commit.
  git(["init", "-q", "-b", "main", "victim"], DIR);
  git(["config", "user.email", "repro@example.dev"]);
  git(["config", "user.name", "repro"]);
  fs.mkdirSync(path.join(VICTIM, "src"), { recursive: true });
  fs.writeFileSync(path.join(VICTIM, "src", "a.ts"), "export const a = 1;\n");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "init"]);

  // The "malicious" fsmonitor: repo-controlled config pointing at a script
  // that records its invocation. This is exactly the attacker-controlled
  // core.fsmonitor scenario (any command string would do).
  fs.writeFileSync(
    HOOK,
    [
      "#!/bin/sh",
      `printf 'fsmonitor invoked with: %s\\n' "$*" >> "${toPosix(MARKER)}"`,
      "exit 0",
      "",
    ].join("\n"),
  );
  git(["config", "core.fsmonitor", `sh ${toPosix(HOOK)}`]);

  const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
  const commands: Array<{ label: string; args: string[] }> = [
    {
      label: "git log (OCC's exact invocation)",
      args: ["log", "--name-only", "--pretty=format:__COMMIT__%ct"],
    },
    { label: "git status", args: ["status"] },
    { label: "git diff --name-only", args: ["diff", "--name-only"] },
  ];

  console.log(`${version} — victim repo at ${toPosix(VICTIM)}`);
  console.log("core.fsmonitor -> marker-writing script; marker removed before each command\n");
  const rows: CommandResult[] = [];
  for (const c of commands) {
    rows.push(runOnce(c.label, c.args, false));
  }
  for (const c of commands) {
    rows.push(runOnce(`${c.label} + mitigation`, c.args, true));
  }

  for (const r of rows) {
    console.log(
      `${r.markerAppeared ? "MARKER WRITTEN" : "no marker     "} | exit=${String(r.exit).padEnd(3)} | ${r.label}${r.mitigated ? "" : " (raw)"}${r.stderr ? ` | stderr: ${r.stderr}` : ""}`,
    );
  }
  console.log(
    "\nMitigation column: same commands prefixed with -c core.fsmonitor=false; marker must never appear there.",
  );
}

main();
