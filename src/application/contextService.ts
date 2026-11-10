import * as path from "node:path";

import { IndexingService } from "./indexingService";
import {
  readBoundedFile,
  bindWorkspaceRoot,
  isBoundWorkspaceRoot,
  type BoundWorkspaceRoot,
} from "../workspace/containment";
import { createDefaultParserRegistry } from "../parser/parserRegistry";
import { HybridRetriever } from "../retrieval/hybridRetriever";
import { GitMetadata } from "../git/gitMetadata";
import {
  ContextBuilder,
  computeIndexVersion,
  type ContextBuildResult,
  type ContextMode,
  type ContextScope,
} from "../context/contextBuilder";
import { DEFAULT_BUDGET, type ContextBudgetConfig } from "../context/contextBudget";
import type { SecretPolicy } from "../security/securityService";
import type { SeedSet } from "../seeds/seedSet";
import { OccError } from "../shared/errors";

export type { ContextScope, ContextMode, ContextBuildResult };

/** Full runtime configuration, supplied by the extension layer (or tests). */
export interface OccConfig extends ContextBudgetConfig {
  secretPolicy: SecretPolicy;
  redactSecrets: boolean;
  enableGitRecency: boolean;
  excludePatterns: string[];
  respectGitignore: boolean;
  maxFileSizeBytes: number;
}

export const DEFAULT_CONFIG: OccConfig = {
  ...DEFAULT_BUDGET,
  secretPolicy: "block",
  redactSecrets: true,
  enableGitRecency: false,
  excludePatterns: [],
  respectGitignore: true,
  maxFileSizeBytes: 1024 * 1024,
};

/**
 * Application facade wiring the whole pipeline together. This is the single
 * entry point the VS Code extension layer talks to (and the one tests use).
 */
export class OccApplication {
  readonly indexing: IndexingService;
  readonly retriever: HybridRetriever;
  private readonly git = new GitMetadata();
  private builder: ContextBuilder | null = null;
  private builderDirty = true;
  /**
   * Extension-layer trust veto (M3-hardening): git features stay off in
   * untrusted workspaces because repo-controlled git configuration can be
   * hostile. The domain layer never imports vscode; the extension sets
   * this from workspace trust. Defaults to allowed so headless/eval use
   * (and pre-trust-availability tests) behave as before.
   */
  private gitRecencyAllowed = true;
  readonly rootBinding: BoundWorkspaceRoot;

  constructor(
    readonly rootPath: string,
    storeRoot: string,
    private config: OccConfig = DEFAULT_CONFIG,
  ) {
    this.rootBinding = bindWorkspaceRoot(rootPath);
    const registry = createDefaultParserRegistry();
    this.indexing = new IndexingService(this.rootBinding, storeRoot, (p) => registry.resolve(p), {
      excludePatterns: config.excludePatterns,
      respectGitignore: config.respectGitignore,
      maxFileSizeBytes: config.maxFileSizeBytes,
    });
    this.retriever = new HybridRetriever(
      rootPath,
      this.indexing.getGraph(),
      this.git,
      this.indexing.getEntries(),
    );
    this.indexing.onEntriesChanged(({ upserted, removed }) => {
      for (const entry of upserted) this.retriever.applyEntry(entry);
      for (const p of removed) this.retriever.removeFile(p);
      this.builderDirty = true;
    });
    this.indexing.onStatusChange(() => {
      this.builderDirty = true;
    });
  }

  /**
   * Extension-layer trust gate for git features. When disallowed, the
   * recency bonus is disabled and no git process is ever spawned. Flipping
   * it invalidates the cached builder so the next package reflects it.
   */
  setGitRecencyAllowed(allowed: boolean): void {
    if (this.gitRecencyAllowed === allowed) return;
    this.gitRecencyAllowed = allowed;
    this.builderDirty = true;
  }

  /**
   * Asynchronously prefetches git recency data (never blocks; fail-soft).
   * The extension layer calls this on activation, on trust grant, and after
   * indexing — retrieval only ever reads the cache.
   */
  refreshGitRecency(): Promise<void> {
    if (!this.config.enableGitRecency || !this.gitRecencyAllowed) return Promise.resolve();
    return this.git.refreshRecencyOrder(this.rootPath);
  }

