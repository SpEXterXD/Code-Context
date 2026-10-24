import * as vscode from "vscode";

import type { OccConfig } from "../application/contextService";
import { DEFAULT_CONFIG } from "../application/contextService";

/** Reads the full OCC configuration from VS Code settings, validated. */
export function readConfig(): OccConfig {
  const cfg = vscode.workspace.getConfiguration("offlineCodeContext");
  const int = (key: string, fallback: number): number => {
    const value = cfg.get<number>(key);
    return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  };
  const config: OccConfig = {
    maxFiles: int("maxFiles", DEFAULT_CONFIG.maxFiles),
    maxChars: int("maxChars", DEFAULT_CONFIG.maxChars),
    maxLines: int("maxLines", DEFAULT_CONFIG.maxLines),
    maxTokens: int("maxTokens", DEFAULT_CONFIG.maxTokens),
    maxGraphDepth: int("maxGraphDepth", DEFAULT_CONFIG.maxGraphDepth),
    maxCodeLinesPerFile: int("maxCodeLinesPerFile", DEFAULT_CONFIG.maxCodeLinesPerFile),
    structureDepth: int("structureDepth", DEFAULT_CONFIG.structureDepth),
    secretPolicy:
      cfg.get<"block" | "warn" | "allow">("secretPolicy") ?? DEFAULT_CONFIG.secretPolicy,
    redactSecrets: cfg.get<boolean>("redactSecrets") ?? DEFAULT_CONFIG.redactSecrets,
    enableGitRecency: cfg.get<boolean>("enableGitRecency") ?? DEFAULT_CONFIG.enableGitRecency,
    excludePatterns: cfg.get<string[]>("excludePatterns") ?? DEFAULT_CONFIG.excludePatterns,
    respectGitignore: cfg.get<boolean>("respectGitignore") ?? DEFAULT_CONFIG.respectGitignore,
    maxFileSizeBytes: int("maxFileSizeBytes", DEFAULT_CONFIG.maxFileSizeBytes),
    currentChangesMaxTokens: int("currentChangesMaxTokens", DEFAULT_CONFIG.currentChangesMaxTokens),
  };
  return config;
}

/** M4 seed-collection settings (seedProvider). Editor/diagnostic/stack
 * seed sources are untuned and OFF by default (ADR-006). */
export function readSeedSettings(): {
  changeSeeds: boolean;
  changeSeedsMaxPaths: number;
  seedEditors: boolean;
  seedDiagnostics: boolean;
  seedStackTraces: boolean;
} {
  const cfg = vscode.workspace.getConfiguration("offlineCodeContext");
  const bool = (key: string, fallback: boolean): boolean => {
    const value = cfg.get<boolean>(key);
    return typeof value === "boolean" ? value : fallback;
  };
  const int = (key: string, fallback: number): number => {
    const value = cfg.get<number>(key);
    return typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
  };
  return {
    changeSeeds: bool("changeSeeds", true),
    changeSeedsMaxPaths: int("changeSeedsMaxPaths", 20),
    seedEditors: bool("seedEditors", false),
    seedDiagnostics: bool("seedDiagnostics", false),
    seedStackTraces: bool("seedStackTraces", false),
  };
}

export function statusBarEnabled(): boolean {
  return vscode.workspace.getConfiguration("offlineCodeContext").get<boolean>("statusBar") ?? true;
}
