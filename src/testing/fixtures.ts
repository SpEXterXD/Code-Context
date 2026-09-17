import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Test fixture helpers: build throwaway repositories in the OS temp dir.
 * Domain tests never need VS Code; that is the point of the layering.
 */
export function makeTempDir(prefix = "occ-test-"): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export interface FileSpec {
  [relativePath: string]: string;
}

export function writeRepo(root: string, files: FileSpec): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
}

export function writeBinary(root: string, rel: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, Buffer.from([0x00, 0x01, 0x02, 0x00, 0xff, 0x00, 0x01]));
}

export function removeRepo(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}
