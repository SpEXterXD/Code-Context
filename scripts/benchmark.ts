/**
 * Performance benchmark: generates synthetic repositories (never committed)
 * in the OS temp dir and measures initial indexing, incremental update,
 * retrieval and context generation. Run: npm run bench [-- --max 5000]
 * Numbers are reported with the environment (node/os/cpu) on stdout.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { OccApplication } from "../src/application/contextService";
import { CancellationSource } from "../src/shared/cancellation";

function argMax(): number {
  const idx = process.argv.indexOf("--max");
  return idx >= 0 ? Number(process.argv[idx + 1]) : 5000;
}

/** Generates n deterministic TS files spread over modules. */
function generateRepo(root: string, fileCount: number): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "bench-repo", version: "0.0.0" }) + "\n",
  );
  const modules = Math.max(1, Math.floor(fileCount / 10));
  for (let m = 0; m < modules && m * 10 < fileCount; m++) {
    const dir = path.join(root, "src", `module${m}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "service.ts"),
      [
        `/** Service for module${m}: handles requests and orchestrates helpers. */`,
        `import { helper${m} } from "./helper";`,
        `export class Service${m} {`,
        `  run(input: number): number {`,
        `    return helper${m}(input) + ${m};`,
        `  }`,
        `}`,
        ``,
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, "helper.ts"),
      [
        `/** Helper utilities for module${m}. */`,
        `export function helper${m}(x: number): number {`,
        `  return x * ${m + 2};`,
        `}`,
        ``,
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(dir, `service.test.ts`),
      [`/** Tests for module${m} service. */`, `export const check${m} = () => true;`, ``].join(
        "\n",
      ),
    );
    for (let i = 3; i < 10 && m * 10 + i < fileCount; i++) {
      fs.writeFileSync(
        path.join(dir, `part${i}.ts`),
        [
          `/** Part ${i} of module${m} with some content for lexical indexing. */`,
          `export const value${m}_${i} = ${i};`,
          `export function process${m}_${i}(data: string): string {`,
          `  return data.trim() + "${m}:${i}";`,
          `}`,
          ``,
        ].join("\n"),
      );
    }
  }
}

async function measure(label: string, fn: () => Promise<unknown> | unknown): Promise<number> {
  const start = performance.now();
  await fn();
  const ms = performance.now() - start;
  console.log(`  ${label}: ${ms.toFixed(0)} ms`);
  return ms;
}

async function runScale(fileCount: number): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `occ-bench-${fileCount}-`));
  const store = path.join(root, ".occ-store");
  generateRepo(root, fileCount);
  console.log(`\n=== ${fileCount} files ===`);

  const app = new OccApplication(root, store);
  const memoryBefore = process.memoryUsage().heapUsed / 1024 / 1024;
  const indexMs = await measure("initial index", () =>
    app.indexing.indexWorkspace(CancellationSource.never()),
  );
  const heapAfterIndex = process.memoryUsage().heapUsed / 1024 / 1024;

  // Incremental: touch 5% of files.
  const entries = [...app.indexing.getEntries().keys()];
  const toTouch = entries
    .filter((_, i) => i % 20 === 0)
    .slice(0, Math.max(1, Math.floor(entries.length * 0.05)));
  for (const rel of toTouch) {
    const full = path.join(root, rel);
    fs.writeFileSync(full, fs.readFileSync(full, "utf8") + `// touch ${Date.now() % 1000}\n`);
  }
  const incrementalMs = await measure(`incremental (${toTouch.length} files changed)`, () =>
    app.indexing.indexWorkspace(CancellationSource.never()),
  );

  const searchMs = await measure("search (3 queries)", () => {
    for (const q of ["service run helper", "module0 process data", "test check"]) {
      app.retriever.retrieve(q, { maxGraphDepth: 3, limit: 20 });
    }
  });

  const contextMs = await measure("context generation (task)", () =>
    app.buildContext("task", { taskText: "handle service requests in module0" }),
  );

  console.log(
    `  heap: before ${memoryBefore.toFixed(0)} MB → after index ${heapAfterIndex.toFixed(0)} MB`,
  );

  fs.rmSync(root, { recursive: true, force: true });
  void indexMs;
}

async function main(): Promise<void> {
  const max = argMax();
  const scales = [20, 500, 5000].filter((n) => n <= max);
  console.log(`Offline Code Context Compiler benchmark`);
  console.log(
    `node ${process.version} · ${os.type()} ${os.release()} · ${os.cpus()?.[0]?.model ?? "unknown cpu"} · ${os.totalmem() / 1024 / 1024 / 1024 > 1 ? (os.totalmem() / 1024 / 1024 / 1024).toFixed(0) + " GB RAM" : (os.totalmem() / 1024 / 1024).toFixed(0) + " MB RAM"}`,
  );
  for (const scale of scales) {
    await runScale(scale);
  }
  if (max < 5000) {
    console.log(`\n(scales above ${max} skipped by --max)`);
  }
}

void main();
