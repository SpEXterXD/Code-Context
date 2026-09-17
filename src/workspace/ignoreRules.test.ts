import { describe, expect, it } from "vitest";

import { globToRegex, IgnoreRules } from "./ignoreRules";

describe("gitignore pattern semantics", () => {
  it("ignores exact names anywhere", () => {
    const rules = new IgnoreRules(["node_modules"]);
    expect(rules.isIgnored("node_modules", true)).toBe(true);
    expect(rules.isIgnored("node_modules/express/index.js", false)).toBe(true);
  });

  it("supports directory-only patterns", () => {
    const rules = new IgnoreRules(["build/"]);
    expect(rules.isIgnored("build", true)).toBe(true);
    expect(rules.isIgnored("build/out.js", false)).toBe(true);
    expect(rules.isIgnored("buildutils/x.ts", false)).toBe(false);
  });

  it("supports single-star globs", () => {
    const rules = new IgnoreRules(["*.log"]);
    expect(rules.isIgnored("logs/debug.log", false)).toBe(true);
    expect(rules.isIgnored("src/app.ts", false)).toBe(false);
  });

  it("supports double-star globs", () => {
    const rules = new IgnoreRules(["**/generated/**"]);
    expect(rules.isIgnored("src/a/generated/b/c.ts", false)).toBe(true);
    expect(rules.isIgnored("src/a/main.ts", false)).toBe(false);
  });

  it("supports question mark", () => {
    const rules = new IgnoreRules(["file?.txt"]);
    expect(rules.isIgnored("file1.txt", false)).toBe(true);
    expect(rules.isIgnored("file10.txt", false)).toBe(false);
  });

  it("supports negation", () => {
    const rules = new IgnoreRules(["*.log", "!keep.log"]);
    expect(rules.isIgnored("noise.log", false)).toBe(true);
    expect(rules.isIgnored("keep.log", false)).toBe(false);
  });

  it("supports anchored patterns", () => {
    const rules = new IgnoreRules(["/secret.txt"]);
    expect(rules.isIgnored("secret.txt", false)).toBe(true);
    expect(rules.isIgnored("nested/secret.txt", false)).toBe(false);
  });

  it("ignores comments and blank lines", () => {
    const rules = new IgnoreRules([]);
    rules.addGitignoreContent("# comment\n\n*.tmp\n");
    expect(rules.isIgnored("x.tmp", false)).toBe(true);
  });

  it("applies last-match-wins within a rule set", () => {
    const rules = new IgnoreRules(["dist", "!dist/keep.ts"]);
    expect(rules.isIgnored("dist/other.ts", false)).toBe(true);
    expect(rules.isIgnored("dist/keep.ts", false)).toBe(false);
  });

  it("documents sensitive default excludes", () => {
    const rules = new IgnoreRules([".env", ".env.*", "*.pem", "*.key"]);
    expect(rules.isIgnored(".env", false)).toBe(true);
    expect(rules.isIgnored(".env.production", false)).toBe(true);
    expect(rules.isIgnored("server.pem", false)).toBe(true);
    expect(rules.isIgnored("id_rsa.key", false)).toBe(true);
  });
});

describe("globToRegex", () => {
  it("escapes regex metacharacters", () => {
    const re = globToRegex("a.b+c", true);
    expect(re.test("a.b+c")).toBe(true);
    expect(re.test("aXbYc")).toBe(false);
  });
});
