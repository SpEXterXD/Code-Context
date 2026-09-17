import { OccError } from "../shared/errors";

/**
 * Hard context budget. Every limit is enforced, never silently exceeded.
 * `maxTokens` is checked against the ~chars/4 estimate (documented as an
 * estimate, so the raw character budget is the primary bound).
 */
export interface ContextBudgetConfig {
  maxFiles: number;
  maxChars: number;
  maxLines: number;
  maxTokens: number;
  maxGraphDepth: number;
  maxCodeLinesPerFile: number;
  structureDepth: number;
}

export const DEFAULT_BUDGET: ContextBudgetConfig = {
  maxFiles: 40,
  maxChars: 120_000,
  maxLines: 3000,
  maxTokens: 30_000,
  maxGraphDepth: 3,
  maxCodeLinesPerFile: 400,
  structureDepth: 4,
};

export function validateBudget(config: ContextBudgetConfig): void {
  const checks: Array<[boolean, string]> = [
    [config.maxFiles >= 1, "maxFiles must be >= 1"],
    [config.maxChars >= 1000, "maxChars must be >= 1000"],
    [config.maxLines >= 10, "maxLines must be >= 10"],
    [config.maxTokens >= 100, "maxTokens must be >= 100"],
    [config.maxGraphDepth >= 1, "maxGraphDepth must be >= 1"],
    [config.maxCodeLinesPerFile >= 10, "maxCodeLinesPerFile must be >= 10"],
    [config.structureDepth >= 1, "structureDepth must be >= 1"],
  ];
  for (const [ok, message] of checks) {
    if (!ok) throw new OccError("BUDGET_INVALID", message);
  }
}

/** Mutable accounting state while assembling a context package. */
export class BudgetLedger {
  files = 0;
  chars = 0;
  lines = 0;

  constructor(public readonly config: ContextBudgetConfig) {
    validateBudget(config);
  }

  get estimatedTokens(): number {
    return Math.ceil(this.chars / 4);
  }

  canAdd(chars: number, lines: number): boolean {
    return (
      this.chars + chars <= this.config.maxChars &&
      this.lines + lines <= this.config.maxLines &&
      this.estimatedTokens + Math.ceil(chars / 4) <= this.config.maxTokens
    );
  }

  add(chars: number, lines: number): void {
    this.chars += chars;
    this.lines += lines;
  }

  addFile(): void {
    this.files += 1;
  }

  get fileBudgetAvailable(): boolean {
    return this.files < this.config.maxFiles;
  }
}
