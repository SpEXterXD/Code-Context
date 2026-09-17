import { beforeAll, describe, expect, it } from "vitest";

import * as path from "node:path";

import { OccApplication } from "../application/contextService";

/**
 * Retrieval evaluation set (spec §8.4) run against the real demo-project.
 * Expectations are adapted to the demo-project layout (which has dedicated
 * config/rateLimit.ts and middleware/rateLimit.ts files the spec's
 * hypothetical fixture did not). Numbers are asserted to stay stable and are
 * reported in IMPLEMENTATION_REPORT.md. Do not hide poor results; if these
 * regress, fix the retrieval or update the documented numbers knowingly.
 */
const EVAL_TABLE: Array<{ query: string; expectedTop1: string; expectedInTop5: string[] }> = [
  {
    query: "Where is authentication handled?",
    expectedTop1: "src/services/authService.ts",
    expectedInTop5: ["src/controllers/authController.ts", "src/routes/authRoutes.ts"],
  },
  {
    query: "Add rate limiting to login.",
    expectedTop1: "src/config/rateLimit.ts",
    expectedInTop5: [
      "src/middleware/rateLimit.ts",
      "src/controllers/authController.ts",
      "src/services/authService.ts",
      "src/routes/authRoutes.ts",
    ],
  },
  {
    query: "Fix user signup validation.",
    expectedTop1: "src/utils/validators.ts",
    expectedInTop5: ["src/services/authService.ts"],
  },
  {
    query: "Where is payment processing implemented?",
    expectedTop1: "src/services/paymentService.ts",
    expectedInTop5: ["src/controllers/paymentController.ts"],
  },
  {
    query: "Add pagination to the users endpoint.",
    expectedTop1: "src/routes/users.routes.ts",
    expectedInTop5: ["src/repositories/userRepository.ts", "src/controllers/userController.ts"],
  },
  {
    query: "Where is the database connection created?",
    expectedTop1: "src/db/connection.ts",
    expectedInTop5: ["src/db/migrations.ts"],
  },
];

describe("retrieval evaluation set (demo-project)", () => {
  let app: OccApplication;
  const demoRoot = path.resolve(__dirname, "../../demo-project");

  beforeAll(async () => {
    app = new OccApplication(demoRoot, path.join(demoRoot, ".occ-test-store"));
    app.initialize(); // same startup sequence as the extension
    await app.indexing.indexWorkspace({ isCancellationRequested: false, throwIfCancelled() {} });
  }, 120000);

  it("produces the documented Top-1 for every eval query", () => {
    const results = runEval();
    for (const r of results) {
      expect(r.top1, `Top-1 for "${r.query}" was ${r.top1}`).toBe(r.expectedTop1);
    }
  });

  it("places every expected file in the Top-5", () => {
    const results = runEval();
    for (const r of results) {
      for (const expected of r.expectedInTop5) {
        expect(
          r.top5.includes(expected),
          `expected "${expected}" in Top-5 for "${r.query}"; got: ${r.top5.join(", ")}`,
        ).toBe(true);
      }
    }
  });

  it("is deterministic across repeated evaluation", () => {
    const a = runEval();
    const b = runEval();
    expect(a.map((r) => r.top5)).toEqual(b.map((r) => r.top5));
  });

  it("every explanation cites a real, checkable signal", () => {
    for (const { query } of EVAL_TABLE) {
      const retrieval = app.retriever.retrieve(query, { maxGraphDepth: 3, limit: 10 });
      for (const scored of retrieval.ranked.slice(0, 5)) {
        const reasons = app.retriever.explain(scored);
        expect(reasons.length, `no reasons for ${scored.path} (${query})`).toBeGreaterThan(0);
        for (const reason of reasons) {
          expectSignalIsReal(reason, scored.path, app, query);
        }
      }
    }
  });

  function runEval(): Array<{
    query: string;
    top1: string;
    top3: string[];
    top5: string[];
    expectedTop1: string;
    expectedInTop5: string[];
  }> {
    return EVAL_TABLE.map(({ query, expectedTop1, expectedInTop5 }) => {
      const retrieval = app.retriever.retrieve(query, { maxGraphDepth: 3, limit: 10 });
      const paths = retrieval.ranked.map((r) => r.path);
      return {
        query,
        top1: paths[0] ?? "(none)",
        top3: paths.slice(0, 3),
        top5: paths.slice(0, 5),
        expectedTop1,
        expectedInTop5,
      };
    });
  }

  function expectSignalIsReal(
    reason: string,
    filePath: string,
    appRef: OccApplication,
    query: string,
  ): void {
    const symbolMatch = /^Exact symbol match: .+ \((.+):(\d+)\)$/.exec(reason);
    if (symbolMatch) {
      const [, symbolPath, line] = symbolMatch;
      const entry = appRef.indexing.getEntry(symbolPath);
      expect(entry, `symbol explanation references missing file ${symbolPath}`).toBeDefined();
      expect(
        entry?.symbols.some((s) => s.startLine === Number(line)),
        `no symbol at ${symbolPath}:${line}`,
      ).toBe(true);
      return;
    }
    const importedBy = /^Direct dependency: imported by (.+)$/.exec(reason);
    if (importedBy) {
      expect(appRef.indexing.getGraph().fileDependencies(importedBy[1])).toContain(filePath);
      return;
    }
    const imports = /^Direct dependent: imports (.+)$/.exec(reason);
    if (imports) {
      expect(appRef.indexing.getGraph().fileDependents(imports[1])).toContain(filePath);
      return;
    }
    const testOf = /^Test file for (.+?) \(naming convention\)$/.exec(reason);
    if (testOf) {
      expect(appRef.indexing.getGraph().fileDependencies(filePath)).toContain(testOf[1]);
      return;
    }
    if (
      reason.startsWith("Lexical match") ||
      reason.startsWith("File name matches") ||
      reason.startsWith("Same directory") ||
      reason.startsWith("Hub file") ||
      reason.startsWith("Project entry point") ||
      reason.startsWith("Call relationship") ||
      reason.startsWith("Inherits from")
    ) {
      return; // derived from fired lexical/name/dir/call signals by construction
    }
    throw new Error(`unrecognized explanation "${reason}" for ${filePath} (query: ${query})`);
  }
});
