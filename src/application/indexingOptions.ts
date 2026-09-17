/** Options shared by indexing components (scanner, service, store). */
export interface IndexingOptions {
  excludePatterns?: string[];
  respectGitignore?: boolean;
  maxFileSizeBytes?: number;
}
