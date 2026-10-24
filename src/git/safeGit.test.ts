import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { SafeGitError, safeGit, safeGitFlags } from "./safeGit";
import { GitMetadata, parseRecencyLog } from "./gitMetadata";

describe("safeGit guard: single spawn point", () => {
  it("fails when any src file outside safeGit.ts imports child_process", () => {
    const root = path.resolve(__dirname, "..", "..");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const name of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, name.name);
        if (name.isDirectory()) {
          walk(full);
          continue;
        }
        if (!name.name.endsWith(".ts") || name.name.endsWith(".test.ts")) continue;
        const rel = path.relative(root, full).split(path.sep).join("/");
        if (rel === "src/git/safeGit.ts") continue;
        const text = fs.readFileSync(full, "utf8");
        if (/from "(?:node:)?child_process"|require\("(?:node:)?child_process"\)/.test(text)) {
          offenders.push(rel);
        }
      }
    };
    walk(path.join(root, "src"));
    expect(offenders).toEqual([]);
  });
});

describe("safeGit hardening flags", () => {
  it("prepends exactly the documented hardening flags, hooks dir present and empty", () => {
    const flags = safeGitFlags();
    expect(flags.slice(0, 2)).toEqual(["-c", "core.fsmonitor=false"]);
    expect(flags).toContain("gc.auto=0");
    expect(flags).toContain("core.pager=cat");
    expect(flags).toContain("protocol.ext.allow=never");
    const hooksIdx = flags.findIndex((f) => f.startsWith("core.hooksPath="));
    expect(hooksIdx).toBeGreaterThan(0);
    const hooksDir = flags[hooksIdx]!.slice("core.hooksPath=".length);
    expect(fs.existsSync(hooksDir)).toBe(true);
    expect(fs.readdirSync(hooksDir)).toEqual([]); // no hook can be found there
    expect(flags.filter((f) => f === "-c")).toHaveLength(5);
  });

  it("runs git (async, args array) and reports version", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "safegit-ok-"));
    try {
      const { stdout } = await safeGit({ cwd, args: ["--version"], timeoutMs: 15000 });
      expect(stdout).toMatch(/^git version \d+/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects with SafeGitError (never throws sync) outside a repo", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "safegit-fail-"));
    try {
      const attempt = safeGit({ cwd, args: ["log", "--name-only"], timeoutMs: 15000 });
      await expect(attempt).rejects.toBeInstanceOf(SafeGitError);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("GitMetadata (async prefetch, cache-only reads)", () => {
  it("recencyOrderSync never spawns and is empty without a refresh", () => {
    const git = new GitMetadata();
    expect(git.recencyOrderSync("/nonexistent-root")).toEqual([]);
  });

  it("refreshes from a real temp repo through safeGit and serves the cache", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "safegit-repo-"));
    try {
      const run = async (args: string[]): Promise<void> => {
        await safeGit({ cwd, args, timeoutMs: 15000 });
      };
      await run(["init", "-q", "-b", "main", "."]);
      await run(["config", "user.email", "t@example.dev"]);
      await run(["config", "user.name", "t"]);
      fs.writeFileSync(path.join(cwd, "older.ts"), "export const a = 1;\n");
      await run(["add", "-A"]);
      await run(["commit", "-q", "-m", "older"]);
      await new Promise((r) => setTimeout(r, 1100)); // distinct commit times
      fs.writeFileSync(path.join(cwd, "newer.ts"), "export const b = 2;\n");
      await run(["add", "-A"]);
      await run(["commit", "-q", "-m", "newer"]);

      const git = new GitMetadata();
      await git.refreshRecencyOrder(cwd);
      const order = git.recencyOrderSync(cwd);
      expect(order[0]).toBe("newer.ts");
      expect(order).toContain("older.ts");
      // Different root: cache is per-workspace, never spawns, returns [].
      expect(git.recencyOrderSync(path.join(cwd, "sub"))).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("fails soft: refresh resolves and leaves the cache empty when git fails", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "safegit-norepo-"));
    try {
      const git = new GitMetadata();
      await expect(git.refreshRecencyOrder(cwd)).resolves.toBeUndefined();
      expect(git.recencyOrderSync(cwd)).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("parseRecencyLog", () => {
  it("orders paths newest-commit-first and keeps first-seen commit per path", () => {
    const log = [
      "__COMMIT__200",
      "b.ts",
      "__COMMIT__100",
      "a.ts",
      "b.ts", // second appearance ignored
      "",
    ].join("\n");
    expect(parseRecencyLog(log)).toEqual(["b.ts", "a.ts"]);
  });

  it("normalizes separators to posix", () => {
    expect(parseRecencyLog("__COMMIT__5\r\nsrc\\win\\path.ts\r\n")).toEqual(["src/win/path.ts"]);
    expect(parseRecencyLog("")).toEqual([]);
  });
});
