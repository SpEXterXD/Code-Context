import type { FileEntry } from "../domain/model";
import { SecretScanner, type SecretFinding } from "./secretScanner";
import { sensitivePathCheck } from "./sensitivePathRules";
import { redactMatch, assertSecretsAbsent } from "./redactor";
import { compareStrings } from "../shared/text";
import { logger } from "../shared/logging";
import { OccError } from "../shared/errors";

export type SecretPolicy = "block" | "warn" | "allow";

export interface SecurityConfig {
  secretPolicy: SecretPolicy;
  redactSecrets: boolean;
}

export interface SecurityVerdict {
  /** Files whose source must NOT be emitted, with reasons. */
  blockedFiles: Map<string, string[]>;
  /** Files included but carrying warnings. */
  warnedFiles: Map<string, string[]>;
  /** Content overrides (redacted source) for warned files. */
  redactedContent: Map<string, string>;
  /** All findings, values stripped (safe to display/log). */
  safeFindings: Array<{
    kind: string;
    filePath: string;
    line: number;
    description: string;
    confidence: string;
    action: "blocked" | "warned" | "redacted";
  }>;
  /** Raw findings, retained ONLY for the final payload leak verification. */
  rawFindings: SecretFinding[];
}

const scanner = new SecretScanner();

/**
 * Applies the security pipeline to the files selected for a context package:
 * sensitive-path check → secret scan → policy enforcement (BLOCK/WARN/ALLOW)
 * → optional deterministic redaction → output verification.
 *
 * Finding values never leave this module except inside the returned redacted
 * content; `safeFindings` carries descriptions only.
 */
export function applySecurityPolicy(
  selected: Array<{ path: string; entry: FileEntry; content: string }>,
  config: SecurityConfig,
): SecurityVerdict {
  const blockedFiles = new Map<string, string[]>();
  const warnedFiles = new Map<string, string[]>();
  const redactedContent = new Map<string, string>();
  const safeFindings: SecurityVerdict["safeFindings"] = [];
  const rawFindings: SecretFinding[] = [];

  for (const { path, content } of selected) {
    const pathFinding = sensitivePathCheck(path);
    if (pathFinding) {
      push(blockedFiles, path, `sensitive path: ${pathFinding.reason}`);
      safeFindings.push({
        kind: "sensitive-path",
        filePath: path,
        line: 0,
        description: pathFinding.reason,
        confidence: "high",
        action: "blocked",
      });
      continue;
    }

    const findings: SecretFinding[] = scanner.scan(path, content);
    if (findings.length === 0) continue;
    rawFindings.push(...findings);

    for (const finding of findings) {
      logger.debug(`security finding ${finding.kind} at ${finding.filePath}:${finding.line}`);
    }

    if (config.secretPolicy === "block") {
      for (const finding of findings) {
        push(blockedFiles, path, `${finding.description} (${finding.kind})`);
        safeFindings.push({
          kind: finding.kind,
          filePath: path,
          line: finding.line,
          description: finding.description,
          confidence: finding.confidence,
          action: "blocked",
        });
      }
      continue;
    }

    if (config.secretPolicy === "warn") {
      if (config.redactSecrets) {
        let redacted = content;
        let redactions = 0;
        for (const finding of findings) {
          const result = redactMatch(finding, redacted);
          redacted = result.text;
          redactions += result.replaced;
          safeFindings.push({
            kind: finding.kind,
            filePath: path,
            line: finding.line,
            description: finding.description,
            confidence: finding.confidence,
            action: "redacted",
          });
        }
        if (redactions > 0) redactedContent.set(path, redacted);
        push(warnedFiles, path, `${findings.length} potential secret(s) redacted`);
      } else {
        for (const finding of findings) {
          push(warnedFiles, path, `${finding.description} (${finding.kind})`);
          safeFindings.push({
            kind: finding.kind,
            filePath: path,
            line: finding.line,
            description: finding.description,
            confidence: finding.confidence,
            action: "warned",
          });
        }
      }
    }
    // policy "allow": findings are ignored entirely.
  }

  return { blockedFiles, warnedFiles, redactedContent, safeFindings, rawFindings };
}

/**
 * Final gate before clipboard export. Throws an OccError with code
 * `SECURITY_BLOCKED` (message prefixed `SECURITY:` for UI branching) when
 * any known secret value survived into the payload. Fail-closed by design.
 */
export function verifyNoSecretLeaks(rawFindings: SecretFinding[], payload: string): void {
  const leaks = assertSecretsAbsent(rawFindings, payload);
  if (leaks.length > 0) {
    logger.error(`secret leak detected in generated payload: ${leaks.join("; ")}`);
    throw new OccError(
      "SECURITY_BLOCKED",
      `SECURITY: generated context contains unredacted secret material (${leaks.length} finding(s)). Copy aborted.`,
    );
  }
}

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key) ?? [];
  list.push(value);
  map.set(key, list);
}

export function sortSafeFindings(
  findings: SecurityVerdict["safeFindings"],
): SecurityVerdict["safeFindings"] {
  return findings.sort(
    (a, b) =>
      compareStrings(a.filePath, b.filePath) || a.line - b.line || compareStrings(a.kind, b.kind),
  );
}
