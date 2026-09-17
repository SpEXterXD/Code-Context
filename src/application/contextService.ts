import * as fs from "node:fs";
import * as path from "node:path";

import { IndexingService } from "./indexingService";
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

  constructor(
    readonly rootPath: string,
    storeRoot: string,
    private readonly config: OccConfig = DEFAULT_CONFIG,
  ) {
    const registry = createDefaultParserRegistry();
    this.indexing = new IndexingService(rootPath, storeRoot, (p) => registry.resolve(p), {
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
        projectName: resolveProjectName(this.rootPath),
        indexVersion: computeIndexVersion(this.indexing.getEntries()),
        budget: this.config,
        security: {
          secretPolicy: this.config.secretPolicy,
          redactSecrets: this.config.redactSecrets,
        },
        enableGitRecency: this.config.enableGitRecency,
        readFile: (p: string) => fs.readFileSync(path.join(this.rootPath, p), "utf8"),
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
    // mode's candidate set. No new modes, no new pipelines.
    if (request.scope?.kind === "file") {
      return this.ensureBuilder().build({
        mode: "file",
        activeFile: request.scope.relPath,
        expandSelection: request.expandSelection,
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
    });
  }

  resetParseCounter(): void {
    this.indexing.resetParseCounter();
  }

  parsedFileCount(): number {
    return this.indexing.parsedFileCount();
  }
}

export function resolveProjectName(rootPath: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(rootPath, "package.json"), "utf8")) as {
      name?: string;
    };
    if (pkg.name) return pkg.name;
  } catch {
    /* fall through to directory name */
  }
  return path.basename(rootPath) || "workspace";
}
