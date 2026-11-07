import { describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { FORBIDDEN_NODE_MODULES, OUTBOUND_POLICY_STATEMENT } from "./outboundPolicy";

/**
 * FU9: the outbound policy was previously dead documentation —
 * FORBIDDEN_NODE_MODULES was declared "used by tests" but no test enforced
 * it, so a network-capable import could slip into src/ unnoticed. These
 * tests ARE the enforcement: any new import of a forbidden module in src/,
 * or any runtime dependency that ships one, fails the suite.
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

/** Import / require / dynamic-import specifiers in one source file. */
function importedSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*import\s+(?:type\s+)?[^'"]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*import\s*["']([^"']+)["']/g,
    /\brequire\(\s*["']([^"']+)["']\s*\)/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const re of patterns) {
    for (const m of source.matchAll(re)) specifiers.push(m[1]!);
  }
  return specifiers;
}

describe("FU9: outbound network policy is enforced", () => {
  it("forbids network-capable module imports anywhere in src/", () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_ROOT)) {
      const source = fs.readFileSync(file, "utf8");
      for (const spec of importedSpecifiers(source)) {
        const bare = spec.replace(/^node:/, "").split("/")[0]!;
        if ((FORBIDDEN_NODE_MODULES as readonly string[]).includes(bare)) {
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