  /**
   * F05: replaces the configuration snapshot and applies discovery options
   * to the indexing service (serialized through its queue). Marks the cached
   * builder dirty so the next package uses the new budgets/security/recency
   * settings. Does NOT trigger a rebuild — the extension layer decides when
   * discovery changes require one.
   */
  updateConfig(next: OccConfig): void {
    this.config = next;
    this.indexing.updateOptions({
      excludePatterns: next.excludePatterns,
      respectGitignore: next.respectGitignore,
      maxFileSizeBytes: next.maxFileSizeBytes,
    });
    this.builderDirty = true;
  }

  /** Loads persisted index state; call once at startup. */
  initialize(): void {
    this.indexing.initialize();
    this.retriever.rebuild();
  }

  private ensureBuilder(): ContextBuilder {
    if (this.builder === null || this.builderDirty) {
      this.builder = new ContextBuilder({
        entries: this.indexing.getEntries(),
        graph: this.indexing.getGraph(),
        retriever: this.retriever,
        projectName: resolveProjectName(this.rootBinding),
        indexVersion: computeIndexVersion(this.indexing.getEntries()),
        budget: this.config,
        security: {
          secretPolicy: this.config.secretPolicy,
          redactSecrets: this.config.redactSecrets,
        },
        enableGitRecency: this.config.enableGitRecency && this.gitRecencyAllowed,
        readFile: (p: string): string | null => {
          const cap = this.config.maxFileSizeBytes ?? DEFAULT_CONFIG.maxFileSizeBytes;
          return readBoundedFile(this.rootBinding, p, cap);
        },
      });
      this.builderDirty = false;
    }
    return this.builder;
  }

  buildContext(
    mode: ContextMode,
    request: {
      taskText?: string;
      activeFile?: string;
      selectedPaths?: string[];
      expandSelection?: boolean;
      scope?: ContextScope;
      /** M4 change-aware seeds (see ContextRequest.seedSet). */
      seedSet?: SeedSet;
    },
  ): ContextBuildResult {
    if (this.indexing.getEntries().size === 0) {
      throw new OccError(
        "NOT_INDEXED",
        "The workspace is not indexed yet. Run 'OCC: Index Workspace' first.",
      );
    }
    // Normalize scopes onto existing modes: a file scope IS the file mode
    // (pinned seed + tier expansion); a folder scope narrows the project
    // mode's candidate set. No new modes, no new pipelines. Review fix
    // (follow-up 6): the seedSet is forwarded through normalization — the
    // file-scope path previously dropped it, silently losing CURRENT CHANGES
    // and seed hints for right-click file context.
    if (request.scope?.kind === "file") {
      return this.ensureBuilder().build({
        mode: "file",
        activeFile: request.scope.relPath,
        expandSelection: request.expandSelection,
        seedSet: request.seedSet,
      });
    }
    // Keep retrieval structures in sync (cheap no-ops when nothing changed).
    return this.ensureBuilder().build({
      mode,
      taskText: request.taskText,
      activeFile: request.activeFile,
      selectedPaths: request.selectedPaths,
      expandSelection: request.expandSelection,
      scope: request.scope,
      seedSet: request.seedSet,
    });
  }

  resetParseCounter(): void {
    this.indexing.resetParseCounter();
  }

  parsedFileCount(): number {
    return this.indexing.parsedFileCount();
  }
}

export function resolveProjectName(root: string | BoundWorkspaceRoot): string {
  const rootPath = isBoundWorkspaceRoot(root) ? root.rootPath : root;
  try {
    const content = readBoundedFile(root, "package.json", 64 * 1024);
    if (content !== null) {
      const pkg = JSON.parse(content) as { name?: string };
      if (pkg && typeof pkg.name === "string" && pkg.name.trim().length > 0) {
        return pkg.name;
      }
    }
  } catch {
    /* fall through to directory name */
  }
  return path.basename(rootPath) || "workspace";
}
