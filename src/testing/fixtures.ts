import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { setCustomLstatSync, setCustomReaddirSync } from "../workspace/containment";

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

export interface LinkFixture {
  linkPath: string;
  isRealLink: boolean;
  cleanup: () => void;
}

/**
 * Creates a link fixture (symlink or junction) for containment testing.
 *
 * Requirements (Stage 3):
 * - Creates real directory junctions on Windows (process.platform === "win32" && type === "dir"),
 *   which succeed without admin/Developer Mode privileges.
 * - Creates real file symlinks on platforms that permit them.
 * - If fixture creation fails specifically with EPERM or EACCES (such as in restricted
 *   sandboxes or on Windows without Developer Mode for file symlinks):
 *   handles this as an environment limitation and provides deterministic coverage of
 *   the product rejection path by installing a targeted fs.lstatSync hook for `linkPath`.
 * - A skipped fixture is not a pass: all product rejection assertions execute.
 * - Product assertion failures must still fail the test suite.
 */
export function createLinkFixture(
  target: string,
  linkPath: string,
  type: "file" | "dir",
): LinkFixture {
  const linkType = process.platform === "win32" && type === "dir" ? "junction" : type;
  try {
    fs.symlinkSync(target, linkPath, linkType);
    return {
      linkPath,
      isRealLink: true,
      cleanup: () => {
        try {
          if (process.platform === "win32" && type === "dir") {
            fs.rmdirSync(linkPath);
          } else {
            fs.unlinkSync(linkPath);
          }
        } catch {
          fs.rmSync(linkPath, { recursive: true, force: true });
        }
      },
    };
  } catch (err: unknown) {
    const error = err as NodeJS.ErrnoException;
    if (error && (error.code === "EPERM" || error.code === "EACCES")) {
      // Specific fixture-creation permission limitation: provide deterministic coverage
      // of the product rejection path by hooking fs.lstatSync for this linkPath.
      const normalizedLink = path.resolve(linkPath);
      if (type === "dir") {
        try {
          fs.cpSync(target, linkPath, { recursive: true });
        } catch {
          fs.mkdirSync(linkPath, { recursive: true });
        }
      } else {
        fs.mkdirSync(path.dirname(linkPath), { recursive: true });
        if (!fs.existsSync(linkPath)) {
          fs.writeFileSync(linkPath, "");
        }
      }

      const origLstat = fs.lstatSync;
      const patchedLstat: typeof fs.lstatSync = ((p: fs.PathLike, options?: unknown) => {
        const resolved = path.resolve(p.toString());
        const isMatch =
          process.platform === "win32"
            ? resolved.toLowerCase() === normalizedLink.toLowerCase()
            : resolved === normalizedLink;
        if (isMatch) {
          const realStat = origLstat(p, options as never);
          return Object.assign(Object.create(Object.getPrototypeOf(realStat)), realStat, {
            isSymbolicLink: () => true,
            isFile: () => false,
            isDirectory: () => false,
          });
        }
        return origLstat(p, options as never);
      }) as typeof fs.lstatSync;

      setCustomLstatSync(patchedLstat);

      const origReaddir = fs.readdirSync;
      const patchedReaddir: typeof fs.readdirSync = ((dirPath: fs.PathLike, options?: unknown) => {
        const entries = origReaddir(dirPath, options as never);
        if (
          options &&
          typeof options === "object" &&
          (options as { withFileTypes?: boolean }).withFileTypes
        ) {
          const resolvedDir = path.resolve(dirPath.toString());
          const targetParent = path.dirname(normalizedLink);
          const isParentMatch =
            process.platform === "win32"
              ? resolvedDir.toLowerCase() === targetParent.toLowerCase()
              : resolvedDir === targetParent;
          if (isParentMatch) {
            const targetBase = path.basename(normalizedLink);
            for (const dirent of entries as unknown as fs.Dirent[]) {
              const isNameMatch =
                process.platform === "win32"
                  ? dirent.name.toLowerCase() === targetBase.toLowerCase()
                  : dirent.name === targetBase;
              if (isNameMatch) {
                dirent.isSymbolicLink = () => true;
                dirent.isFile = () => false;
                dirent.isDirectory = () => false;
              }
            }
          }
        }
        return entries;
      }) as typeof fs.readdirSync;

      setCustomReaddirSync(patchedReaddir);

      return {
        linkPath,
        isRealLink: false,
        cleanup: () => {
          setCustomLstatSync(null);
          setCustomReaddirSync(null);
          try {
            fs.rmSync(linkPath, { recursive: true, force: true });
          } catch {
            /* ignore */
          }
        },
      };
    }
    // Re-throw any other fixture creation error (e.g. ENOENT) so real failures fail fast.
    throw err;
  }
}
