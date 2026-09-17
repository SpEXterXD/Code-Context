/**
 * Docs sync check: verifies the suite and test counts published in
 * README.md and docs/TESTING.md against a real `vitest run --reporter=json`.
 * Exits non-zero when the numbers drift, so documentation cannot silently
 * go stale. Run: npx tsx scripts/check-docs-sync.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");

interface VitestJsonReport {
  readonly numTotalTestSuites?: number;
  readonly numTotalTests?: number;
  /** One entry per test FILE; docs' "suites" means test files. */
  readonly testResults?: unknown[];
  readonly success?: boolean;
}

let failures = 0;
const fail = (message: string): void => {
  console.error(`FAIL: ${message}`);
  failures++;
};

// 1. Run the suite and parse the JSON report.
let report: VitestJsonReport;
try {
  // Invoke vitest's CLI entry directly (no npx): avoids Windows .cmd shims
  // and works identically on every CI OS.
  const vitestCli = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
  const out = execFileSync(process.execPath, [vitestCli, "run", "--reporter=json", "--silent"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 600_000,
  });
  // The JSON reporter may interleave other output; take the last JSON line/word.
  const start = out.lastIndexOf('{"numTotalTestSuites"');
  report = JSON.parse(start >= 0 ? out.slice(start) : out) as VitestJsonReport;
} catch (e) {
  console.error("FAIL: could not run vitest or parse its report:", (e as Error).message);
  process.exit(1);
}

// "Suites" in the docs means test FILES (17 files, not the 50+ describe
// blocks that numTotalTestSuites counts), so count testResults entries.
const actualSuites = report.testResults?.length ?? report.numTotalTestSuites ?? -1;
const actualTests = report.numTotalTests ?? -1;
if (actualSuites < 0 || actualTests < 0) {
  console.error("FAIL: vitest report missing counts (numTotalTestSuites/numTotalTests)");
  process.exit(1);
}

// 2. Extract the declared counts: TESTING.md's "Current counts" line is the
// single source of truth; README must agree with it.
const testing = fs.readFileSync(path.join(ROOT, "docs/TESTING.md"), "utf8");
const testingMatch = /\*\*(\d+) suites, (\d+) tests\*\*/.exec(testing);
if (!testingMatch) {
  fail('docs/TESTING.md has no "**N suites, M tests**" line');
} else {
  const declaredSuites = Number(testingMatch[1]);
  const declaredTests = Number(testingMatch[2]);
  if (declaredSuites !== actualSuites) {
    fail(`docs/TESTING.md declares ${declaredSuites} suites; vitest reports ${actualSuites}`);
  }
  if (declaredTests !== actualTests) {
    fail(`docs/TESTING.md declares ${declaredTests} tests; vitest reports ${actualTests}`);
  }
}

const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const readmeMatch = /\((\d+) suites, (\d+) tests\)/.exec(readme);
if (!readmeMatch) {
  fail('README.md has no "(N suites, M tests)" reference');
} else {
  const readmeSuites = Number(readmeMatch[1]);
  const readmeTests = Number(readmeMatch[2]);
  if (readmeSuites !== actualSuites) {
    fail(`README.md declares ${readmeSuites} suites; vitest reports ${actualSuites}`);
  }
  if (readmeTests !== actualTests) {
    fail(`README.md declares ${readmeTests} tests; vitest reports ${actualTests}`);
  }
}

if (failures > 0) {
  console.error(
    `\nDocs are out of sync. Update the counts in docs/TESTING.md and README.md ` +
      `to: **${actualSuites} suites, ${actualTests} tests**.`,
  );
  process.exit(1);
}
console.log(`ok: docs declare ${actualSuites} suites / ${actualTests} tests; matches vitest run`);
