import * as path from "node:path";

import { safeGit } from "./safeGit";

/**
 * Read-only, fully local git metadata used only for the OPTIONAL recency
 * bonus (disabled by default). Never fetches, pushes, or runs hooks; fails
 * soft to "no data" when git is unavailable or the workspace is not a repo.
 *
 * M3-hardening: all git execution goes through src/git/safeGit.ts and is
 * ASYNCHRONOUS — `refreshRecencyOrder()` never blocks the extension host
 * and is invoked ahead of retrieval (extension layer, trust-gated). The
 * retriever reads only the cached order via `recencyOrderSync()`, which
 * NEVER spawns git: if the prefetch has not completed (or failed, or the
 * workspace is untrusted) retrieval simply proceeds without recency.
 */
export class GitMetadata {
  private cache: { rootPath: string; order: string[] } | null = null;
  private inFlight: Promise<void> | null = null;

  /**
   * Asynchronously refreshes the recency order for one workspace. Safe to
   * call repeatedly (in-flight calls are shared). Fails soft: any error
   * leaves the previous cache in place (or empty).
   */
  refreshRecencyOrder(rootPath: string): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = safeGit({
      cwd: rootPath,
      args: ["log", "--name-only", "--pretty=format:__COMMIT__%ct"],
      timeoutMs: 15000,
      maxBufferBytes: 64 * 1024 * 1024,
    })
      .then(({ stdout }) => {
        this.cache = { rootPath, order: parseRecencyLog(stdout) };
      })
      .catch(() => {
        // Fail soft: keep whatever was cached before (or nothing).
      })
      .finally(() => {
        this.inFlight = null;
      });
    return this.inFlight;
  }

  /** Cached order for the workspace, or [] when unavailable. Never spawns. */
  recencyOrderSync(rootPath: string): string[] {
    return this.cache?.rootPath === rootPath ? this.cache.order : [];
  }
}

/** Pure log parser (exported for tests): newest-touched paths first. */
export function parseRecencyLog(out: string): string[] {
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
}
