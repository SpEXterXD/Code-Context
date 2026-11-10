import { describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { importedSpecifiersSyntax } from "./forbiddenModules";
import { FORBIDDEN_NODE_MODULES, OUTBOUND_POLICY_STATEMENT } from "./outboundPolicy";

/**
 * FU9/review: the outbound policy was previously dead documentation, and the
 * first enforcement pass used a REGEX extractor that missed `export * from
 * "node:https"` and flagged commented-out imports. Enforcement is now
 * syntax-aware (the installed TypeScript parser): any import of a forbidden
 * module in src/, or any runtime dependency that ships one, fails the suite.
 */

const SRC_ROOT = path.resolve(import.meta.dirname ?? process.cwd(), "..", "..", "src");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) out.push(...listSourceFiles(full));
    else if (d.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function isForbidden(spec: string): boolean {
  const bare = spec.replace(/^node:/, "").split("/")[0]!;
  return (FORBIDDEN_NODE_MODULES as readonly string[]).includes(bare);
}

describe("FU9: forbidden-module extraction (syntax-aware)", () => {
  it("finds every supported import form", () => {
    const source = [
      'import { createServer } from "http";',
      'import "https";',
      'import * as net2 from "node:net";',
      'import dgram from "node:dgram";',
      'export * from "node:tls";', // the form the regex extractor missed
      'export { x } from "node:dns";',
      'const u = require("undici");',
      'import eq = require("node:http2");',
      'const m = await import("axios");',
      'const n = await import("node-fetch");',
    ].join("\n");
    const specs = importedSpecifiersSyntax(source);
    for (const expected of [
      "http",
      "https",
      "node:net",
      "node:dgram",
      "node:tls",
      "node:dns",
      "undici",
      "node:http2",
      "axios",
      "node-fetch",
    ]) {
      expect(specs).toContain(expected);
    }
  });

  it("never flags comments, prose, or string content", () => {
    const source = [
      "// import * as net from 'node:net';",
      '/* const http = require("http"); */',
      'const message = "please import \\"https\\" somewhere";',
      'const url = "https://example.invalid/api";',
      "export const ok = 1;",
    ].join("\n");
    expect(importedSpecifiersSyntax(source).filter(isForbidden)).toEqual([]);
  });

  it("leaves non-literal dynamic imports unreported rather than guessed", () => {
    const source = "const mod = await import(variableName);";
    expect(importedSpecifiersSyntax(source)).toEqual([]);
  });
});

describe("FU9: outbound network policy is enforced", () => {
  it("forbids network-capable module imports anywhere in src/", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, "utf8");
      for (const spec of importedSpecifiersSyntax(source, file)) {
        if (isForbidden(spec)) {
          offenders.push(`${path.relative(SRC_ROOT, file)} imports "${spec}"`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it("declares no runtime dependencies beyond the toolchain", () => {
    // The shipped runtime must not gain transitive network clients: the
    // only permitted runtime dependency is typescript (the parser itself).
    const pkg = JSON.parse(fs.readFileSync(path.join(SRC_ROOT, "..", "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["typescript"]);
  });

  it("keeps the policy statement honest about the single egress point", () => {
    expect(OUTBOUND_POLICY_STATEMENT).toContain("clipboard");
    expect(OUTBOUND_POLICY_STATEMENT).toContain("zero network I/O");
  });
});
