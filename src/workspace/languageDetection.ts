import { extName } from "../shared/ids";
import type { Language } from "../domain/model";

const EXTENSION_MAP: Record<string, Language> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".markdown": "markdown",
};

/** Binary-content sniffing: NUL byte in the first 8KB indicates binary. */
export function looksBinary(content: string): boolean {
  const probe = content.slice(0, 8192);
  if (probe.includes("\u0000")) return true;
  // High ratio of non-printable characters also indicates binary content.
  let nonPrintable = 0;
  const sample = probe.slice(0, 1024);
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c < 9 || (c > 13 && c < 32)) nonPrintable++;
  }
  return sample.length > 0 && nonPrintable / sample.length > 0.1;
}

export function detectLanguage(path: string): Language {
  return EXTENSION_MAP[extName(path)] ?? "generic";
}

export function isTestFile(path: string): boolean {
  const lower = path.toLowerCase();
  const base = lower.slice(lower.lastIndexOf("/") + 1);
  return (
    /\.(test|spec)\.[a-z]+$/.test(base) ||
    /\.test\.[jt]sx?$/.test(base) ||
    /\.spec\.[jt]sx?$/.test(base) ||
    lower.includes("/__tests__/") ||
    lower.endsWith(".test.ts") ||
    lower.includes(".test.") ||
    base.startsWith("test-")
  );
}

/** Inverse of {@link isTestFile} used for the `tests` relationship heuristic. */
export function sourceFileOfTestFile(testPath: string): string | null {
  const ext = extName(testPath);
  const stripped = testPath.replace(/(\.test|\.spec)(?=\.[^.]+$)/, "");
  if (stripped !== testPath) return stripped;
  // foo.test.ts handled above; also support foo_test.ts style
  const base = testPath.slice(0, testPath.length - ext.length);
  if (base.endsWith("_test")) return base.slice(0, -"_test".length) + ext;
  if (base.endsWith(".test")) return base.slice(0, -".test".length) + ext;
  return null;
}
