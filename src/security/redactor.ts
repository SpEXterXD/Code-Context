import { shortHash } from "../shared/ids";
import type { SecretFinding } from "./secretScanner";

/**
 * Deterministic redaction: the secret's raw value is replaced with a stable
 * token that includes a short SHA-256 prefix of the value, never the value
 * itself, never a reversible encoding. Same input ⇒ same replacement.
 */
export function redactMatch(
  finding: SecretFinding,
  rawText: string,
): { text: string; replaced: number } {
  const escaped = escapeRegex(finding.match);
  const re = new RegExp(escaped, "g");
  const replacement = `[REDACTED:${finding.kind}:${shortHash(finding.match, 8)}]`;
  let replaced = 0;
  const text = rawText.replace(re, () => {
    replaced++;
    return replacement;
  });
  return { text, replaced };
}

/** Defense in depth: verifies no known secret value survives in output. */
export function assertSecretsAbsent(findings: SecretFinding[], output: string): string[] {
  const leaks: string[] = [];
  for (const finding of findings) {
    if (finding.match.length >= 8 && output.includes(finding.match)) {
      leaks.push(`${finding.kind} at ${finding.filePath}:${finding.line}`);
    }
  }
  return leaks;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
