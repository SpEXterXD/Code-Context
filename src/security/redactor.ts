import { shortHash } from "../shared/ids";
import type { SecretFinding } from "./secretScanner";

/**
 * Deterministic redaction: the secret's raw value is replaced with a stable
 * token that includes a short SHA-256 prefix of the value, never the value
 * itself, never a reversible encoding. Same input ⇒ same replacement.
 */
export function redactionPlaceholder(kind: string, value: string): string {
  return `[REDACTED:${kind}:${shortHash(value, 8)}]`;
}

export function redactMatch(
  finding: SecretFinding,
  rawText: string,
): { text: string; replaced: number } {
  const escaped = escapeRegex(finding.match);
  const re = new RegExp(escaped, "g");
  const replacement = redactionPlaceholder(finding.kind, finding.match);
  let replaced = 0;
  const text = rawText.replace(re, () => {
    replaced++;
    return replacement;
  });
  return { text, replaced };
}

/**
 * Stage 2 correction A: redacts the UNION of overlapping flagged spans
 * against the ORIGINAL text in ONE pass. Sequential whole-match replacement
 * is unsafe: an earlier placeholder removes newlines (shifting every later
 * line) and can consume a substring a later finding's match needs, silently
 * skipping that redaction. Here:
 * - overlapping/adjacent spans merge into one region (label = the kind of
 *   the region's first span; deterministic);
 * - the exact separator bytes (\r\n / \n) inside each region are preserved,
 *   so unaffected lines keep their original numbering and the redacted
 *   derivative has the same line structure as the snapshot it came from;
 * - every detected finding's material is inside some merged region, so the
 *   redaction report stays truthful.
 */
export function redactSpans(
  content: string,
  spans: Array<{ start: number; end: number; kind: string; match: string }>,
): { text: string; merged: number } {
  const sorted = [...spans]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Array<{ start: number; end: number; kind: string; match: string }> = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
      last.match = content.slice(last.start, last.end);
    } else {
      merged.push({ ...span });
    }
  }
  let out = "";
  let last = 0;
  for (const region of merged) {
    out += content.slice(last, region.start);
    out += redactionPlaceholder(region.kind, region.match);
    // Preserve the region's original separators so line numbering is stable.
    const separators = content.slice(region.start, region.end).match(/\r?\n/g) ?? [];
    out += separators.join("");
    last = region.end;
  }
  out += content.slice(last);
  return { text: out, merged: merged.length };
}

/** Defense in depth: verifies no known secret value survives in output. */
export function assertSecretsAbsent(findings: SecretFinding[], output: string): string[] {
  const leaks: string[] = [];
  for (const finding of findings) {
    // High-confidence kinds are gated regardless of match length — the kind
    // patterns already keep false positives out, so short matches get no
    // length-based exemption. Medium-confidence (entropy-heuristic) matches
    // keep a length floor: short strings are too weak a leak indicator
    // against arbitrary payload text.
    const longEnough = finding.confidence === "high" || finding.match.length >= 8;
    if (longEnough && output.includes(finding.match)) {
      leaks.push(`${finding.kind} at ${finding.filePath}:${finding.line}`);
    }
  }
  return leaks;
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
