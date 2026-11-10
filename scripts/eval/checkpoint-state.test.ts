import { afterEach, describe, expect, it } from "vitest";

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  checkpointPaths,
  readCheckpointState,
  sourceFingerprint,
  truncateTornTail,
  validateCheckpointRecords,
  writeCheckpointManifest,
} from "./checkpointState";

/**
 * F11/review lifecycle tests on DISPOSABLE directories only — the real
 * holdout is never consumed. Covers: completed-rerun rejection, pending
 * resume, torn-tail repair before append, interior corruption rejection,
 * record validation (duplicates/foreign ids), and dirty-tree identity.
 */
describe("checkpoint lifecycle (F11 review fixes)", () => {
  let dir: string;

  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function setup(): { recordsFile: string; manifestFile: string } {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-cp-"));
    return checkpointPaths(dir, "results-holdout");
  }

  it("a COMPLETED manifest blocks a rerun even with no records file", () => {
    const { manifestFile } = setup();
    writeCheckpointManifest(manifestFile, {
      identity: "id1",
      split: "holdout",
      occCommit: "c0",
      status: "completed",
    });
    const state = readCheckpointState(manifestFile, "id1");
    // The guard must see "completed" — manifest existence alone previously
    // let a completed holdout rerun from zero records.
    expect(state.status).toBe("completed");
  });

  it("a PENDING manifest with no records resumes with zero tasks", () => {
    const { manifestFile } = setup();
    writeCheckpointManifest(manifestFile, {
      identity: "id1",
      split: "holdout",
      occCommit: "c0",
      status: "pending",
    });
    expect(readCheckpointState(manifestFile, "id1").status).toBe("pending");
  });

  it("an identity mismatch is surfaced, never silently resumed", () => {
    const { manifestFile } = setup();
    writeCheckpointManifest(manifestFile, {
      identity: "old",
      split: "holdout",
      occCommit: "c0",
      status: "pending",
    });
    expect(readCheckpointState(manifestFile, "new").identityMismatch).toBe(true);
  });

  it("truncateTornTail repairs only a trailing torn line; interior corruption throws", () => {
    const { recordsFile } = setup();
    fs.writeFileSync(recordsFile, '{"task":"a"}\n{"task":"b"\n');
    expect(truncateTornTail(recordsFile)).toBe(1);
    expect(fs.readFileSync(recordsFile, "utf8")).toBe('{"task":"a"}\n');
    // Append after the repair produces a clean, parseable record set.
    fs.appendFileSync(recordsFile, '{"task":"b"}\n');
    expect(validateCheckpointRecords(recordsFile).map((r) => r.task)).toEqual(["a", "b"]);

    const { recordsFile: badFile } = setup();
    fs.writeFileSync(badFile, '{"task":"a"}\nGARBAGE\n{"task":"c"}\n');
    expect(() => truncateTornTail(badFile)).toThrow(/corrupt checkpoint line 2/);
    expect(() => validateCheckpointRecords(badFile)).toThrow(/corrupt checkpoint line 2/);
  });

  it("validateCheckpointRecords rejects duplicates and foreign task ids", () => {
    const { recordsFile } = setup();
    fs.writeFileSync(recordsFile, '{"task":"a"}\n{"task":"a"}\n');
    expect(() => validateCheckpointRecords(recordsFile)).toThrow(/duplicate/);

    const { recordsFile: foreign } = setup();
    fs.writeFileSync(foreign, '{"task":"zzz"}\n');
    expect(() => validateCheckpointRecords(foreign, new Set(["a", "b"]))).toThrow(/foreign/);
  });

  it("sourceFingerprint changes when the working tree becomes dirty", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "occ-fp-"));
    const git = (args: string[], cwd: string): string =>
      execFileSync("git", args, { cwd, encoding: "utf8" });
    git(["init", "-q"], dir);
    git(["config", "user.email", "t@t"], dir);
    git(["config", "user.name", "t"], dir);
    fs.writeFileSync(path.join(dir, "config.json"), "{}\n");
    git(["add", "-A"], dir);
    git(["commit", "-q", "-m", "init"], dir);
    const clean = sourceFingerprint(git, dir);
    expect(clean).toBe("clean");
    // A dirty harness file (weights/config/code change) MUST change the
    // identity — different experiments at one HEAD cannot share checkpoints.
    fs.appendFileSync(path.join(dir, "config.json"), '{"dirty":true}\n');
    const dirty = sourceFingerprint(git, dir);
    expect(dirty).not.toBe("clean");
    expect(dirty).not.toBe(clean);
  });
});
