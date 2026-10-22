import { describe, expect, it } from "vitest";

import {
  cleanTaskText,
  filterCommit,
  hashString,
  isBotAuthor,
  isCiConfigPath,
  isDocsPath,
  isLockFilePath,
  isSourcePath,
  isTestPath,
  mulberry32,
  pathTokens,
  sampleEvalCommits,
  tokenize,
  wordCount,
  type TouchedFile,
} from "./lib";

function touched(status: TouchedFile["status"], pre: string, post = pre, renameScore?: number): TouchedFile {
  return { status, prePath: pre, postPath: post, renameScore };
}

describe("tokenize / pathTokens", () => {
  it("splits camelCase, kebab, snake and dotted identifiers into lowercase tokens", () => {
    expect(tokenize("parseJSONArray_v2")).toEqual(["parse", "json", "array", "v2"]);
    expect(pathTokens("src/router/middleware/rateLimit.ts")).toEqual(["router", "middleware", "rate", "limit"]);
  });
});

describe("cleanTaskText", () => {
  it("strips trailers, co-authored-by, URLs and issue references", () => {
    const task = cleanTaskText(
      "fix(router): normalize trailing slashes (#1234)",
      "The router treated `/a/` and `/a` differently.\n\nCo-authored-by: X <x@example.com>\nSigned-off-by: Y <y@y.dev>\nFixes: https://github.com/repo/issues/999\n",
    );
    expect(task).not.toContain("Co-authored");
    expect(task).not.toContain("Signed-off");
    expect(task).not.toContain("http");
    expect(task).not.toContain("#1234");
    expect(task).toContain("normalize trailing slashes");
    expect(task).toContain("treated");
  });
});

describe("path classification", () => {
  it("distinguishes tests, sources, locks, docs, ci", () => {
    expect(isTestPath("src/router.test.ts")).toBe(true);
    expect(isTestPath("tests/e2e/login.spec.ts")).toBe(true);
    expect(isTestPath("src/router.ts")).toBe(false);
    expect(isTestPath("__tests__/setup.ts")).toBe(true);
    for (const lock of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]) {
      expect(isLockFilePath(lock)).toBe(true);
    }
    expect(isLockFilePath("package.json")).toBe(false);
    expect(isDocsPath("README.md")).toBe(true);
    expect(isDocsPath("docs/adr/001.md")).toBe(true);
    expect(isDocsPath("src/index.ts")).toBe(false);
    expect(isCiConfigPath(".github/workflows/ci.yml")).toBe(true);
    expect(isCiConfigPath("tsconfig.json")).toBe(true);
    expect(isCiConfigPath("src/index.ts")).toBe(false);
  });

  it("sources are TS/JS production files (no tests, no .d.ts)", () => {
    expect(isSourcePath("src/auth.ts")).toBe(true);
    expect(isSourcePath("src/parser.d.ts")).toBe(false);
    expect(isSourcePath("src/auth.test.ts")).toBe(false);
    expect(isSourcePath("package.json")).toBe(false);
    expect(isSourcePath("zod/src/types/string.ts")).toBe(true);
  });
});

describe("isBotAuthor", () => {
  it("detects commonautomation accounts", () => {
    expect(isBotAuthor("dependabot[bot]", "noreply@github.com")).toBe(true);
    expect(isBotAuthor("Ada", "ada@example.dev")).toBe(false);
    expect(isBotAuthor("github-actions", "actions@github.com")).toBe(true);
  });
});

