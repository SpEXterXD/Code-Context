import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * The ONLY place in src/ that spawns git (enforced by safeGit.test.ts, which
 * fails when any other src file imports child_process). Every invocation:
 *
 *   - uses execFile with an args array — never a shell string, so repo-
 *     controlled paths/branches cannot inject shell syntax;
 *   - passes hardening flags that make repo-side configuration inert:
 *       core.fsmonitor=false      no repo-configured fsmonitor executable
 *                                 (git-config(1): core.fsmonitor may name a
 *                                 hook-like command; false disables it —
 *                                 empirically verified by
 *                                 npm run eval:fsmonitor-repro);
 *       core.hooksPath=<empty dir>git looks for hooks ONLY there
 *                                 (git-config(1): core.hooksPath overrides
 *                                 $GIT_DIR/hooks), so no repo hook can run;
 *                                 empirically verified: a planted pre-commit
 *                                 hook does not fire through the helper;
 *       gc.auto=0                 no `git gc --auto` maintenance is
 *                                 triggered by our read-only commands
 *                                 (git-config(1): gc.auto, "0 disables");
 *       core.pager=cat            output is piped anyway (non-TTY disables
 *                                 the pager), this makes it explicit
 *                                 (git-config(1): core.pager);
 *       protocol.ext.allow=never  the ext:: transport can execute arbitrary
 *                                 commands (git-remote-ext(1)); "never"
 *                                 forbids it (git-config(1):
 *                                 protocol.<name>.allow) — empirically
 *                                 verified: `git ls-remote ext::...` is
 *                                 refused through the helper;
 *   - sets GIT_OPTIONAL_LOCKS=0 (git(1): avoid taking optional locks, e.g.
 *     the index lock during refresh) and GIT_TERMINAL_PROMPT=0 (git(1):
 *     never prompt — fail instead of hanging the extension host);
 *   - always applies a timeout.
 *
 * All flags were checked against the locally installed git's documentation
 * (git help config / git help git / git help git-remote-ext, git 2.53)
 * and verified empirically where a behavior is observable (fsmonitor,
 * hooksPath, protocol.ext — see the repro script and safeGit.test.ts).
 * A flag that could NOT be verified would be dropped rather than shipped.
 */

export interface SafeGitOptions {
  /** Working directory (the workspace root or a temp git repo). */
  cwd: string;
  /** Git arguments WITHOUT the hardening flags (e.g. ["log", "--name-only"]). */
  args: string[];
  /** Hard kill limit in ms (default 15 s, as the recency feature allowed). */
  timeoutMs?: number;
  maxBufferBytes?: number;
}

export interface SafeGitResult {
  stdout: string;
  stderr: string;
}

export class SafeGitError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "SafeGitError";
  }
}

/** An empty, stable directory: core.hooksPath pointing here finds no hooks. */
let emptyHooksDir: string | null = null;
function ensureEmptyHooksDir(): string {
  if (emptyHooksDir === null) {
    emptyHooksDir = path.join(os.tmpdir(), "occ-git-empty-hooks");
    fs.mkdirSync(emptyHooksDir, { recursive: true });
  }
  return emptyHooksDir;
}

/** Hardening flags prepended to EVERY git invocation. Exported for tests. */
export function safeGitFlags(): string[] {
  return [
    "-c",
    "core.fsmonitor=false",
    "-c",
    `core.hooksPath=${ensureEmptyHooksDir()}`,
    "-c",
    "gc.auto=0",
    "-c",
    "core.pager=cat",
    "-c",
    "protocol.ext.allow=never",
  ];
}

/**
 * Runs git with the hardening flags. Resolves with stdout/stderr; rejects
 * with SafeGitError on non-zero exit, spawn failure, or timeout. Never
 * throws synchronously; never writes to the workspace.
 */
export function safeGit(options: SafeGitOptions): Promise<SafeGitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      [...safeGitFlags(), ...options.args],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs ?? 15000,
        maxBuffer: options.maxBufferBytes ?? 64 * 1024 * 1024,
        encoding: "utf8",
        windowsHide: true,
        env: {
          ...process.env,
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(
            new SafeGitError(
              `git ${options.args.join(" ")} failed: ${error.message}`,
              typeof (error as { code?: unknown }).code === "number"
                ? ((error as { code: number }).code as number)
                : null,
              String(stderr ?? ""),
            ),
          );
          return;
        }
        resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}
