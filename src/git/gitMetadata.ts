import { execFileSync } from "node:child_process";
import * as path from "node:path";

/**
 * Read-only, fully local git metadata used only for the OPTIONAL recency
 * bonus (disabled by default). Never fetches, pushes, or runs hooks; fails
 * soft to "no data" when git is unavailable or the workspace is not a repo.
 */
export class GitMetadata {
  /** Returns paths sorted newest-commit-first, or [] when unavailable. */
  recencyOrder(rootPath: string): string[] {
    try {
      const out = execFileSync("git", ["log", "--name-only", "--pretty=format:__COMMIT__%ct"], {
        cwd: rootPath,
        maxBuffer: 64 * 1024 * 1024,
        encoding: "utf8",
        timeout: 15000,
      });
      const lastSeen = new Map<string, number>();
      let currentTime = 0;
      for (const line of out.split(/\r?\n/)) {
        if (line.startsWith("__COMMIT__")) {
          currentTime = parseInt(line.slice("__COMMIT__".length), 10) || 0;
          continue;
        }
        const file = line.trim();
        if (!file || lastSeen.has(file)) continue;
        lastSeen.set(file, currentTime);
      }
      return [...lastSeen.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([p]) => path.posix.normalize(p.replace(/\\/g, "/")));
    } catch {
      return [];
    }
  }
}