describe("filterCommit", () => {
  const base = {
    sha: "abc123",
    parentCount: 1,
    authorName: "Ada",
    authorEmail: "ada@example.dev",
    subject: "fix auth: handle empty session id",
    body: "",
  };

  it("accepts a normal 2-file fix with source gold, excluding new files from gold", () => {
    const result = filterCommit({ ...base, files: [touched("M", "src/auth.ts"), touched("A", "src/auth/new.ts")] });
    expect(result.ok).toBe(true);
    expect(result.gold).toEqual(["src/auth.ts"]);
    expect(result.excludedNewFiles).toBe(1);
  });

  it("maps renames to their pre-commit path and keeps deletions", () => {
    const result = filterCommit({
      ...base,
      files: [touched("R100", "src/old.ts", "src/new.ts", 95), touched("D", "src/dead.ts")],
    });
    expect(result.ok).toBe(true);
    expect(result.gold).toEqual(["src/dead.ts", "src/old.ts"]);
  });

  it("rejects merges, bots, tiny/huge task text, wrong file counts", () => {
    expect(filterCommit({ ...base, parentCount: 2, files: [touched("M", "a.ts")] }).reason).toBe("merge-commit");
    expect(
      filterCommit({ ...base, authorName: "Renovate Bot", files: [touched("M", "a.ts")] }).reason,
    ).toBe("bot-author");
    expect(
      filterCommit({ ...base, subject: "fix typo", files: [touched("M", "a.ts")] }).reason,
    ).toBe("task-too-short");
    const longSubject = "fix ".concat(Array.from({ length: 250 }, () => "word").join(" "));
    expect(
      filterCommit({ ...base, subject: longSubject, files: [touched("M", "a.ts")] }).reason,
    ).toBe("task-too-long");
    expect(filterCommit({ ...base, files: [] }).reason).toBe("file-count");
    expect(
      filterCommit({ ...base, files: Array.from({ length: 9 }, (_, i) => touched("M", `s${i}.ts`)) }).reason,
      ("file-count" as unknown),
    ).toBe("file-count");
  });

  it("rejects pure renames, reverts, version bumps, lock/docs-only and no-source commits", () => {
    expect(
      filterCommit({ ...base, files: [touched("R100", "a.ts", "b.ts", 100)] }).reason,
    ).toBe("pure-rename");
    expect(
      filterCommit({ ...base, subject: "Revert previous change", files: [touched("M", "a.ts")] }).reason,
    ).toBe("revert");
    expect(
      filterCommit({
        ...base,
        subject: "chore: release 1.2.0",
        files: [touched("M", "package.json"), touched("M", "package-lock.json")],
      }).reason,
    ).toBe("version-bump");
    expect(
      filterCommit({ ...base, files: [touched("M", "package-lock.json")] }).reason,
    ).toBe("lockfile-only");
    expect(
      filterCommit({ ...base, subject: "docs: update guide", files: [touched("M", "GUIDE.md")] }).reason,
    ).toBe("docs-only");
    expect(
      filterCommit({ ...base, files: [touched("M", ".github/workflows/ci.yml")] }).reason,
    ).toBe("ci-only");
  });

  it("keeps mixed commits that touch real code plus config", () => {
    const result = filterCommit({
      ...base,
      subject: "feat: bump cache limit and document it",
      files: [touched("M", "src/cache.ts"), touched("M", "README.md")],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects commits whose gold is not localizable (all new files)", () => {
    const result = filterCommit({
      ...base,
      subject: "feat: add new module",
      files: [touched("A", "src/new.ts"), touched("A", "src/other.ts")],
    });
    expect(result.reason).toBe("no-localizable-gold");
  });
});

describe("deterministic sampling", () => {
  function commits(n: number): { sha: string; parentSha: string; committerTime: number }[] {
    return Array.from({ length: n }, (_, i) => ({
      sha: `sha-${i.toString().padStart(3, "0")}`,
      parentSha: `parent-${i}`,
      committerTime: 1_700_000_000 + i * 86_400,
    }));
  }

  it("splits tuning/eval halves and samples reproducibly", () => {
    const list = commits(10);
    const a = sampleEvalCommits(list, 4, 42);
    const b = sampleEvalCommits(list, 4, 42);
    expect(a.sampled.map((s) => s.sha)).toEqual(b.sampled.map((s) => s.sha));
    expect(a.tuningHalf).toHaveLength(5);
    expect(a.evalPool).toHaveLength(5);
    // every sampled commit is from the later half
    for (const s of a.sampled) {
      expect(a.evalPool.some((c) => c.sha === s.sha)).toBe(true);
    }
    expect(a.sampled).toHaveLength(4);
  });

  it("different seeds give different samples", () => {
    const list = commits(40);
    const a = sampleEvalCommits(list, 10, 1);
    const b = sampleEvalCommits(list, 10, 2);
    expect(a.sampled.map((s) => s.sha)).not.toEqual(b.sampled.map((s) => s.sha));
  });

  it("PRNG is reproducible and seed-independent across instances", () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
    expect(mulberry32(7)()).not.toBe(mulberry32(8)());
  });

  it("hashString is deterministic", () => {
    expect(hashString("hono")).toBe(hashString("hono"));
    expect(hashString("hono")).not.toBe(hashString("zod"));
  });

  it("wordCount counts content words", () => {
    expect(wordCount("fix the a of to router (v2)")).toBe(2);
  });
});
