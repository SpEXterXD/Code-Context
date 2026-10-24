import { describe, expect, it } from "vitest";

import {
  META_UNIT,
  RECORD_UNIT,
  STACK_UNIT,
  isRegularFileMode,
  parseLsTreeStream,
  parseMetaStream,
  parseNameStatusStream,
} from "./gitminer";

describe("parseMetaStream", () => {
  it("splits records on the record unit and fields on meta units", () => {
    const stream = [
      `abc123${META_UNIT}p1 p2${META_UNIT}Ada${META_UNIT}ada@x.dev${META_UNIT}1700000123${META_UNIT}${STACK_UNIT}fix: first${STACK_UNIT}Long body text${RECORD_UNIT}`,
      `def456${META_UNIT}p3${META_UNIT}Bob${META_UNIT}bob@x.dev${META_UNIT}1700000456${META_UNIT}${STACK_UNIT}fix: second${STACK_UNIT}${RECORD_UNIT}`,
      "",
    ].join("");
    const meta = parseMetaStream(stream);
    expect([...meta.keys()].sort()).toEqual(["abc123", "def456"]);
    const first = meta.get("abc123")!;
    expect(first.parents).toEqual(["p1", "p2"]);
    expect(first.authorName).toBe("Ada");
    expect(first.committerTime).toBe(1700000123);
    expect(first.subject).toBe("fix: first");
    expect(first.body).toBe("Long body text");
    const second = meta.get("def456")!;
    expect(second.parents).toEqual(["p3"]);
    expect(second.body).toBe("");
  });

  it("tolerates whitespace and empty trailing records", () => {
    const stream = `  sha1${META_UNIT}p${META_UNIT}N${META_UNIT}e${META_UNIT}1${META_UNIT}${STACK_UNIT}s${STACK_UNIT}b${RECORD_UNIT}${RECORD_UNIT}`;
    expect([...parseMetaStream(stream).keys()]).toEqual(["sha1"]);
  });
});

describe("parseNameStatusStream", () => {
  it("extracts modify/add/delete flights and rename pairs with scores", () => {
    const stream = [
      `${RECORD_UNIT}abc123\nM\tsrc/a.ts\nA\tsrc/new.ts\nD\tsrc/old.ts\n`,
      `${RECORD_UNIT}def456\nR100\tsrc/x.ts\tsrc/y.ts\nC75\tsrc/z.ts\tsrc/w.ts\n`,
    ].join("");
    const files = parseNameStatusStream(stream);
    const first = files.get("abc123")!;
    expect(first).toEqual([
      { status: "M", prePath: "src/a.ts", postPath: "src/a.ts" },
      { status: "A", prePath: "src/new.ts", postPath: "src/new.ts" },
      { status: "D", prePath: "src/old.ts", postPath: "src/old.ts" },
    ]);
    const second = files.get("def456")!;
    expect(second).toEqual([
      { status: "R", prePath: "src/x.ts", postPath: "src/y.ts", renameScore: 100 },
      { status: "C", prePath: "src/z.ts", postPath: "src/w.ts", renameScore: 75 },
    ]);
  });

  it("ignores malformed lines rather than crashing", () => {
    const stream = `${RECORD_UNIT}sha\nbogus\n${RECORD_UNIT}sha2\nR50\tonly-one-path\n`;
    const files = parseNameStatusStream(stream);
    expect(files.get("sha")).toEqual([]);
    expect(files.get("sha2")).toEqual([]);
  });
});

describe("parseLsTreeStream (git ls-tree -r -z)", () => {
  it("parses regular files, symlinks, gitlinks and raw paths", () => {
    const stream = [
      "100644 blob aaa1\tsrc/index.ts",
      "100755 blob bbb2\tscripts/run.sh",
      "120000 blob ccc3\tREADME.md",
      "160000 commit ddd4\tvendored/submodule",
      "100644 blob eee5\tdir/with spaces/naïve file.ts",
      "",
    ].join("\0");
    const entries = parseLsTreeStream(stream);
    expect(entries).toEqual([
      { mode: "100644", type: "blob", sha: "aaa1", path: "src/index.ts" },
      { mode: "100755", type: "blob", sha: "bbb2", path: "scripts/run.sh" },
      { mode: "120000", type: "blob", sha: "ccc3", path: "README.md" },
      { mode: "160000", type: "commit", sha: "ddd4", path: "vendored/submodule" },
      { mode: "100644", type: "blob", sha: "eee5", path: "dir/with spaces/naïve file.ts" },
    ]);
  });

  it("classifies exactly the two regular-file modes as materializable", () => {
    expect(isRegularFileMode("100644")).toBe(true);
    expect(isRegularFileMode("100755")).toBe(true);
    expect(isRegularFileMode("120000")).toBe(false); // symlink
    expect(isRegularFileMode("160000")).toBe(false); // gitlink/submodule
    expect(isRegularFileMode("040000")).toBe(false); // tree (defensive)
    expect(parseLsTreeStream("")).toEqual([]);
  });
});
