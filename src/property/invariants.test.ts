import { afterEach, describe, expect, it } from "vitest";

import * as fs from "node:fs";
import * as path from "node:path";

import { IndexingService } from "../application/indexingService";
import { createDefaultParserRegistry } from "../parser/parserRegistry";
import { makeTempDir, removeRepo } from "../testing/fixtures";
import { CancellationSource } from "../shared/cancellation";
import { mulberry32 } from "../testing/prng";

/**
 * Property / invariant tests (spec §8.11) driven by a seeded PRNG so the
 * suite is reproducible: random file operations must preserve the invariants
 * (no stale records, no reparses of unchanged files, ignored files never
 * indexed).
 */
const registry = createDefaultParserRegistry();

function makeService(root: string): IndexingService {
  return new IndexingService(root, path.join(root, ".occ-store"), (p) => registry.resolve(p));
}

describe("property invariants (seeded random operations)", () => {
  let root: string;

  afterEach(() => {
    if (root) removeRepo(root);
  });

  it("random creates/edits/deletes/renames keep the index consistent with disk", async () => {
    root = makeTempDir();
    const service = makeService(root);
    const prng = mulberry32(20260911);
    const files = new Set<string>();

    const contentFor = (i: number, edit: number): string =>
      `export const value${i} = ${i};\n// edit ${edit}\nexport function fn${i}() { return ${i}; }\n`;

    for (let step = 0; step < 60; step++) {
      const action = prng();
      if (action < 0.35 || files.size === 0) {
        const i = Math.floor(prng() * 1000);
        const rel = `src/file${i}.ts`;
        fs.mkdirSync(path.join(root, "src"), { recursive: true });
        fs.writeFileSync(path.join(root, rel), contentFor(i, 0));
        files.add(rel);
        await service.indexSingleFile(rel, CancellationSource.never());
      } else if (action < 0.6) {
        const rel = [...files][Math.floor(prng() * files.size)];
        const i = Number(/file(\d+)/.exec(rel)?.[1] ?? 0);
        const edit = Math.floor(prng() * 100);
        fs.writeFileSync(path.join(root, rel), contentFor(i, edit));
        await service.indexSingleFile(rel, CancellationSource.never());
      } else if (action < 0.8) {
        const rel = [...files][Math.floor(prng() * files.size)];
        fs.rmSync(path.join(root, rel));
        files.delete(rel);
        await service.removeFile(rel);
      } else {
        const rel = [...files][Math.floor(prng() * files.size)];
        const to = rel.replace(/\.ts$/, ".moved.ts");
        fs.renameSync(path.join(root, rel), path.join(root, to));
        files.delete(rel);
        files.add(to);
        await service.renameFile(rel, to, CancellationSource.never());
      }

      // Invariants after every step:
      for (const rel of files) {
        expect(service.getEntries().has(rel), `${rel} missing from index at step ${step}`).toBe(
          true,
        );
      }
      for (const rel of service.getEntries().keys()) {
        expect(files.has(rel), `stale index record for ${rel} at step ${step}`).toBe(true);
        expect(
          fs.existsSync(path.join(root, rel)),
          `indexed file vanished: ${rel} at step ${step}`,
        ).toBe(true);
      }
    }
  });

  it("unchanged files are never reparsed across random no-op reindex runs", async () => {
    root = makeTempDir();
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const paths: string[] = [];
    for (let i = 0; i < 10; i++) {
      const rel = `src/f${i}.ts`;
      fs.writeFileSync(path.join(root, rel), `export const v${i} = ${i};\n`);
      paths.push(rel);
    }
    const service = makeService(root);
    await service.indexWorkspace(CancellationSource.never());
    service.resetParseCounter();
    for (let run = 0; run < 5; run++) {
      await service.indexWorkspace(CancellationSource.never());
    }
    expect(service.parsedFileCount()).toBe(0);
  });

  it("ignored files never appear in the index (random placements)", async () => {
    root = makeTempDir();
    const service = makeService(root);
    const prng = mulberry32(42);
    for (let i = 0; i < 20; i++) {
      const dir = prng() < 0.5 ? "node_modules/pkg-x" : "src";
      const rel = `${dir}/f${i}.ts`;
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, rel), "export const x = 1;\n");
      await service.indexSingleFile(rel, CancellationSource.never());
    }
    for (const rel of service.getEntries().keys()) {
      expect(rel.startsWith("node_modules/")).toBe(false);
    }
  });
});
